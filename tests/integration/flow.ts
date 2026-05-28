/**
 * Integration flow driver.
 *
 * Drives an Absurd task queue ENTIRELY through swamp's `@keeb/absurd` model
 * extension (spawn / status / emitEvent / result / listTasks / cancel) while a
 * separately-started worker (worker.ts) executes the `greet` task handler.
 *
 * It shells out to the `swamp` CLI, parsing `--json` output. The task snapshot
 * each method writes is returned inline at `dataArtifacts[].attributes`, so we
 * never need a second `swamp data get` round-trip.
 *
 * Exits 0 and prints PASS on success, non-zero + FAIL otherwise.
 */
import { spawnSync } from "node:child_process";

const MODEL = "absurd-itest"; // definition name the @type prefix auto-creates
const TYPE = "@keeb/absurd";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL  ${msg}`);
  }
}

/** Run `swamp <type> method run <method> <model> --input <json>` and parse. */
function runMethod(
  method: string,
  input: Record<string, unknown>,
): { status: string; attributes: Record<string, any> } {
  const args = [
    "model",
    TYPE,
    "method",
    "run",
    method,
    MODEL,
    "--input",
    JSON.stringify(input),
    "--json",
  ];
  const res = spawnSync("swamp", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(
      `swamp ${method} exited ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  // swamp may interleave a few log lines (e.g. lock acquisition) before the
  // JSON document on stdout, especially on the first call that auto-creates the
  // model definition. Slice from the first `{` to the last `}` to isolate it.
  const out = res.stdout;
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`swamp ${method}: no JSON in output:\n${out}`);
  }
  const parsed = JSON.parse(out.slice(start, end + 1));
  const artifacts = parsed.dataArtifacts ?? [];
  return {
    status: parsed.status,
    attributes: artifacts[0]?.attributes ?? {},
  };
}

/** Poll `status` until predicate is satisfied or we time out. */
async function pollStatus(
  taskId: string,
  pred: (state: string) => boolean,
  label: string,
  { timeoutMs = 60000, intervalMs = 1000 } = {},
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const { attributes } = runMethod("status", { taskId });
    last = attributes.state;
    if (pred(last)) return attributes;
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out (${timeoutMs}ms) waiting for ${label}; last state=${last}`,
  );
}

async function main() {
  const name = `e2e-${Date.now()}`;
  console.log(`\n=== absurd <-> swamp end-to-end flow (name=${name}) ===\n`);

  // 1) Spawn the greet task THROUGH the swamp extension. Object-typed params
  //    are passed as inline JSON via --input.
  console.log("[1] spawn greet via swamp extension");
  const spawned = runMethod("spawn", {
    taskName: "greet",
    params: { name },
    maxAttempts: 3,
  });
  const taskId = spawned.attributes.taskId as string;
  assert(spawned.status === "succeeded", "spawn method succeeded");
  assert(!!taskId, `spawn returned a taskId (${taskId})`);
  assert(
    spawned.attributes.created === true,
    "spawn reports created=true (new task)",
  );

  // 2) Poll status until the worker picks it up and suspends on the event
  //    (state=sleeping). Accept completed too in case of a race.
  console.log("\n[2] poll status until worker suspends on event (sleeping)");
  const sleeping = await pollStatus(
    taskId,
    (s) => s === "sleeping" || s === "completed",
    "task to reach sleeping",
    { timeoutMs: 45000, intervalMs: 1000 },
  );
  assert(
    sleeping.state === "sleeping" || sleeping.state === "completed",
    `task suspended on event (state=${sleeping.state})`,
  );

  // 3) Emit the awaited event THROUGH the swamp extension with a payload.
  console.log("\n[3] emit approve event via swamp extension");
  const eventName = `approve:${name}`;
  const approver = "swamp-harness";
  const note = "approved by integration test";
  const emit = runMethod("emitEvent", {
    eventName,
    payload: { approver, note },
  });
  assert(emit.status === "succeeded", `emitEvent ${eventName} succeeded`);

  // 4) Poll result until the task completes.
  console.log("\n[4] poll until completed");
  const completed = await pollStatus(
    taskId,
    (s) => s === "completed" || s === "failed" || s === "cancelled",
    "task to complete",
    { timeoutMs: 45000, intervalMs: 1000 },
  );
  assert(completed.state === "completed", `task completed (state=${completed.state})`);

  // 5) Fetch the result payload via the extension and ASSERT its shape.
  console.log("\n[5] fetch + assert result payload via swamp extension");
  const fetched = runMethod("result", { taskId });
  const result = fetched.attributes.result ?? {};
  console.log("    result payload:", JSON.stringify(result));
  assert(result.greeting === `hello ${name}`, "result.greeting matches step output");
  assert(result.approval?.approver === approver, "result.approval.approver matches emitted payload");
  assert(result.approval?.note === note, "result.approval.note matches emitted payload");
  assert(result.status === "completed", "result.status === completed");

  // 6) listTasks coverage.
  console.log("\n[6] listTasks coverage");
  const listed = runMethod("listTasks", { limit: 100 });
  const tasks = (listed.attributes.tasks ?? []) as any[];
  assert(listed.status === "succeeded", "listTasks succeeded");
  assert(
    tasks.some((t) => t.taskId === taskId),
    "listTasks includes our completed task",
  );

  // 7) cancel path: spawn a second task and cancel it before the worker runs
  //    its event wait to completion; assert it reaches cancelled.
  console.log("\n[7] cancel path: spawn + cancel a second task");
  const cancelName = `cancel-${Date.now()}`;
  const second = runMethod("spawn", {
    taskName: "greet",
    params: { name: cancelName },
  });
  const cancelTaskId = second.attributes.taskId as string;
  assert(!!cancelTaskId, `second task spawned (${cancelTaskId})`);
  const cancelled = runMethod("cancel", { taskId: cancelTaskId });
  // cancel_task may settle synchronously or shortly after; poll briefly.
  let cancelState = cancelled.attributes.state;
  if (cancelState !== "cancelled") {
    const c = await pollStatus(
      cancelTaskId,
      (s) => s === "cancelled",
      "second task to cancel",
      { timeoutMs: 15000, intervalMs: 1000 },
    );
    cancelState = c.state;
  }
  assert(cancelState === "cancelled", `second task cancelled (state=${cancelState})`);

  console.log("\n=== summary ===");
  if (failures === 0) {
    console.log("RESULT: PASS (all assertions passed)\n");
    process.exit(0);
  } else {
    console.log(`RESULT: FAIL (${failures} assertion(s) failed)\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nRESULT: FAIL (harness error)\n", err);
  process.exit(1);
});
