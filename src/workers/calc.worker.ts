/**
 * Calculation worker — hosts the HiGHS WASM solver and the full
 * `calculateProductionPlan` pipeline off the main thread.
 *
 * WHY: `@bubblyworld/highs-ts` is async-API'd but its WASM executes
 * synchronously on the calling thread. On the main thread every solve
 * (multi-pass lexicographic LP + the Phase 3 ILP packer) froze pointer
 * processing — visible as scrub-drag jank. Same rationale as the ELK
 * layout worker (`src/lib/layout.ts`).
 *
 * Protocol (see `src/lib/calc-client.ts` for the client side):
 *   worker → main : { kind: "ready" }                    once, after WASM init
 *   main → worker : { kind: "solve", seq, targets, items,
 *                     recipes, facilities, options }
 *   worker → main : { kind: "result", seq, plan }
 *                 | { kind: "error",  seq, message }
 *
 * The client guarantees at most ONE outstanding job (latest-wins
 * coalescing happens client-side), so no queueing logic lives here.
 * All payloads are structured-clone-safe (Maps/Sets/plain data).
 *
 * Business logic stays in `@/lib/calculator` — this file is transport
 * only. Keep it that way.
 */
import { initHighs } from "@/lib/highs-singleton";
import {
  calculateProductionPlan,
  type CalculateProductionPlanOptions,
} from "@/lib/calculator";
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

export type CalcWorkerResponse =
  | { kind: "ready" }
  | { kind: "result"; seq: number; plan: unknown }
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

self.onmessage = async (e: MessageEvent<CalcSolveRequest>) => {
  const { seq, targets, items, recipes, facilities, options } = e.data;
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
