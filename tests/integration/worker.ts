/**
 * Absurd worker for the swamp <-> absurd integration test.
 *
 * Registers ONE demo task, `greet`, that exercises the full set of durable
 * primitives so the swamp extension can drive it end-to-end:
 *
 *   1. ctx.step("build-greeting", ...)  -> deterministic checkpointed step
 *   2. ctx.awaitEvent("approve:<name>") -> suspend until an external event
 *   3. returns { greeting, approval, ... } combining step + event payload
 *
 * This is the ONLY component that legitimately uses the absurd SDK directly;
 * everything else in the harness drives the queue through swamp's @keeb/absurd
 * model extension. The worker connects to the SAME Postgres URL and queue
 * (`default`) the extension defaults to.
 *
 * Runs on modern Node.js via native TypeScript type-stripping (no build step).
 */
// Import the SDK from a vendored copy of its TypeScript source (absurd-sdk.ts,
// refreshed from /home/keeb/git/absurd by run.sh). Node strips the types
// natively (no build step). We vendor rather than (a) npm-installing the local
// package -- its `prepare` runs `tsc`, which is not on PATH -- or (b) importing
// the source in place -- Node resolves the SDK's bare `pg` import relative to
// the importing FILE, and /home/keeb/git/absurd has no pg installed. Vendoring
// puts the file next to this dir's node_modules so `pg` resolves.
import { Absurd } from "./absurd-sdk.ts";

const DATABASE_URL =
  process.env.ABSURD_DATABASE_URL ??
  "postgresql://absurd:absurd@localhost:5432/absurd";
const QUEUE = process.env.ABSURD_QUEUE ?? "default";

type GreetParams = { name: string };
type ApproveEvent = { approver?: string; note?: string };

const app = new Absurd({ db: DATABASE_URL, queueName: QUEUE });

app.registerTask<GreetParams>(
  { name: "greet", defaultMaxAttempts: 3 },
  async (params, ctx) => {
    // 1) Deterministic, checkpointed step. If the process crashed and the task
    //    were re-claimed, this step's recorded output would be replayed rather
    //    than recomputed -- that is the durable-execution guarantee.
    const greeting = await ctx.step("build-greeting", async () => {
      console.log(
        `[${ctx.taskID}] step build-greeting: name=${params.name}`,
      );
      return { greeting: `hello ${params.name}` };
    });

    // 2) Suspend until an external event arrives. The event name is derived
    //    from the param so the driver knows what to emit. While suspended the
    //    task's state in Postgres is `sleeping`.
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

    // 3) Combine step output + event payload into the final result.
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
