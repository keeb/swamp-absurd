/**
 * Absurd worker for the swamp WORKFLOW orchestration proof.
 *
 * Identical durable `greet` task as tests/integration/worker.ts, but pinned to
 * queue `wftest` so it does not interfere with the `default` (integration) or
 * `crashtest` (crash-recovery) queues that other harnesses use.
 *
 * The `greet` task exercises the durable primitives a swamp workflow drives:
 *
 *   1. ctx.step("build-greeting", ...)  -> deterministic checkpointed step
 *   2. ctx.awaitEvent("approve:<name>") -> suspend until an external event
 *   3. returns { greeting, approval, ... } combining step + event payload
 *
 * The swamp workflow spawns this task, emits `approve:<name>`, then blocks on
 * the extension's `awaitResult` method until the task reaches `completed`.
 *
 * Runs on modern Node.js via native TypeScript type-stripping (no build step).
 */
import { Absurd } from "./absurd-sdk.ts";

const DATABASE_URL =
  process.env.ABSURD_DATABASE_URL ??
  "postgresql://absurd:absurd@localhost:5432/absurd";
const QUEUE = process.env.ABSURD_QUEUE ?? "wftest";

type GreetParams = { name: string };
type ApproveEvent = { approver?: string; note?: string };

const app = new Absurd({ db: DATABASE_URL, queueName: QUEUE });

app.registerTask<GreetParams>(
  { name: "greet", defaultMaxAttempts: 3 },
  async (params, ctx) => {
    // 1) Deterministic, checkpointed step.
    const greeting = await ctx.step("build-greeting", async () => {
      console.log(`[${ctx.taskID}] step build-greeting: name=${params.name}`);
      return { greeting: `hello ${params.name}` };
    });

    // 2) Suspend until the swamp workflow's EMIT step delivers the event.
    const eventName = `approve:${params.name}`;
    console.log(`[${ctx.taskID}] awaiting event ${eventName} (suspending)`);
    const approval = (await ctx.awaitEvent(eventName, {
      timeout: 120,
    })) as ApproveEvent;
    console.log(
      `[${ctx.taskID}] resumed: received ${eventName} -> ${JSON.stringify(
        approval,
      )}`,
    );

    // 3) Combine step output + event payload into the final durable result.
    const result = {
      name: params.name,
      greeting: greeting.greeting,
      approval,
      status: "completed" as const,
    };
    console.log(`[${ctx.taskID}] completed: ${JSON.stringify(result)}`);
    return result;
  },
);

console.log(
  `worker listening on queue "${QUEUE}" db=${DATABASE_URL.replace(
    /:[^:@/]+@/,
    ":***@",
  )}`,
);

await app.startWorker({ concurrency: 2, pollInterval: 0.25 });
