# Swamp workflow orchestration of a durable Absurd task

This harness proves the real value of the swamp <-> absurd integration: that
**swamp can orchestrate a durable [absurd](https://github.com/earendil-works/absurd)
task through a swamp workflow (a DAG)**, using swamp's CEL data-chaining to pass
a value (the spawned `taskId`) from one step to the next. It is the workflow
counterpart to the imperative `tests/integration/` harness — instead of driving
absurd from a Node script, the orchestration is declared as a swamp workflow and
executed by `swamp workflow run`.

## What it proves

1. **Swamp workflow as the orchestrator (DAG).** A three-step DAG
   (`spawn -> emit -> collect`) wired with step-level `dependsOn` /
   `condition: succeeded` drives the durable task through its full lifecycle.
2. **CEL data-chaining between steps.** The `taskId` produced by the `spawn`
   step's `task` data artifact is pulled into the `collect` step via a CEL
   expression — no hardcoded IDs, no re-fetching.
3. **Absurd durability.** The worker's `greet` task runs a checkpointed step,
   suspends on an event (`approve:<name>`), resumes when the workflow emits it,
   and returns a result combining the checkpointed greeting with the emitted
   approval payload.
4. **Synchronous collection of async work.** Because a workflow does not
   natively wait on an external async task, the `@keeb/absurd` extension was
   extended with an `awaitResult` method that polls `absurd.get_task_result`
   with exponential backoff (50ms -> 1s cap, mirroring the SDK's
   `awaitTaskResult`) until the task reaches a terminal state. This keeps the
   workflow clean: `spawn -> emit -> awaitResult`.

## The orchestration challenge

After `spawn`, the task is not `completed` immediately — it runs, then suspends
on `ctx.awaitEvent`. Two absurd facts make a clean DAG possible:

- **Events are first-emit-wins and cached**, so the `emit` step can safely run
  before the task actually reaches its `awaitEvent`.
- A bare `result` step right after `spawn` would observe `running`/`sleeping`,
  not `completed`. So the final `collect` step uses the **blocking**
  `awaitResult` method to poll until the task is terminal.

## Components

| File                | Role                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `worker.ts`         | Absurd worker on queue **`wftest`**, registers the durable `greet` task.   |
| `absurd-sdk.ts`     | Vendored absurd TS SDK (pg import shimmed for Node native ESM).            |
| `pg-shim.ts`        | ESM/CJS interop shim so the SDK's `import * as pg` exposes `pg.Pool`.      |
| `assert_collect.py` | Asserts the `collect` artifact is `completed` with the expected result.    |
| `first_name.py`     | Extracts the collect artifact name from a `swamp data query` result.      |
| `run.sh`            | Ties it together: DB up, queue, worker, validate, run, assert, teardown.   |

The swamp pieces live in the repo root, not here:

- **Model:** `models/@keeb/absurd/*.yaml` — instance `absurd-wf` with
  `globalArguments.queue = "wftest"`.
- **Workflow:** `workflows/workflow-*.yaml` — `absurd-orchestrate`.
- **Extension:** `extensions/models/absurd.ts` — adds the `awaitResult` method.

## The workflow (DAG)

```
job: orchestrate
  spawn   (absurd-wf.spawn)      -> writes `task` resource (incl. taskId)
    |  dependsOn: succeeded
  emit    (absurd-wf.emitEvent)  -> emits approve:<name> (first-emit-wins)
    |  dependsOn: succeeded
  collect (absurd-wf.awaitResult)-> blocks until task terminal; reads result
```

The chaining expression in the `collect` step:

```yaml
taskId: ${{ data.findBySpec("absurd-wf", "task")[0].attributes.taskId }}
```

`spawn` writes its resource under the instance name `task-<taskId>` with spec
name `task`, so `data.findBySpec("absurd-wf", "task")` selects that record and
`[0].attributes.taskId` resolves to the freshly spawned task's UUID.

## Run it

```bash
cd tests/workflow-orchestration
./run.sh
```

Expected tail:

```
[harness] run id=... status=succeeded
[harness] collect artifact: task-019e6ce5-fd67-707d-9c91-2d17e2d32553
[harness] === assertion result ===
OK: state=completed greeting='hello worldwf' approval={'note': 'approved via swamp workflow', 'approver': 'keeb'}
[harness] OVERALL: PASS
```

## Notes / caveats

- **Queue isolation:** this harness uses queue `wftest` exclusively so it does
  not interfere with `default` (integration) or `crashtest` (crash-recovery).
- **Blocking await:** `awaitResult` holds the model's per-model lock for the
  duration of the poll. That is fine for a single durable task; for long waits
  or many concurrent tasks, prefer separate model instances (one lock each) or a
  bounded `timeoutSeconds`.
- **Local extension type:** because `@keeb/absurd` is a local (unpublished)
  extension, `swamp workflow validate` skips the per-step input checks for it
  (structural DAG/CEL validation still runs and passes).
- Postgres is left running; the worker is always torn down by `run.sh`.
```
