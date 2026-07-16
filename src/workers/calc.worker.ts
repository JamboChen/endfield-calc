/**
 * Calculation worker — hosts the HiGHS WASM solver, the full
 * `calculateProductionPlan` pipeline, AND the optimizer search loops
 * (Max / Fit bisection) off the main thread.
 *
 * WHY: `@bubblyworld/highs-ts` is async-API'd but its WASM executes
 * synchronously on the calling thread. On the main thread every solve
 * (multi-pass lexicographic LP + the Phase 3 ILP packer) froze pointer
 * processing — visible as scrub-drag jank. Same rationale as the ELK
 * layout worker (`src/lib/layout.ts`).
 *
 * WHY searches run here too: a Max/Fit search is 40-60 probe solves.
 * Driving them from the main thread round-tripped a full structured-
 * clone of the plan graph per probe (the search only needs the
 * verdict) and made probes displace display calcs in the client's
 * latest-wins queue. In-worker, a search is ONE job: probes call
 * `calculateProductionPlan` directly and only the small result
 * crosses the boundary.
 *
 * Protocol (see `src/lib/calc-client.ts` for the client side):
 *   worker → main : { kind: "ready" }                    once, after WASM init
 *   main → worker : { kind: "solve", seq, targets, items,
 *                     recipes, facilities, options }
 *   worker → main : { kind: "result", seq, plan }
 *   main → worker : { kind: "search", seq, op, targets, … }
 *   main → worker : { kind: "cancel-search", seq }       control message
 *   worker → main : { kind: "search-result", seq, result }
 *                 | { kind: "error",  seq, message }
 *
 * The client guarantees at most ONE outstanding solve/search job
 * (latest-wins coalescing happens client-side); `cancel-search` is a
 * fire-and-forget control message that may arrive while that job runs
 * — the engines poll `isCancelled` before every probe solve, so the
 * event loop picks the flag up between probes. All payloads are
 * structured-clone-safe (Maps/Sets/plain data).
 *
 * Business logic stays in `@/lib/calculator` / `@/lib/target-optimizer`
 * — this file is transport only. Keep it that way.
 */
import { initHighs } from "@/lib/highs-singleton";
import {
  calculateProductionPlan,
  type CalculateProductionPlanOptions,
} from "@/lib/calculator";
import {
  maximizeTargetRate,
  fitTargetsToLimits,
  type FitResult,
  type MaximizeResult,
  type OptimizableTarget,
  type TargetVectorEntry,
} from "@/lib/target-optimizer";
import type { Facility, Item, ItemId, Recipe } from "@/types";

export interface CalcSolveRequest {
  kind: "solve";
  seq: number;
  targets: Array<{ itemId: ItemId; rate: number }>;
  items: readonly Item[];
  recipes: readonly Recipe[];
  facilities: readonly Facility[];
  options: CalculateProductionPlanOptions;
}

/** Which engine to run + its per-op parameter. */
export type CalcSearchOp =
  | { op: "max"; index: number }
  | { op: "fit"; excludeIndex?: number };

export type CalcSearchRequest = {
  kind: "search";
  seq: number;
  targets: readonly OptimizableTarget[];
  items: readonly Item[];
  recipes: readonly Recipe[];
  facilities: readonly Facility[];
  options: CalculateProductionPlanOptions;
} & CalcSearchOp;

/** Cooperative cancellation for an in-flight search job. Safe to send
 *  for a seq that already finished — the worker drops any cancel whose
 *  seq isn't the ACTIVE search's (see `activeSearchSeq`). */
export interface CalcSearchCancel {
  kind: "cancel-search";
  seq: number;
}

export type CalcWorkerRequest =
  | CalcSolveRequest
  | CalcSearchRequest
  | CalcSearchCancel;

export type CalcWorkerResponse =
  | { kind: "ready" }
  | { kind: "result"; seq: number; plan: unknown }
  | { kind: "search-result"; seq: number; result: MaximizeResult | FitResult }
  | { kind: "error"; seq: number; message: string };

const ready = initHighs();
ready
  .then(() => {
    self.postMessage({ kind: "ready" } satisfies CalcWorkerResponse);
  })
  .catch((e) => {
    // Surface init failure as a worker-level error so the client's
    // onerror handler triggers its fallback path.
    setTimeout(() => {
      throw e;
    });
  });

/**
 * The running search job's seq + cancellation flag. The client
 * guarantees at most one outstanding job, so a pair of scalars
 * suffices. `activeSearchSeq` is set SYNCHRONOUSLY before the search
 * branch's first await (message ordering delivers `search` before its
 * own `cancel-search`, but the cancel can be processed during any
 * await). A `cancel-search` whose seq doesn't match the active search
 * is dropped outright — it raced an already-settled job (the client's
 * `inflight` clears only after it processes the result message), and
 * seqs are never reused, so dropping is always safe.
 */
let activeSearchSeq: number | null = null;
let activeSearchCancelled = false;

self.onmessage = async (e: MessageEvent<CalcWorkerRequest>) => {
  const data = e.data;

  if (data.kind === "cancel-search") {
    if (data.seq === activeSearchSeq) activeSearchCancelled = true;
    return;
  }

  if (data.kind === "search") {
    const { seq } = data;
    activeSearchSeq = seq;
    activeSearchCancelled = false;
    try {
      await ready;
      const solve = (vector: TargetVectorEntry[]) =>
        calculateProductionPlan(
          vector,
          data.items,
          data.recipes,
          data.facilities,
          data.options,
        );
      const isCancelled = () => activeSearchCancelled;
      const result =
        data.op === "max"
          ? await maximizeTargetRate({
              targets: data.targets,
              index: data.index,
              solve,
              isCancelled,
            })
          : await fitTargetsToLimits({
              targets: data.targets,
              excludeIndex: data.excludeIndex,
              solve,
              isCancelled,
            });
      self.postMessage({
        kind: "search-result",
        seq,
        result,
      } satisfies CalcWorkerResponse);
    } catch (err) {
      // Engine aborts (solver_error probes, pass-2 contradiction) and
      // solve failures all land here — the client rejects the search
      // promise and the hook shows the error toast.
      self.postMessage({
        kind: "error",
        seq,
        message: err instanceof Error ? err.message : String(err),
      } satisfies CalcWorkerResponse);
    } finally {
      if (activeSearchSeq === seq) activeSearchSeq = null;
    }
    return;
  }

  const { seq, targets, items, recipes, facilities, options } = data;
  try {
    await ready;
    const plan = await calculateProductionPlan(
      targets,
      items,
      recipes,
      facilities,
      options,
    );
    self.postMessage({
      kind: "result",
      seq,
      plan,
    } satisfies CalcWorkerResponse);
  } catch (err) {
    self.postMessage({
      kind: "error",
      seq,
      message: err instanceof Error ? err.message : String(err),
    } satisfies CalcWorkerResponse);
  }
};
