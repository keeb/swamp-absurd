#!/usr/bin/env bash
#
# End-to-end harness: PROVES swamp can ORCHESTRATE a durable absurd task through
# a swamp WORKFLOW (a DAG) using CEL data-chaining between steps.
#
#   - ensures the Postgres deploy stack is up
#   - creates the `wftest` queue (idempotent)
#   - verifies the @keeb/absurd extension exposes `awaitResult`
#   - vendors the absurd SDK + installs the worker's pg dep
#   - starts the absurd worker (worker.ts) on queue `wftest` in the background
#   - validates + RUNS the `absurd-orchestrate` swamp workflow (spawn -> emit
#     -> collect), which chains the spawned taskId into the collect step via a
#     CEL `data.findBySpec(...)` expression
#   - asserts the run SUCCEEDED and the COLLECT artifact shows state=completed
#     with the durable result (greeting + emitted approval)
#   - tears the worker down and prints PASS/FAIL
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"
DB_URL="${ABSURD_DATABASE_URL:-postgresql://absurd:absurd@localhost:5432/absurd}"
QUEUE="wftest"
WORKFLOW="absurd-orchestrate"
NAME="worldwf"
APPROVER="keeb"
WORKER_LOG="$HERE/worker.log"
export ABSURD_DATABASE_URL="$DB_URL"
export ABSURD_QUEUE="$QUEUE"
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
command -v swamp  >/dev/null || fail "swamp CLI not found on PATH"
command -v node   >/dev/null || fail "node not found on PATH"
command -v docker >/dev/null || fail "docker not found on PATH"
command -v python3 >/dev/null || fail "python3 not found on PATH"
echo "[harness] node $(node --version), swamp present"

echo "[harness] === ensure Postgres stack is up ==="
if ! docker exec absurd-postgres psql -U absurd -d absurd -c "select absurd.list_queues();" >/dev/null 2>&1; then
  echo "[harness] absurd-postgres not ready; bringing the deploy stack up"
  ( cd "$DEPLOY_DIR" && ./up.sh ) || fail "deploy/up.sh failed"
fi

echo "[harness] === ensure queue '$QUEUE' exists ==="
docker exec absurd-postgres psql -U absurd -d absurd -c "select absurd.create_queue('$QUEUE');" >/dev/null 2>&1
docker exec absurd-postgres psql -U absurd -d absurd -tAc "select absurd.list_queues();" | grep -q "$QUEUE" \
  || fail "queue '$QUEUE' missing after create"
echo "[harness] queue '$QUEUE' present"

echo "[harness] === verify @keeb/absurd exposes awaitResult ==="
swamp model type describe @keeb/absurd --json 2>/dev/null \
  | python3 -c "import sys,json; ms=[m['name'] for m in json.load(sys.stdin)['methods']]; sys.exit(0 if 'awaitResult' in ms else 1)" \
  || fail "@keeb/absurd does not expose awaitResult"
echo "[harness] awaitResult method present"

echo "[harness] === vendor absurd SDK source ==="
SDK_SRC="$REPO_ROOT/../absurd/sdks/typescript/src/index.ts"
if [[ -f "$SDK_SRC" ]]; then
  cp "$SDK_SRC" "$HERE/absurd-sdk.ts"
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
cd "$HERE"
ABSURD_DATABASE_URL="$DB_URL" ABSURD_QUEUE="$QUEUE" node worker.ts >> "$WORKER_LOG" 2>&1 &
WORKER_PID=$!
cd "$REPO_ROOT"
echo "[harness] worker pid=$WORKER_PID, log=$WORKER_LOG"

for _ in $(seq 1 40); do
  if grep -q "worker listening" "$WORKER_LOG" 2>/dev/null; then break; fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[harness] worker exited early; log:"; cat "$WORKER_LOG"; fail "worker failed to start"
  fi
  sleep 0.5
done
grep -q "worker listening" "$WORKER_LOG" || { cat "$WORKER_LOG"; fail "worker never reported listening"; }
echo "[harness] worker is listening on queue '$QUEUE'"

# swamp prefixes some --json output with NDJSON status lines (e.g.
# auto_resolve events); parse only the final balanced JSON object.
last_json() {
  python3 -c "
import sys,json
buf=sys.stdin.read()
# Find the last top-level JSON object by scanning from the last line that
# starts a multi-line object ('{' alone) or a single-line object.
dec=json.JSONDecoder()
objs=[]
i=0
while i < len(buf):
    c=buf[i]
    if c=='{':
        try:
            o,end=dec.raw_decode(buf,i)
            objs.append(o); i=end; continue
        except ValueError:
            pass
    i+=1
print(json.dumps(objs[-1]) if objs else '{}')
"
}

echo "[harness] === validate workflow ==="
swamp workflow validate "$WORKFLOW" --json | last_json \
  | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('passed') else 1)" \
  || fail "workflow validation failed"
echo "[harness] workflow valid"

echo "[harness] === run workflow (spawn -> emit -> collect) ==="
RUN_JSON="$(swamp workflow run "$WORKFLOW" --input "name=$NAME" --input "approver=$APPROVER" --json 2>/dev/null | last_json)"
RUN_STATUS="$(echo "$RUN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null)"
RUN_ID="$(echo "$RUN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)"
echo "[harness] run id=$RUN_ID status=$RUN_STATUS"

echo "[harness] === assert COLLECT artifact: completed + durable result ==="
# Find the collect step's task artifact NAME for this run, then read its full
# content via `data get` and verify the durable result combines the
# checkpointed greeting with the emitted approval.
PREDICATE="tags.workflowRunId == \"$RUN_ID\" && tags.step == \"collect\" && specName == \"task\""
ARTIFACT_NAME="$(swamp data query "$PREDICATE" --json 2>/dev/null | python3 "$HERE/first_name.py")"
[[ -n "$ARTIFACT_NAME" ]] || fail "no collect task artifact found for run $RUN_ID"
echo "[harness] collect artifact: $ARTIFACT_NAME"

ASSERT="$(swamp data get --workflow "$WORKFLOW" "$ARTIFACT_NAME" --json 2>/dev/null \
  | python3 "$HERE/assert_collect.py" "$NAME" "$APPROVER" 2>&1)"
ASSERT_RC=$?

echo "[harness] === worker log tail ==="
tail -n 12 "$WORKER_LOG"

echo "[harness] === assertion result ==="
echo "$ASSERT"

if [[ "$RUN_STATUS" == "succeeded" && $ASSERT_RC -eq 0 ]]; then
  echo "[harness] OVERALL: PASS"
  exit 0
else
  echo "[harness] OVERALL: FAIL (status=$RUN_STATUS assert_rc=$ASSERT_RC)"
  exit 1
fi
