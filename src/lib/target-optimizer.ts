/**
 * Target optimizer — Max(X) / Fit-to-limits engine.
 *
 * **Status: seeded.** This module currently carries only the Max-button
 * gating closure (`rawsInChainOf`); the bisection engine
 * (`maximizeTargetRate`, `fitTargetsToLimits`) lands in a follow-up
 * phase. Full design, semantics, and test matrix live in
 * `docs/plan-target-optimizer.md` — read that before extending this
 * file.
 */
import type { ItemId, Recipe } from "@/types";

/**
 * Backward closure over `recipes`: every item that can appear anywhere
 * in a production chain ending at `itemId`, intersected with
 * `rawMaterials`.
 *
 * Walks ALL alternative producers (mirroring `buildBipartiteGraph`'s
 * no-single-pick philosophy): if any available recipe chain can consume
 * a raw while producing `itemId`, that raw is in the result. This
 * deliberately over-approximates the raws the LP will actually pick —
 * for Max-button gating an over-approximation errs toward enabling the
 * button, and the engine's bracketing ceiling ("no limit reached")
 * defends against the false-positive case at runtime.
 *
 * Cycles (planter ↔ seed) are handled by the visited set; complexity is
 * O(items + recipe inputs) per call.
 */
export function rawsInChainOf(
  itemId: ItemId,
  recipes: readonly Recipe[],
  rawMaterials: ReadonlySet<ItemId>,
): Set<ItemId> {
  // Producer index: output item -> recipes that emit it.
  const producersByItem = new Map<ItemId, Recipe[]>();
  for (const recipe of recipes) {
    for (const output of recipe.outputs) {
      let list = producersByItem.get(output.itemId);
      if (!list) {
        list = [];
        producersByItem.set(output.itemId, list);
      }
      list.push(recipe);
    }
  }

  const raws = new Set<ItemId>();
  const visited = new Set<ItemId>();
  const queue: ItemId[] = [itemId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    // A raw terminates its branch: raws have no modeled producers, and
    // even if a recipe emitted one as a byproduct, the LP sources raws
    // from pickup points — the cap applies regardless.
    if (rawMaterials.has(current)) {
      raws.add(current);
      continue;
    }
    for (const recipe of producersByItem.get(current) ?? []) {
      for (const input of recipe.inputs) {
        if (!visited.has(input.itemId)) queue.push(input.itemId);
      }
    }
  }
  return raws;
}
