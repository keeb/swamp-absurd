#!/usr/bin/env bash
#
# CRASH-RECOVERY harness: PROVES absurd's headline durability promise --
# a task survives a REAL worker crash (process.exit while holding the lease)
# and resumes from its last checkpoint WITHOUT re-running completed steps
# (exactly-once step execution / replay from checkpoint).
#
# Flow:
#   1. ensure Postgres up + @keeb/absurd extension recognized
#   2. create the `crashtest` queue (idempotent)
#   3. vendor the absurd SDK source + apply the pg-shim (like tests/integration)
#   4. install deps in THIS subdir (own package.json / node_modules)
#   5. create a swamp model bound to queue=crashtest and SPAWN resilient-job
#      through the @keeb/absurd extension with maxAttempts=2
#   6. start worker #1 -> it runs the side-effect step, checkpoints it, then
#      CRASHES via process.exit(1) while holding the lease
#   7. start worker #2 (fresh process) -> after the short lease expires, absurd
#      reclaims the task as attempt 2; the step REPLAYS from checkpoint (no new
#      marker line) and the task completes
#   8. poll task status via the swamp extension until completed
#   9. ASSERT: marker file has exactly 1 line; result payload correct; attempts>=2
#
# Uses queue `crashtest` exclusively. Leaves Postgres running. No orphan workers.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
DB_URL="${ABSURD_DATABASE_URL:-postgresql://absurd:absurd@localhost:5432/absurd}"
QUEUE="crashtest"
MODEL="absurd-crashtest"
TYPE="@keeb/absurd"

export ABSURD_DATABASE_URL="$DB_URL"
export ABSURD_QUEUE="$QUEUE"
export SWAMP_REPO_DIR="$REPO_ROOT"

# Per-run isolated evidence files.
RUN_ID="$(date +%s)-$$"
MARKER_FILE="$HERE/marker-$RUN_ID.txt"
SENTINEL_FILE="$HERE/sentinel-$RUN_ID.flag"
W1_LOG="$HERE/worker1-$RUN_ID.log"
W2_LOG="$HERE/worker2-$RUN_ID.log"
export CRASH_MARKER_FILE="$MARKER_FILE"
export CRASH_SENTINEL_FILE="$SENTINEL_FILE"

W1_PID=""
W2_PID=""
cleanup() {
  for pid in "$W1_PID" "$W2_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[harness] stopping worker pid $pid"
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
    fi
  done
}
trap cleanup EXIT

fail() { echo "[harness] ERROR: $*" >&2; exit 1; }

# Retry a swamp CLI invocation up to 5 times to ride out lock/timeout contention
# from the parallel agent. Echoes stdout of the successful call.
swamp_retry() {
  local out rc
  for attempt in 1 2 3 4 5; do
    out="$("$@" 2>/tmp/swamp_err_$$)"
    rc=$?
    if [[ $rc -eq 0 ]]; then echo "$out"; rm -f /tmp/swamp_err_$$; return 0; fi
    if grep -qiE "lock|timeout|busy|EBUSY" /tmp/swamp_err_$$ 2>/dev/null; then
      echo "[harness] swamp call hit lock/timeout (attempt $attempt); retrying..." >&2
      sleep 2; continue
    fi
    cat /tmp/swamp_err_$$ >&2; rm -f /tmp/swamp_err_$$; return $rc
  done
  cat /tmp/swamp_err_$$ >&2; rm -f /tmp/swamp_err_$$; return 1
}

psql_q() { docker exec absurd-postgres psql -U absurd -d absurd -tAc "$1"; }

echo "[harness] === dependency checks ==="
command -v swamp >/dev/null || fail "swamp CLI not found"
command -v node  >/dev/null || fail "node not found"
command -v docker >/dev/null || fail "docker not found"
echo "[harness] node $(node --version), swamp present"

echo "[harness] === ensure Postgres + crashtest queue ==="
docker exec absurd-postgres psql -U absurd -d absurd -c "select absurd.list_queues();" >/dev/null 2>&1 \
  || fail "absurd-postgres not reachable"
# Create queue; ignore 'already exists'.
CQ_ERR="$(docker exec absurd-postgres psql -U absurd -d absurd -c "select absurd.create_queue('$QUEUE');" 2>&1)" || true
if echo "$CQ_ERR" | grep -qiE "already exists|duplicate"; then
  echo "[harness] queue '$QUEUE' already exists (ok)"
fi
psql_q "select absurd.list_queues();" | grep -qx "$QUEUE" || fail "queue '$QUEUE' missing"
echo "[harness] queue '$QUEUE' present"

echo "[harness] === verify swamp extension recognized ==="
swamp_retry swamp model type describe "$TYPE" --json >/dev/null \
  || fail "swamp does not recognize $TYPE extension"
echo "[harness] $TYPE extension OK"

