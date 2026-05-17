/**
 * HiGHS WASM solver singleton.
 *
 * Wraps `@bubblyworld/highs-ts` — a TypeScript-native binding to the
 * HiGHS C++ optimisation solver compiled to WebAssembly. Chosen over
 * the older `lovasoa/highs-js` because the latter exposes solution
 * values via `Highs_writeSolutionPretty` (6-decimal truncation),
 * which breaks our `1e-9` LP epsilon checks. `@bubblyworld/highs-ts`
 * reads solution values directly from HiGHS via WASM exports and
 * preserves full IEEE 754 double precision.
 *
 * Loading model: load once per page (or per node process) via a
 * module-level promise.
 *   1. Call `initHighs()` at app startup so the WASM file fetches /
 *      compiles in the background.
 *   2. `getHighs()` is async — `@bubblyworld/highs-ts`'s `parse()` and
 *      `solve()` are async, so glue code in `highs-wrapper.ts` is also
 *      async. The init step is what blocks the UI from running
 *      calculations before HiGHS is ready (see `useProductionPlan`'s
 *      solverReady gate).
 *
 * In the test environment, `await initHighs()` is invoked once in
 * vitest's globalSetup so every test file sees a ready solver.
 *
 * License: MIT (this project's wrapper), MIT (HiGHS itself), MIT
 * (@bubblyworld/highs-ts).
 */
import { HiGHS } from "@bubblyworld/highs-ts";

let highsInstance: HiGHS | null = null;
let highsPromise: Promise<HiGHS> | null = null;

/**
 * Begin loading the HiGHS WASM. Idempotent — repeated calls return the
 * same promise. Should be invoked early (e.g. from `App.tsx` mount) so
 * the WASM is ready by the time the user triggers a calculation.
 *
 * The instance is reused across every `solve()` call; we never call
 * `instance.free()` because the singleton lives for the whole page /
 * process lifetime.
 */
export function initHighs(): Promise<HiGHS> {
  if (highsPromise) return highsPromise;
  highsPromise = HiGHS.create().then((instance) => {
    highsInstance = instance;
    return instance;
  });
  return highsPromise;
}

/**
 * Synchronous accessor for the HiGHS instance. Throws if `initHighs()`
 * hasn't resolved yet — this is intentional: solver call sites assume
 * a ready solver, and any "not ready" condition should be caught at
 * the UI layer (the calculate button is disabled until ready), not
 * inside the solver itself.
 */
export function getHighs(): HiGHS {
  if (!highsInstance) {
    throw new Error(
      "[HIGHS] Solver not initialised. Call `initHighs()` and await it before using `getHighs()`.",
    );
  }
  return highsInstance;
}

/**
 * True when HiGHS is ready. Used by UI layer to gate the calculate flow.
 */
export function isHighsReady(): boolean {
  return highsInstance !== null;
}
