/**
 * Swamp model that drives an Absurd durable-execution task queue.
 *
 * Absurd (https://github.com/earendil-works/absurd) is a Postgres-based durable
 * execution workflow system. This model performs the *client-side* operations
 * Absurd's TypeScript SDK exposes — spawn a task, query its status, fetch a
 * completed task's result, emit an event, cancel a task, and list tasks — by
 * calling Absurd's SQL functions directly over a Postgres connection. None of
 * these operations require a running Absurd worker.
 *
 * Each operation persists a `task` resource snapshot so the spawned/queried
 * task can be referenced from later steps via CEL expressions.
 *
 * @module
 */

import { z } from "npm:zod@4";
import postgres from "npm:postgres@3.4.5";

/** Global arguments accepted by the `@keeb/absurd` model. */
const GlobalArgsSchema = z.object({
  connectionString: z
    .string()
    .default(
      Deno.env.get("ABSURD_DATABASE_URL") ??
        "postgresql://absurd:absurd@localhost:5432/absurd",
    )
    .describe(
      "Postgres connection string for the Absurd database. Defaults to " +
        "$ABSURD_DATABASE_URL or the standard local URL.",
    ),
  queue: z
    .string()
    .default("default")
    .describe("Absurd queue name the task/event operations target."),
});

/** Resolved global-argument type for the model. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Terminal and non-terminal states an Absurd task can be in. */
const TaskStateSchema = z.enum([
  "pending",
  "running",
  "sleeping",
  "completed",
  "failed",
  "cancelled",
]);

/** A task state value. */
type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Snapshot of a single Absurd task as observed by the client. Declared
 * properties are referenceable from CEL expressions in downstream models.
 */
const TaskSchema = z
  .object({
    taskId: z.string().describe("UUID of the task."),
    taskName: z.string().describe("Name of the spawned task handler."),
    queue: z.string().describe("Queue the task lives on."),
    state: TaskStateSchema.describe("Current task state."),
    params: z.unknown().nullable().describe(
      "Params the task was spawned with.",
    ),
    result: z
      .unknown()
      .nullable()
      .describe("Completed task result payload (null unless completed)."),
    failureReason: z
      .unknown()
      .nullable()
      .describe("Failure detail (null unless failed)."),
    runId: z
      .string()
      .nullable()
      .describe("Current run/attempt id from spawn (null for status reads)."),
    attempt: z
      .number()
      .nullable()
      .describe("Attempt number from spawn (null for status reads)."),
    created: z
      .boolean()
      .nullable()
      .describe("True if spawn inserted a new task (false on idempotent hit)."),
    idempotencyKey: z
      .string()
      .nullable()
      .describe("Idempotency key supplied at spawn, if any."),
    observedAt: z.string().describe("ISO-8601 time this snapshot was taken."),
  })
  .describe("Absurd task execution record.");

/** A persisted task snapshot. */
type TaskData = z.infer<typeof TaskSchema>;

/** Result of emitting an event into a queue. */
const EventSchema = z
  .object({
    eventName: z.string().describe("Name of the emitted event."),
    queue: z.string().describe("Queue the event was emitted into."),
    payload: z.unknown().nullable().describe("Event payload (may be null)."),
    emittedAt: z.string().describe("ISO-8601 time the event was emitted."),
  })
  .describe("Absurd event emission record.");

/** A persisted event emission record. */
type EventData = z.infer<typeof EventSchema>;

/** Result of a task listing. */
const TaskListSchema = z
  .object({
    queue: z.string().describe("Queue that was listed."),
    stateFilter: z
      .string()
      .nullable()
      .describe("State filter applied, if any."),
    count: z.number().describe("Number of tasks returned."),
    tasks: z
      .array(
        z.object({
          taskId: z.string(),
          taskName: z.string(),
          state: TaskStateSchema,
          attempts: z.number(),
          enqueueAt: z.string().nullable(),
        }),
      )
      .describe("The listed tasks."),
    listedAt: z.string().describe("ISO-8601 time the listing was taken."),
  })
  .describe("Absurd task listing snapshot.");