echo "[harness] === vendor absurd SDK source + shim pg ==="
SDK_SRC="$REPO_ROOT/../absurd/sdks/typescript/src/index.ts"
if [[ -f "$SDK_SRC" ]]; then
  cp "$SDK_SRC" "$HERE/absurd-sdk.ts"
  sed -i 's#import \* as pg from "pg";#import * as pg from "./pg-shim.ts";#' "$HERE/absurd-sdk.ts"
  echo "[harness] vendored absurd-sdk.ts (pg import shimmed)"
elif [[ -f "$HERE/absurd-sdk.ts" ]]; then
  echo "[harness] using existing vendored absurd-sdk.ts"
else
  fail "absurd SDK source not found and no vendored copy"
fi

echo "[harness] === install deps in this subdir ==="
if [[ ! -d "$HERE/node_modules/pg" ]]; then
  ( cd "$HERE" && npm install --no-audit --no-fund ) || fail "npm install failed"
else
  echo "[harness] deps already present"
fi

echo "[harness] === bind swamp model to queue=$QUEUE ==="
# Create the model definition with the queue global-arg so the extension's
# spawn/status/result all target crashtest. Idempotent: ignore 'already exists'.
swamp model create "$TYPE" "$MODEL" --global-arg "queue=$QUEUE" >/dev/null 2>&1 \
  && echo "[harness] created model $MODEL (queue=$QUEUE)" \
  || echo "[harness] model $MODEL already exists (ok)"

run_method() { # run_method <method> <json-input>  -> prints the JSON document
  local method="$1" input="$2" out
  out="$(swamp_retry swamp model "$TYPE" method run "$method" "$MODEL" --input "$input" --json)" || return 1
  echo "$out" | sed -n '/{/,$p'
}

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s.slice(s.indexOf("{"),s.lastIndexOf("}")+1));const a=(o.dataArtifacts||[])[0]||{};const at=a.attributes||{};const p=process.argv[1].split(".");let v=at;for(const k of p){v=v==null?undefined:v[k];}console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):v));})' "$1"; }

echo "[harness] === spawn resilient-job via swamp extension (maxAttempts=2) ==="
SPAWN_JSON="$(run_method spawn '{"taskName":"resilient-job","params":{"name":"crash-proof"},"maxAttempts":2}')" \
  || fail "spawn method failed"
TASK_ID="$(echo "$SPAWN_JSON" | jget taskId)"
CREATED="$(echo "$SPAWN_JSON" | jget created)"
[[ -n "$TASK_ID" ]] || { echo "$SPAWN_JSON"; fail "spawn returned no taskId"; }
echo "[harness] spawned task_id=$TASK_ID created=$CREATED"

start_worker() { # start_worker <tag> <logfile> -> sets WORKER_STARTED_PID
  local tag="$1" log="$2"
  : > "$log"
  # Launch node DIRECTLY (no subshell) so $! is the real node PID and cleanup
  # can reliably kill it -- a `( ... ) &` wrapper makes $! the subshell PID and
  # orphans the node child when only the subshell is signalled. The worker
  # imports relative to its own file (absurd-sdk.ts) and resolves node_modules
  # by walking up from its directory, so an absolute path works without `cd`.
  WORKER_TAG="$tag" node "$HERE/worker.ts" >> "$log" 2>&1 &
  WORKER_STARTED_PID=$!
  for _ in $(seq 1 40); do
    grep -q "worker listening" "$log" 2>/dev/null && return 0
    kill -0 "$WORKER_STARTED_PID" 2>/dev/null || { echo "[harness] $tag exited early:"; cat "$log"; return 1; }
    sleep 0.25
  done
  echo "[harness] $tag never reported listening"; cat "$log"; return 1
}

echo "[harness] === start worker #1 (will crash) ==="
start_worker "w1" "$W1_LOG" || fail "worker #1 failed to start"
W1_PID=$WORKER_STARTED_PID
echo "[harness] worker #1 pid=$W1_PID"

echo "[harness] === wait for worker #1 to crash (process.exit after step) ==="
CRASHED=0
for _ in $(seq 1 60); do
  if [[ -f "$SENTINEL_FILE" ]] && ! kill -0 "$W1_PID" 2>/dev/null; then CRASHED=1; break; fi
  sleep 0.5
done
if [[ "$CRASHED" -ne 1 ]]; then
  echo "[harness] worker #1 did not crash as expected; log:"; cat "$W1_LOG"
  fail "worker #1 crash not observed"
fi
wait "$W1_PID" 2>/dev/null; W1_RC=$?
echo "[harness] worker #1 crashed (exit code $W1_RC), sentinel present"
W1_PID=""

echo "[harness] === start worker #2 (fresh process; reclaims after lease expiry) ==="
start_worker "w2" "$W2_LOG" || fail "worker #2 failed to start"
W2_PID=$WORKER_STARTED_PID
echo "[harness] worker #2 pid=$W2_PID"

