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
 *   2. `highs-wrapper.solve` awaits `initHighs()` per call — instant
 *      when warm, and the seam that transparently recreates the
 *      instance after a `resetHighs()` self-heal. The init step is
 *      what blocks the UI from running calculations before HiGHS is
 *      ready (see `useProductionPlan`'s `isLoading` state).
 *
 * In the test environment, `await initHighs()` is invoked once via
 * vitest's `test.setupFiles` (per worker) so every test file sees a
 * ready solver.
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
 * True when HiGHS is ready. Used by UI layer to gate the calculate flow.
 */
export function isHighsReady(): boolean {
  return highsInstance !== null;
}

/**
 * Discard the current HiGHS instance so the next `initHighs()` (which
 * `highs-wrapper.solve` awaits per call) creates a fresh one.
 *
 * Self-heal seam for wedged WASM: a pathological MIP (e.g. the
 * packer's cap-infeasible retry chain on a heavily over-cap plan) can
 * leave the instance in a state where every subsequent `solve()`
 * throws. Those throws are caught upstream (`lp-solver` maps them to
 * `solver_error`, the packer to its fallback path), so without this
 * reset the app silently returns empty plans until a full page reload
 * — the "frozen until refresh" failure mode. `highs-wrapper.solve`
 * calls this on any parse/solve throw before rethrowing.
 *
 * The stale instance's `free()` is best-effort: it is already
 * presumed broken, so a throwing free is expected noise.
 */
export function resetHighs(): void {
  const stale = highsInstance;
  highsInstance = null;
  highsPromise = null;
  try {
    stale?.free();
  } catch {
    // Ignore — see JSDoc.
  }
}
