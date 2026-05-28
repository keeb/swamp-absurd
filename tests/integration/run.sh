#!/usr/bin/env bash
#
# End-to-end integration harness: PROVES the swamp <-> absurd integration.
#
#   - ensures the Postgres deploy stack is up (deploy/up.sh)
#   - verifies the @keeb/absurd swamp extension is recognized
#   - installs worker deps (absurd-sdk + pg) if needed
#   - starts the absurd worker (worker.ts) in the background, logging to a file
#   - runs flow.ts, which drives the queue through the swamp extension and
#     asserts a durable task flows spawn -> step -> suspend -> emit -> resume
#     -> complete, plus listTasks + cancel coverage
#   - tears the worker down and prints PASS/FAIL
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"
DB_URL="${ABSURD_DATABASE_URL:-postgresql://absurd:absurd@localhost:5432/absurd}"
WORKER_LOG="$HERE/worker.log"
export ABSURD_DATABASE_URL="$DB_URL"
# swamp resolves its repo from cwd; pin it so commands work from this subdir.
export SWAMP_REPO_DIR="$REPO_ROOT"

WORKER_PID=""
cleanup() {
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[harness] stopping worker (pid $WORKER_PID)"
    kill "$WORKER_PID" 2>/dev/null
    wait "$WORKER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

fail() { echo "[harness] ERROR: $*" >&2; exit 1; }

echo "[harness] === dependency checks ==="
command -v swamp >/dev/null || fail "swamp CLI not found on PATH"
command -v node  >/dev/null || fail "node not found on PATH"
command -v docker >/dev/null || fail "docker not found on PATH"
echo "[harness] node $(node --version), swamp present"

echo "[harness] === ensure Postgres stack is up ==="
if ! docker exec absurd-postgres psql -U absurd -d absurd -c "select absurd.list_queues();" >/dev/null 2>&1; then
  echo "[harness] absurd-postgres not ready; bringing the deploy stack up"
  ( cd "$DEPLOY_DIR" && ./up.sh ) || fail "deploy/up.sh failed"
fi
QUEUES="$(docker exec absurd-postgres psql -U absurd -d absurd -tAc "select absurd.list_queues();" 2>/dev/null)"
echo "[harness] queues: $QUEUES"
echo "$QUEUES" | grep -q "default" || fail "queue 'default' missing in absurd schema"

echo "[harness] === verify swamp extension recognized ==="
swamp model type describe @keeb/absurd --json >/dev/null 2>&1 \
  || fail "swamp does not recognize @keeb/absurd extension"
echo "[harness] @keeb/absurd extension OK"

echo "[harness] === vendor absurd SDK source ==="
SDK_SRC="$REPO_ROOT/../absurd/sdks/typescript/src/index.ts"
if [[ -f "$SDK_SRC" ]]; then
  cp "$SDK_SRC" "$HERE/absurd-sdk.ts"
  # Redirect the SDK's bare `pg` import at our ESM-interop shim so `pg.Pool`
  # resolves under Node's native ESM (see pg-shim.ts for why).
  sed -i 's#import \* as pg from "pg";#import * as pg from "./pg-shim.ts";#' "$HERE/absurd-sdk.ts"
  echo "[harness] refreshed absurd-sdk.ts from $SDK_SRC (pg import shimmed)"
elif [[ -f "$HERE/absurd-sdk.ts" ]]; then
  echo "[harness] SDK source not found at $SDK_SRC; using existing vendored copy"
else
  fail "absurd SDK source not found and no vendored copy present"
fi

echo "[harness] === install worker deps (pg) ==="
if [[ ! -d "$HERE/node_modules/pg" ]]; then
  ( cd "$HERE" && npm install --no-audit --no-fund ) || fail "npm install failed"
else
  echo "[harness] deps already present"
fi

echo "[harness] === start absurd worker (background) ==="
: > "$WORKER_LOG"
# Launch node directly (not in a subshell) so $! is the real node PID and the
# EXIT trap can reliably kill it -- a subshell wrapper leaves the node child
# orphaned when only the subshell PID is signalled.
cd "$HERE"
ABSURD_DATABASE_URL="$DB_URL" node worker.ts >> "$WORKER_LOG" 2>&1 &
WORKER_PID=$!
cd "$REPO_ROOT"
echo "[harness] worker pid=$WORKER_PID, log=$WORKER_LOG"

# Wait for the worker to announce it is listening (or die).
for _ in $(seq 1 40); do
  if grep -q "worker listening" "$WORKER_LOG" 2>/dev/null; then break; fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[harness] worker exited early; log:"; cat "$WORKER_LOG"; fail "worker failed to start"
  fi
  sleep 0.5
done
grep -q "worker listening" "$WORKER_LOG" || { cat "$WORKER_LOG"; fail "worker never reported listening"; }
echo "[harness] worker is listening"

echo "[harness] === run integration flow (driving queue via swamp) ==="
( cd "$HERE" && ABSURD_DATABASE_URL="$DB_URL" node flow.ts )
FLOW_RC=$?

echo "[harness] === worker log tail ==="
tail -n 30 "$WORKER_LOG"

if [[ $FLOW_RC -eq 0 ]]; then
  echo "[harness] OVERALL: PASS"
else
  echo "[harness] OVERALL: FAIL (flow rc=$FLOW_RC)"
fi
exit $FLOW_RC
