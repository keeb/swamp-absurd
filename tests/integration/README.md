# swamp ↔ absurd end-to-end integration test

This harness **proves** the `@keeb/absurd` swamp extension can drive a real
[absurd](https://github.com/earendil-works/absurd) durable-execution task queue
end-to-end: a durable task is spawned, runs a checkpointed step, suspends on an
event, is resumed by an externally-emitted event, and completes with the
expected result — with **swamp's extension performing every queue operation**
(spawn / status / emitEvent / result / listTasks / cancel).

## Why two pieces are required

- swamp's `@keeb/absurd` extension is the **client/driver**. It talks to
  Postgres directly and can spawn tasks, poll status, emit events, fetch
  results, list, and cancel — but it **cannot execute a task's handler code**.
- Executing a task handler requires an absurd **worker** process. So a genuine
  end-to-end proof needs both: a worker that registers + runs the demo task, and
  swamp driving that task through its lifecycle.

## Components

| File | Role |
| --- | --- |
| `worker.ts` | The only piece that uses the absurd SDK directly. Registers one demo task, `greet`, and runs a worker against queue `default`. |
| `flow.ts` | The driver. Shells out to the `swamp` CLI (`swamp model @keeb/absurd method run …`), parses `--json`, and asserts the full lifecycle. Drives the queue **only** through the extension. |
| `run.sh` | Orchestrator: checks deps, ensures Postgres is up, verifies the extension, starts the worker (logging to `worker.log`), runs `flow.ts`, prints PASS/FAIL, tears the worker down. |
| `pg-shim.ts` | ESM/CJS interop shim for the `pg` package (see Caveats). |
| `absurd-sdk.ts` | A vendored copy of the absurd TS SDK source, refreshed from `/home/keeb/git/absurd` by `run.sh` each run. Not committed. |
| `package.json` | Pins the single runtime dep: `pg`. |

## The demo task (`greet`)

Exercises all the durable primitives in one task:

1. `ctx.step("build-greeting", …)` → deterministic `"hello <name>"` from
   `params.name` (proves step checkpointing).
2. `ctx.awaitEvent("approve:<name>", { timeout })` → the task **suspends**
   (Postgres state `sleeping`) until the event arrives (proves event-driven
   suspend/resume).
3. Returns `{ name, greeting, approval, status }` combining the step output and
   the event payload.

## The test flow

1. **spawn** `greet` via the extension with object params (`{ name: … }`).
2. **status**-poll (with timeout) until the worker picks it up and suspends
   (`sleeping`).
3. **emitEvent** `approve:<name>` via the extension with a payload.
4. **status**-poll until `completed`.
5. **result** via the extension; **assert** `greeting` matches the step output
   and `approval` matches the emitted payload.
6. **listTasks** and assert our task is present.
7. **spawn + cancel** a second task; assert it reaches `cancelled`.

## Passing object-typed params through the swamp CLI

`swamp … method run <method> --input <value>` accepts either `key=value` pairs
or a JSON document. Object/array-valued inputs (like `params`) are passed as
**inline JSON**:

```bash
swamp model @keeb/absurd method run spawn absurd-itest \
  --input '{"taskName":"greet","params":{"name":"world"},"maxAttempts":3}' --json
```

`flow.ts` builds these with `JSON.stringify(...)`. The method's `--json` output
returns the written `task` snapshot inline at `dataArtifacts[0].attributes`, so
no second `swamp data get` round-trip is needed.

## Run it

```bash
cd tests/integration
./run.sh
```

Prerequisites (all auto-checked / handled by `run.sh`):

- Docker with the deploy stack reachable (`run.sh` runs `deploy/up.sh` if the
  `absurd-postgres` container isn't answering).
- `swamp` and `node` (Node ≥ 18; tested on Node 25) on `PATH`. Node runs the
  `.ts` files via native type-stripping — no build step.
- `pg` is installed via `npm install` on first run.

The harness leaves the Postgres stack **running** and always stops the worker it
started.

## SDK / runtime choices

- **TypeScript absurd SDK** over the Python one: it runs directly on Node with
  native TS type-stripping, needing only `pg` — no venv, no compile step.
- The SDK is **vendored** (`absurd-sdk.ts`) rather than `npm install`ed from its
  local path, because the package's `prepare` script runs `tsc`, which is not on
  `PATH` here. `run.sh` refreshes the vendored copy from the absurd repo each run
  so it stays in sync.

## Caveats / notes

- **`pg-shim.ts`** exists because the SDK does `import * as pg from "pg"; pg.Pool`,
  which only works through a bundler's CJS interop. Under Node's native ESM
  interop the `pg` namespace exposes only `default`, so `pg.Pool` is `undefined`.
  The shim re-exports the named bindings from the CJS default. `run.sh` rewrites
  the SDK's `pg` import to point at the shim. This is a **harness-side runtime
  fix only** — it does not change absurd or the swamp extension.
- swamp occasionally interleaves log lines (e.g. lock acquisition) before the
  JSON document on stdout; `flow.ts` isolates the JSON by slicing from the first
  `{` to the last `}`.
- Cancelled/suspended demo tasks from prior runs linger harmlessly in the queue;
  each run uses a unique `name`, so they never interfere.

## What a green run proves

`spawn → step execution → suspend on event → external emitEvent → resume →
complete with the expected result` — all driven through swamp's `@keeb/absurd`
extension, with an absurd worker executing the handler. That is a working,
repeatable swamp ↔ absurd integration.
