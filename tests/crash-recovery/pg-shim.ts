/**
 * ESM interop shim for the `pg` package (identical to tests/integration).
 *
 * The vendored absurd SDK does `import * as pg from "pg"` and uses `pg.Pool`.
 * Under Node's native ESM/CJS interop the `pg` namespace only exposes `default`,
 * so `pg.Pool` is undefined. This shim re-exports the named bindings from the
 * CommonJS default so `import * as pg from "./pg-shim.ts"` works as the SDK
 * expects. Runtime-interop fix on the harness side only.
 */
import pgDefault from "pg";

export const Pool = pgDefault.Pool;
export const Client = pgDefault.Client;
export const types = pgDefault.types;
export const native = pgDefault.native;
export default pgDefault;
