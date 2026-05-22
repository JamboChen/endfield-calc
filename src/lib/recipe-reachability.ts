import type { ItemId, Recipe, RecipeId } from "@/types";

/**
 * Transitive closure: which recipes are *runnable* given a set of
 * raw materials and a recipe pool, plus which items are *reachable*
 * through the resulting production chains.
 *
 * A recipe is `runnable` iff all its inputs are in the reachable set.
 * A recipe is `blocked` iff at least one input has no producer among
 * `recipes` AND isn't in `rawMaterials`.
 *
 * # Why this exists
 *
 * The AIC menu filters recipes by facility/mode unlock state
 * (`computeRecipeAvailability` in `aic-research-helpers.ts`), but it
 * doesn't check whether each remaining recipe's inputs can actually
 * be produced. A recipe whose host facility is unlocked but whose
 * inputs come from a now-locked facility is *available but blocked*
 * — calling it "available" is misleading because the calc would
 * silently treat its missing inputs as raw materials, surfacing as
 * surprise raws in the user's plan.
 *
 * This helper closes that gap. The App layer composes
 * `computeRecipeAvailability` (AIC-only) → `computeRecipeReachability`
 * (chain-aware) → single canonical `availableRecipes` used by the
 * picker, the calc, the override dropdown, and the auto-prune logic.
 *
 * # Algorithm
 *
 * Standard fixpoint:
 *   1. Seed `reachableItems` with `rawMaterials`.
 *   2. Loop: for each not-yet-runnable recipe, if all its inputs are
 *      in `reachableItems`, mark it runnable and add its outputs.
 *   3. Repeat until no change.
 *
 * Disposal recipes (0 outputs) are correctly handled: they're marked
 * runnable when their input is reachable, but contribute no new items
 * to the closure. The loop terminates because each pass either adds
 * a new item OR marks an already-reachable recipe and stops.
 *
 * Complexity: O(|recipes| × |items|) worst case. Trivial at our
 * scale (~270 recipes × ~150 items).
 *
 * # Usage
 *
 *   - **App layer** (single canonical pipeline): pass the AIC-filtered
 *     recipe set + `forcedRawMaterials`; consume `runnableRecipes` as
 *     the canonical `availableRecipes`.
 *   - **Prefill detection** (via `computeBootableItems` in
 *     `calculator.ts`): same closure, exposed through a wrapper that
 *     returns just the `reachableItems` set.
 *
 * Manual raws (`manualRawMaterials`) intentionally do NOT feed into
 * the App-layer closure. They're a plan-specific calc-time hint, not
 * a configuration-level capability. If a user pins an unreachable
 * intermediate as raw, the corresponding recipe stays filtered out
 * (manual-raw rescue is intentionally disabled — see commit notes).
 */
export function computeRecipeReachability(
  recipes: readonly Recipe[],
  rawMaterials: ReadonlySet<ItemId>,
): {
  reachableItems: ReadonlySet<ItemId>;
  runnableRecipes: readonly Recipe[];
  blockedRecipes: readonly Recipe[];
} {
  const reachableItems = new Set<ItemId>(rawMaterials);
  const runnableIds = new Set<RecipeId>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const recipe of recipes) {
      if (runnableIds.has(recipe.id)) continue;
      const allInputsReachable = recipe.inputs.every((i) =>
        reachableItems.has(i.itemId),
      );
      if (!allInputsReachable) continue;
      runnableIds.add(recipe.id);
      for (const o of recipe.outputs) {
        if (!reachableItems.has(o.itemId)) {
          reachableItems.add(o.itemId);
          changed = true;
        }
      }
    }
  }

  const runnableRecipes: Recipe[] = [];
  const blockedRecipes: Recipe[] = [];
  for (const r of recipes) {
    if (runnableIds.has(r.id)) runnableRecipes.push(r);
    else blockedRecipes.push(r);
  }

  return { reachableItems, runnableRecipes, blockedRecipes };
}
