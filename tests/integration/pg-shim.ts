/**
 * ESM interop shim for the `pg` package.
 *
 * The vendored absurd SDK does `import * as pg from "pg"` and then uses
 * `pg.Pool`, `pg.Client`, etc. Under Node's native ESM/CJS interop the `pg`
 * namespace only exposes `default` (the CommonJS module.exports), so `pg.Pool`
 * is undefined and `new pg.Pool()` throws. This shim re-exports the named
 * bindings from the CommonJS default so `import * as pg from "./pg-shim.ts"`
 * behaves the way the SDK expects. (This is a runtime-interop fix on the
 * harness side, not a change to absurd or the swamp extension.)
 */
import pgDefault from "pg";

export const Pool = pgDefault.Pool;
export const Client = pgDefault.Client;
export const types = pgDefault.types;
export const native = pgDefault.native;
export default pgDefault;