echo "[harness] === poll status via swamp extension until completed ==="
STATE=""
DEADLINE=$(( $(date +%s) + 90 ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  ST_JSON="$(run_method status "{\"taskId\":\"$TASK_ID\"}")" || { sleep 1; continue; }
  STATE="$(echo "$ST_JSON" | jget state)"
  echo "[harness] task state=$STATE"
  [[ "$STATE" == "completed" || "$STATE" == "failed" || "$STATE" == "cancelled" ]] && break
  sleep 1.5
done

echo "[harness] === fetch result via swamp extension ==="
RES_JSON="$(run_method result "{\"taskId\":\"$TASK_ID\"}")" || RES_JSON=""
RESULT="$(echo "$RES_JSON" | jget result)"

# Attempt evidence straight from the absurd run table.
ATTEMPTS="$(psql_q "select attempts from absurd.t_${QUEUE} where task_id='$TASK_ID';" | tr -d '[:space:]')"
RUN_COUNT="$(psql_q "select count(*) from absurd.r_${QUEUE} where task_id='$TASK_ID';" | tr -d '[:space:]')"
MARKER_LINES=$(grep -c . "$MARKER_FILE" 2>/dev/null || echo 0)

echo
echo "================ EVIDENCE ================"
echo "marker file: $MARKER_FILE"
echo "  contents:"
sed 's/^/    /' "$MARKER_FILE" 2>/dev/null || echo "    <none>"
echo "  line count: $MARKER_LINES"
echo "task state (via swamp status): $STATE"
echo "result payload (via swamp result): $RESULT"
echo "task.attempts (absurd.t_$QUEUE): $ATTEMPTS"
echo "run rows (absurd.r_$QUEUE): $RUN_COUNT"
echo "worker #1 crash line:"
grep -h "CRASH" "$W1_LOG" | sed 's/^/    /' || true
echo "worker #2 resume line:"
grep -h "RESUMED" "$W2_LOG" | sed 's/^/    /' || true
echo "=========================================="
echo

# ----- ASSERTIONS -----
PASS=0; FAILED=0
assert() { if [[ "$1" == "1" ]]; then echo "  PASS  $2"; PASS=$((PASS+1)); else echo "  FAIL  $2"; FAILED=$((FAILED+1)); fi; }

echo "[harness] === ASSERTIONS ==="
# A: the side-effecting step executed EXACTLY ONCE despite crash + retry.
assert "$([[ "$MARKER_LINES" -eq 1 ]] && echo 1 || echo 0)" \
  "side-effect step ran EXACTLY ONCE (marker has 1 line; got $MARKER_LINES) -> checkpoint replayed, completed step not re-run"
# B: task reached completed with the expected payload.
assert "$([[ "$STATE" == "completed" ]] && echo 1 || echo 0)" \
  "task reached state=completed (got '$STATE')"
RES_NAME="$(echo "$RES_JSON" | jget result.name)"
RES_STATUS="$(echo "$RES_JSON" | jget result.status)"
RES_SE_OK="$(echo "$RES_JSON" | jget result.sideEffect.ok)"
RES_FINAL="$(echo "$RES_JSON" | jget result.finalize.finalizedBy)"
assert "$([[ "$RES_NAME" == "crash-proof" && "$RES_STATUS" == "completed" && "$RES_SE_OK" == "true" ]] && echo 1 || echo 0)" \
  "result payload correct (name=$RES_NAME status=$RES_STATUS sideEffect.ok=$RES_SE_OK)"
# C: a retry actually happened (attempt/run count >= 2) AND two distinct workers.
assert "$([[ "${ATTEMPTS:-0}" -ge 2 || "${RUN_COUNT:-0}" -ge 2 ]] && echo 1 || echo 0)" \
  "retry occurred: attempts=$ATTEMPTS run_rows=$RUN_COUNT (>=2)"
W1_CRASH=$(grep -c "CRASH" "$W1_LOG" 2>/dev/null || echo 0)
W2_RESUME=$(grep -c "RESUMED after crash" "$W2_LOG" 2>/dev/null || echo 0)
assert "$([[ "$W1_CRASH" -ge 1 && "$W2_RESUME" -ge 1 ]] && echo 1 || echo 0)" \
  "log evidence of crash-then-resume across two worker processes (w1 CRASH=$W1_CRASH, w2 RESUMED=$W2_RESUME)"
# D: finalize step ran (only reachable post-recovery) -> proves we resumed past the crash point.
assert "$([[ -n "$RES_FINAL" ]] && echo 1 || echo 0)" \
  "post-crash finalize step executed (finalizedBy=$RES_FINAL)"

echo
echo "[harness] stopping worker #2 (pid $W2_PID)"
kill "$W2_PID" 2>/dev/null; wait "$W2_PID" 2>/dev/null; W2_PID=""

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "[harness] OVERALL: PASS ($PASS assertions)"
  EXIT=0
else
  echo "[harness] OVERALL: FAIL ($FAILED of $((PASS+FAILED)) assertions failed)"
  EXIT=1
fi
exit $EXIT
