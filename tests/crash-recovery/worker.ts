/**
 * Absurd CRASH-RECOVERY worker.
 *
 * Registers ONE durable task, `resilient-job`, engineered to PROVE absurd's
 * headline durability guarantee: a task survives a real WORKER CRASH and
 * resumes from its last checkpoint WITHOUT re-running already-completed steps.
 *
 * How the proof is made countable + deterministic:
 *
 *   1. step "side-effect": appends ONE unique line to a marker file on disk and
 *      returns a value. The number of lines in that file == the number of times
 *      the step FUNCTION BODY actually executed. Absurd caches a completed step
 *      as a checkpoint keyed by (task_id, checkpoint_name); on a later attempt
 *      `ctx.step` returns the cached value WITHOUT invoking the body. So if
 *      replay works, the marker file has EXACTLY ONE line even though the task
 *      ran across two worker processes.
 *
 *   2. After the step commits, on the FIRST attempt only, the worker performs a
 *      REAL crash: `process.exit(1)`. We detect "first attempt" with a one-shot
 *      sentinel file (not the attempt counter, which the SDK ctx does not
 *      expose) so the logic is robust no matter which run number we are on:
 *      if the sentinel is absent we create it, log CRASH, and kill the process;
 *      if it is present we are the post-crash recovery run and we skip the crash.
 *
 *   3. process.exit(1) kills the worker while it still holds the task's lease.
 *      The harness then starts a FRESH worker. Absurd reclaims a crashed task
 *      only AFTER the lease (claim_expires_at) expires: the next claim_task call
 *      sweeps the expired `running` run, fail_run's it (creating attempt 2), and
 *      the fresh worker claims attempt 2. We use a SHORT claimTimeout so this
 *      reclaim is fast (see CLAIM_TIMEOUT below).
 *
 *   4. The recovery run replays: step "side-effect" returns its cached value
 *      (NO new marker line), then a second step "finalize" runs and the task
 *      completes with a result payload.
 *
 * Vendored SDK + pg-shim mirror tests/integration (Node strips TS types natively).
 */
import { Absurd } from "./absurd-sdk.ts";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const DATABASE_URL =
  process.env.ABSURD_DATABASE_URL ??
  "postgresql://absurd:absurd@localhost:5432/absurd";
const QUEUE = process.env.ABSURD_QUEUE ?? "crashtest";

// Files passed in by the harness so each test run is isolated.
const MARKER_FILE = process.env.CRASH_MARKER_FILE!; // counted: 1 line == step ran once
const SENTINEL_FILE = process.env.CRASH_SENTINEL_FILE!; // one-shot "have crashed" flag
const WORKER_TAG = process.env.WORKER_TAG ?? "worker"; // distinguishes the 2 workers in logs

if (!MARKER_FILE || !SENTINEL_FILE) {
  console.error("CRASH_MARKER_FILE and CRASH_SENTINEL_FILE must be set");
  process.exit(2);
}

// SHORT lease so a crashed task is reclaimed quickly. This is the exact knob:
// startWorker({ claimTimeout }) -> claim_task(..., p_claim_timeout) sets
// r.claim_expires_at = now + claimTimeout. After it elapses, the next
// claim_task call sweeps the expired run and creates a new attempt.
const CLAIM_TIMEOUT = 3; // seconds

const app = new Absurd({ db: DATABASE_URL, queueName: QUEUE });

app.registerTask(
  { name: "resilient-job" },
  async (params: { name: string }, ctx) => {
    console.log(`[${WORKER_TAG}] pid=${process.pid} claimed task ${ctx.taskID}`);

    // === Step 1: the COUNTABLE side-effecting step ===
    // The body runs at most ONCE across all attempts if replay works.
    const sideEffect = await ctx.step("side-effect", async () => {
      const line = `side-effect ran: worker=${WORKER_TAG} pid=${process.pid} ts=${new Date().toISOString()}`;
      appendFileSync(MARKER_FILE, line + "\n");
      console.log(`[${WORKER_TAG}] pid=${process.pid} EXECUTED step side-effect -> appended marker line`);
      return { ok: true, processedBy: WORKER_TAG, pid: process.pid };
    });
    console.log(
      `[${WORKER_TAG}] pid=${process.pid} step side-effect returned ${JSON.stringify(sideEffect)} (cached on replay)`,
    );

    // === Inject a REAL crash, exactly once, AFTER the step is checkpointed ===
    if (!existsSync(SENTINEL_FILE)) {
      writeFileSync(SENTINEL_FILE, `crashed by ${WORKER_TAG} pid=${process.pid}\n`);
      console.log(
        `[${WORKER_TAG}] pid=${process.pid} CRASH: simulating worker death via process.exit(1) AFTER step checkpoint committed`,
      );
      // Hard process death while holding the lease. No graceful shutdown,
      // no fail_run -- exactly what a real crash looks like to absurd.
      process.exit(1);
    }

    // === We only reach here on the post-crash recovery run ===
    console.log(
      `[${WORKER_TAG}] pid=${process.pid} RESUMED after crash: replaying from checkpoint (step body NOT re-run)`,
    );

    const finalize = await ctx.step("finalize", async () => {
      console.log(`[${WORKER_TAG}] pid=${process.pid} EXECUTED step finalize`);
      return { finalizedBy: WORKER_TAG, pid: process.pid };
    });

    const result = {
      name: params.name,
      sideEffect,
      finalize,
      status: "completed" as const,
    };
    console.log(`[${WORKER_TAG}] pid=${process.pid} COMPLETED task ${ctx.taskID}: ${JSON.stringify(result)}`);
    return result;
  },
);

console.log(
  `worker listening tag=${WORKER_TAG} pid=${process.pid} queue="${QUEUE}" claimTimeout=${CLAIM_TIMEOUT}s db=${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`,
);

// concurrency 1, short poll so a fresh worker reclaims the expired lease fast.
await app.startWorker({
  workerId: `${WORKER_TAG}:${process.pid}`,
  claimTimeout: CLAIM_TIMEOUT,
  concurrency: 1,
  pollInterval: 0.25,
  // The crashing worker dies via process.exit anyway; on the recovery worker we
  // do not want a spurious fatal-on-lease-timeout. Recovery work is fast (<3s).
});
