# @keeb/absurd

A [swamp](https://github.com/systeminit/swamp) extension that drives an
[Absurd](https://github.com/earendil-works/absurd) durable-execution task queue.

**Absurd** is "the simplest durable execution workflow system" — durable
workflows (tasks, checkpointed steps, retries, suspend/resume on events) built
on nothing but Postgres. **Swamp** is an AI-native automation framework: typed
models, workflow DAGs, and CEL data-chaining.

This extension is the bridge: it lets swamp *drive* an Absurd queue — spawn
tasks, poll status, wait for results, emit events, cancel, and list — so you can
orchestrate durable Absurd work from swamp models and workflows.

## How the two integrate

Absurd splits cleanly into two halves:

- **Client operations** (spawn, emit event, read status/result, cancel, list) —
  these are just SQL calls against Absurd's Postgres schema. **No running worker
  is required.** This extension implements exactly these, replaying the same SQL
  the Absurd TypeScript SDK runs, over a pinned `postgres` (porsager) client.
- **The worker** — the process that actually executes a task's handler code
  (its steps, sleeps, and `awaitEvent` suspends). This is application code and
  legitimately uses an Absurd SDK; swamp does not (and cannot) replace it.

So the division of labor is: **swamp orchestrates and observes; the Absurd
worker + Postgres guarantee durability.** The `tests/` harnesses below prove
both halves work together.

```
  swamp model / workflow                Absurd (Postgres)              your worker
  ─────────────────────                 ─────────────────              ───────────
  @keeb/absurd.spawn      ──► spawn_task ─► t_<queue> ◄── claim_task ──►  runs handler
  @keeb/absurd.emitEvent  ──► emit_event ─► e_<queue> ◄── awaitEvent ───  step / resume
  @keeb/absurd.awaitResult ◄─ get_task_result ◄─ c_<queue> (checkpoints) ◄ complete
```

## Methods

| Method        | Absurd SQL                | Purpose                                            |
| ------------- | ------------------------- | -------------------------------------------------- |
| `spawn`       | `absurd.spawn_task`       | Enqueue a task (`taskName`, `params`, options)     |
| `status`      | `absurd.get_task_result`  | Read a task's current state                        |
| `result`      | `absurd.get_task_result`  | Read a completed task's result payload             |
| `awaitResult` | `absurd.get_task_result`  | Poll (with backoff) until terminal, then return    |
| `emitEvent`   | `absurd.emit_event`       | Emit an event to wake a waiting task               |
| `cancel`      | `absurd.cancel_task`      | Cancel a task                                      |
| `listTasks`   | `SELECT … FROM t_<queue>` | List tasks (optional `state` filter)               |

Global arguments: `connectionString` (defaults to `$ABSURD_DATABASE_URL` or
`postgresql://absurd:absurd@localhost:5432/absurd`) and `queue` (default
`default`). Every method persists a `task` resource so its output can be
referenced from later workflow steps via CEL.

## Quickstart

### 1. Bring up Postgres + Absurd

The `deploy/` stack runs Postgres in Docker, applies the Absurd schema, and
creates the `default` queue:

```sh
cd deploy && ./up.sh          # postgresql://absurd:absurd@localhost:5432/absurd
```

The target database just needs the Absurd schema installed and a queue created
(`select absurd.create_queue('<name>')`).

### 2. Install the extension

```sh
swamp extension install @keeb/absurd
```

### 3. Drive the queue

```sh
# Spawn a task
swamp model method run my-queue spawn \
  --input '{"taskName":"send-email","params":{"to":"a@b.com"}}'

# Wait for it to finish, emit a wake event, fetch the result
swamp model method run my-queue awaitResult --input '{"taskId":"<uuid>"}'
swamp model method run my-queue emitEvent   --input '{"eventName":"approve:42","payload":{}}'
swamp model method run my-queue result      --input '{"taskId":"<uuid>"}'
```

## Orchestration example

`workflows/` contains `absurd-orchestrate`, a swamp workflow that wires the
extension into a DAG and uses CEL to chain the spawned task's id between steps:

```
spawn ──► emitEvent ──► collect (awaitResult)
                         taskId: ${{ data.findBySpec("absurd-wf", "task")[0].attributes.taskId }}
```

This is the integration's value: swamp's workflow engine orchestrating a durable
Absurd task, with the task's identity flowing between steps via swamp's data
model. The matching model definition is in `models/@keeb/absurd/`.

## Included tests — proving the integration

Each harness under `tests/` is self-contained (`./run.sh`) and prints `PASS`/`FAIL`.
They depend on the `deploy/` stack being up and use isolated Absurd queues.

| Harness                   | Queue       | What it proves                                                                                 |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `integration`             | `default`   | End-to-end plumbing: spawn → checkpointed step → suspend on event → `emitEvent` → resume → complete, driven through the extension. |
| `crash-recovery`          | `crashtest` | Absurd's headline guarantee: a worker is killed (`process.exit`) mid-task; a fresh worker reclaims it after the lease expires and **replays from checkpoint without re-running the completed step** (a side-effecting step runs exactly once across the crash + retry). |
| `workflow-orchestration`  | `wftest`    | Swamp **orchestration + CEL chaining**: the `absurd-orchestrate` workflow runs `spawn → emit → collect`, passing the taskId between steps via a CEL expression, and the durable result comes back combining the step output with the workflow-emitted event payload. |

Each harness vendors the Absurd TypeScript SDK to run a small worker; see each
directory's `README.md` for details. (The worker is the only piece that uses an
Absurd SDK directly — everything else goes through swamp.)

## How it works

The model connects with the pinned `postgres` npm client and replays the exact
SQL the Absurd TypeScript SDK runs for each client-side operation. Because
Absurd events are immutable and first-emit-wins, emitting an event before the
task reaches its `awaitEvent` is safe — the await resolves from the cached
event. `awaitResult` exists because a workflow step needs to *wait* for an async
task; it polls `get_task_result` with exponential backoff until the task reaches
a terminal state (completed/failed/cancelled) or a timeout.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