/** A persisted task-listing snapshot. */
type TaskListData = z.infer<typeof TaskListSchema>;

/** Open a one-shot Postgres connection configured for short-lived CLI use. */
function connect(connectionString: string): ReturnType<typeof postgres> {
  return postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    // Absurd payloads are jsonb; let the driver hand us parsed JS values.
    types: {},
  });
}

/**
 * Fetch a task's current state plus result/failure via Absurd's
 * `get_task_result`, mirroring the SDK's `fetchTaskResult`. Returns null when
 * the task does not exist in the selected queue.
 */
async function fetchTaskSnapshot(
  sql: ReturnType<typeof postgres>,
  queue: string,
  taskId: string,
): Promise<
  {
    state: TaskState;
    result: unknown;
    failureReason: unknown;
  } | null
> {
  const rows = await sql<
    { state: string; result: unknown; failure_reason: unknown }[]
  >`SELECT state, result, failure_reason
      FROM absurd.get_task_result(${queue}, ${taskId}::uuid)`;
  const row = rows[0];
  if (!row) return null;
  return {
    state: row.state as TaskState,
    result: row.result ?? null,
    failureReason: row.failure_reason ?? null,
  };
}

/** Minimal shape of the method `context` surface this model relies on. */
interface MethodContext {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Model definition for the `@keeb/absurd` task-queue client. */
export const model = {
  type: "@keeb/absurd",
  version: "2026.05.27.2",
  globalArguments: GlobalArgsSchema,

  resources: {
    "task": {
      description: "Snapshot of an Absurd task (spawn/status/result/cancel).",
      schema: TaskSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "event": {
      description: "Record of an event emitted into the queue.",
      schema: EventSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "taskList": {
      description: "Snapshot of a queue's task listing.",
      schema: TaskListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    spawn: {
      description:
        "Spawn a task onto the queue (Absurd absurd.spawn_task). Writes a " +
        "`task` resource capturing the new task's identity and state.",
      arguments: z.object({
        taskName: z.string().min(1).describe("Name of the task to spawn."),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON params passed to the task handler."),
        maxAttempts: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum retry attempts."),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Dedup key — re-spawning with the same key is a no-op."),
      }),
      execute: async (
        args: {
          taskName: string;
          params?: Record<string, unknown>;
          maxAttempts?: number;
          idempotencyKey?: string;
        },
        context: MethodContext,
      ) => {
        const { connectionString, queue } = context.globalArgs;
        const sql = connect(connectionString);
        try {
          const params = args.params ?? null;
          // Mirror the SDK's normalizeSpawnOptions snake_case keys.
          const options: Record<string, unknown> = {};
          if (args.maxAttempts !== undefined) {
            options.max_attempts = args.maxAttempts;
          }
          if (args.idempotencyKey !== undefined) {
            options.idempotency_key = args.idempotencyKey;
          }

          const rows = await sql<
            {
              task_id: string;
              run_id: string | null;
              attempt: number | null;
              created: boolean;
            }[]
          >`SELECT task_id, run_id, attempt, created
              FROM absurd.spawn_task(
                ${queue},
                ${args.taskName},
                ${sql.json(params as never)},
                ${sql.json(options as never)}
              )`;
          const row = rows[0];
          if (!row) {
            throw new Error("Failed to spawn task: spawn_task returned no row");
          }

          // Read back the authoritative state for the task.
          const snapshot = await fetchTaskSnapshot(sql, queue, row.task_id);

          const handle = await context.writeResource(
            "task",
            `task-${row.task_id}`,
            {
              taskId: row.task_id,
              taskName: args.taskName,
              queue,
              state: snapshot?.state ?? "pending",
              params,
              result: snapshot?.result ?? null,
              failureReason: snapshot?.failureReason ?? null,
              runId: row.run_id,
              attempt: row.attempt,
              created: row.created,
              idempotencyKey: args.idempotencyKey ?? null,
              observedAt: new Date().toISOString(),
            },
          );

          context.logger.info(
            "Spawned task {taskName} ({taskId}) on queue {queue} (created={created})",
            {
              taskName: args.taskName,
              taskId: row.task_id,
              queue,
              created: row.created,
            },
          );

          return { dataHandles: [handle] };
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    },

    status: {
      description:
        "Query a task's current state (Absurd absurd.get_task_result) and " +
        "write an updated `task` resource snapshot.",
      arguments: z.object({
        taskId: z.string().min(1).describe("UUID of the task to inspect."),
      }),
      execute: async (
        args: { taskId: string },
        context: MethodContext,
      ) => {
        const { connectionString, queue } = context.globalArgs;
        const sql = connect(connectionString);
        try {
          const snapshot = await fetchTaskSnapshot(sql, queue, args.taskId);
          if (!snapshot) {
            throw new Error(
              `Task "${args.taskId}" not found in queue "${queue}"`,
            );
          }

          // Pull task_name/params for a fuller snapshot from the queue table.
          const meta = await sql<
            { task_name: string; params: unknown }[]
          >`SELECT task_name, params
              FROM absurd.${sql("t_" + queue)}
             WHERE task_id = ${args.taskId}::uuid`;

          const handle = await context.writeResource(
            "task",
            `task-${args.taskId}`,
            {
              taskId: args.taskId,
              taskName: meta[0]?.task_name ?? "",
              queue,
              state: snapshot.state,
              params: meta[0]?.params ?? null,
              result: snapshot.result ?? null,
              failureReason: snapshot.failureReason ?? null,
              runId: null,
              attempt: null,
              created: null,
              idempotencyKey: null,
              observedAt: new Date().toISOString(),
            },
          );

          context.logger.info("Task {taskId} state: {state}", {
            taskId: args.taskId,
            state: snapshot.state,
          });

          return { dataHandles: [handle] };
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    },

    result: {
      description: "Fetch a completed task's result payload (Absurd " +
        "absurd.get_task_result) and persist a `task` snapshot.",
      arguments: z.object({
        taskId: z.string().min(1).describe("UUID of the task."),
      }),
      execute: async (
        args: { taskId: string },
        context: MethodContext,
      ) => {
        const { connectionString, queue } = context.globalArgs;
        const sql = connect(connectionString);
        try {
          const snapshot = await fetchTaskSnapshot(sql, queue, args.taskId);
          if (!snapshot) {
            throw new Error(
              `Task "${args.taskId}" not found in queue "${queue}"`,
            );
          }

          const meta = await sql<
            { task_name: string; params: unknown }[]
          >`SELECT task_name, params
              FROM absurd.${sql("t_" + queue)}
             WHERE task_id = ${args.taskId}::uuid`;

          const handle = await context.writeResource(
            "task",
            `task-${args.taskId}`,
            {
              taskId: args.taskId,
              taskName: meta[0]?.task_name ?? "",
              queue,
              state: snapshot.state,
              params: meta[0]?.params ?? null,
              result: snapshot.result ?? null,
              failureReason: snapshot.failureReason ?? null,
              runId: null,
              attempt: null,
              created: null,
              idempotencyKey: null,
              observedAt: new Date().toISOString(),
            },
          );

          if (snapshot.state !== "completed") {
            context.logger.warning(
              "Task {taskId} is not completed (state={state}); result is null",
              { taskId: args.taskId, state: snapshot.state },
            );
          } else {
            context.logger.info("Fetched result for completed task {taskId}", {
              taskId: args.taskId,
            });
          }

          return { dataHandles: [handle] };
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    },

    awaitResult: {
      description:
        "Block until a task reaches a terminal state (completed/failed/" +
        "cancelled) or a timeout elapses, then persist a `task` snapshot. " +
        "Polls Absurd's absurd.get_task_result with exponential backoff " +
        "(50ms -> 1s cap), mirroring the SDK's awaitTaskResult. Use this in a " +
        "workflow after spawn (+ any emitEvent) to collect the durable " +
        "task's result synchronously.",
      arguments: z.object({
        taskId: z.string().min(1).describe("UUID of the task to await."),
        timeoutSeconds: z
          .number()
          .min(0)
          .default(120)
          .describe(
            "Maximum seconds to wait for a terminal state before failing.",
          ),
      }),
      execute: async (
        args: { taskId: string; timeoutSeconds: number },
        context: MethodContext,
      ) => {
        const { connectionString, queue } = context.globalArgs;
        const sql = connect(connectionString);
        try {
          const timeoutMs = args.timeoutSeconds * 1000;
          const startedAt = Date.now();
          let delayMs = 50;
          let snapshot: Awaited<ReturnType<typeof fetchTaskSnapshot>> = null;

          // Exponential backoff poll, identical semantics to the SDK's
          // awaitTaskResultWithBackoff: 50ms initial, doubling, 1s cap.
          while (true) {
            snapshot = await fetchTaskSnapshot(sql, queue, args.taskId);
            if (!snapshot) {
              throw new Error(
                `Task "${args.taskId}" not found in queue "${queue}"`,
              );
            }
            if (
              snapshot.state === "completed" ||
              snapshot.state === "failed" ||
              snapshot.state === "cancelled"
            ) {
              break;
            }
            const elapsed = Date.now() - startedAt;
            const remaining = timeoutMs - elapsed;
            if (remaining <= 0) {
              throw new Error(
                `Timed out after ${args.timeoutSeconds}s waiting for task ` +
                  `"${args.taskId}" (last state=${snapshot.state})`,
              );
            }
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, Math.min(delayMs, remaining)))
            );
            delayMs = Math.min(delayMs * 2, 1000);
          }

          const meta = await sql<
            { task_name: string; params: unknown }[]
          >`SELECT task_name, params
              FROM absurd.${sql("t_" + queue)}
             WHERE task_id = ${args.taskId}::uuid`;

          const handle = await context.writeResource(
            "task",
            `task-${args.taskId}`,
            {
              taskId: args.taskId,
              taskName: meta[0]?.task_name ?? "",
              queue,
              state: snapshot.state,
              params: meta[0]?.params ?? null,
              result: snapshot.result ?? null,
              failureReason: snapshot.failureReason ?? null,
              runId: null,
              attempt: null,
              created: null,
              idempotencyKey: null,
              observedAt: new Date().toISOString(),
            },
          );

          context.logger.info(
            "Awaited task {taskId} -> terminal state {state}",
            { taskId: args.taskId, state: snapshot.state },
          );

          return { dataHandles: [handle] };
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    },

    emitEvent: {
      description:
        "Emit an event into the queue (Absurd absurd.emit_event). Payloads " +
        "are immutable per event name — first emit wins.",
      arguments: z.object({
        eventName: z.string().min(1).describe("Name of the event to emit."),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON payload to attach to the event."),
      }),
      execute: async (
        args: { eventName: string; payload?: Record<string, unknown> },
        context: MethodContext,
      ) => {
        const { connectionString, queue } = context.globalArgs;
        const sql = connect(connectionString);
        try {
          const payload = args.payload ?? null;
          await sql`SELECT absurd.emit_event(
              ${queue},
              ${args.eventName},
              ${sql.json(payload as never)}
            )`;

          const handle = await context.writeResource(
            "event",
            `event-${queue}-${args.eventName}`,
            {
              eventName: args.eventName,
              queue,
              payload,
              emittedAt: new Date().toISOString(),
            },
          );

          context.logger.info(
            "Emitted event {eventName} into queue {queue}",
            { eventName: args.eventName, queue },
          );

          return { dataHandles: [handle] };
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    },

    cancel: {
      description:
        "Cancel a task (Absurd absurd.cancel_task) and persist its updated " +
        "`task` snapshot.",
      arguments: z.object({
        taskId: z.string().min(1).describe("UUID of the task to cancel."),
      }),
      execute: async (
        args: { taskId: string },
        context: MethodContext,
      ) => {
        const { connectionString, queue } = context.globalArgs;
        const sql = connect(connectionString);
        try {
          await sql`SELECT absurd.cancel_task(${queue}, ${args.taskId}::uuid)`;

          const snapshot = await fetchTaskSnapshot(sql, queue, args.taskId);
          const meta = await sql<
            { task_name: string; params: unknown }[]
          >`SELECT task_name, params
              FROM absurd.${sql("t_" + queue)}
             WHERE task_id = ${args.taskId}::uuid`;

          const handle = await context.writeResource(
            "task",
            `task-${args.taskId}`,
            {
              taskId: args.taskId,
              taskName: meta[0]?.task_name ?? "",
              queue,
              state: snapshot?.state ?? "cancelled",
              params: meta[0]?.params ?? null,
              result: snapshot?.result ?? null,
              failureReason: snapshot?.failureReason ?? null,
              runId: null,
              attempt: null,
              created: null,
              idempotencyKey: null,
              observedAt: new Date().toISOString(),
            },
          );

          context.logger.info("Cancelled task {taskId} (state={state})", {
            taskId: args.taskId,
            state: snapshot?.state ?? "cancelled",
          });

          return { dataHandles: [handle] };
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    },

    listTasks: {
      description:
        "List tasks on the queue, optionally filtered by state. Reads the " +
        "queue-prefixed `t_<queue>` table directly (the SDK has no list RPC). " +
        "Fan-out: returns all matches in a single `taskList` resource.",
      arguments: z.object({
        state: TaskStateSchema.optional().describe(
          "Optional state filter (pending/running/sleeping/completed/failed/cancelled).",
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Maximum number of tasks to return (1-1000)."),
      }),
      execute: async (
        args: { state?: TaskState; limit: number },
        context: MethodContext,
      ) => {
        const { connectionString, queue } = context.globalArgs;
        const sql = connect(connectionString);
        try {
          const rows = args.state !== undefined
            ? await sql<
              {
                task_id: string;
                task_name: string;
                state: string;
                attempts: number;
                enqueue_at: Date | null;
              }[]
            >`SELECT task_id, task_name, state, attempts, enqueue_at
                FROM absurd.${sql("t_" + queue)}
               WHERE state = ${args.state}
               ORDER BY enqueue_at DESC
               LIMIT ${args.limit}`
            : await sql<
              {
                task_id: string;
                task_name: string;
                state: string;
                attempts: number;
                enqueue_at: Date | null;
              }[]
            >`SELECT task_id, task_name, state, attempts, enqueue_at
                FROM absurd.${sql("t_" + queue)}
               ORDER BY enqueue_at DESC
               LIMIT ${args.limit}`;

          const tasks = rows.map((r) => ({
            taskId: r.task_id,
            taskName: r.task_name,
            state: r.state as TaskState,
            attempts: r.attempts,
            enqueueAt: r.enqueue_at
              ? new Date(r.enqueue_at).toISOString()
              : null,
          }));

          const handle = await context.writeResource(
            "taskList",
            "taskList-main",
            {
              queue,
              stateFilter: args.state ?? null,
              count: tasks.length,
              tasks,
              listedAt: new Date().toISOString(),
            },
          );

          context.logger.info(
            "Listed {count} task(s) on queue {queue}{filter}",
            {
              count: tasks.length,
              queue,
              filter: args.state ? ` (state=${args.state})` : "",
            },
          );

          return { dataHandles: [handle] };
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    },
  },
};
