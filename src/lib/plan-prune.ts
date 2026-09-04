/**
 * Plan auto-prune — decides what a plan must drop to stay honourable
 * under the current settings.
 *
 * When the available-recipe set shrinks (a tech toggled off, a domain
 * deactivated, or a URL/file plan loaded against settings that don't
 * unlock it), state that can no longer be honoured has to go: targets
 * nothing can produce, recipe pins whose recipe is gone, manual raws
 * with no source. `useProductionPlan` applies the result and shows one
 * summary toast.
 *
 * Pure so the rules — which are subtler than they look — are testable
 * without a DOM. See `plan-prune.test.ts`.
 *
 * # Why onboarding gates this
 *
 * The pre-onboarding defaults are NOT neutral: every non-pinned domain
 * starts inactive, so a first-time visitor's settings are STRICTER than
 * the all-checked default the onboarding dialog is about to apply. Left
 * ungated, opening a shared plan built in a non-pinned region would
 * delete its targets moments before the user clicks a button that would
 * have made them buildable — and the prune is destructive, so
 * completing onboarding cannot bring them back.
 *
 * So `onboardingPending` suppresses the prune entirely. Once the user
 * answers, the flag flips, this runs again against their real settings,
 * and the summary toast finally tells the truth.
 */

import type { ProductionTarget } from "@/components/panels/TargetItemsGrid";
import type { ItemId, RecipeId } from "@/types";

/** The plan state subject to pruning. */
export interface PrunablePlan {
  readonly targets: readonly ProductionTarget[];
  readonly recipeOverrides: ReadonlyMap<ItemId, RecipeId>;
  readonly manualRawMaterials: ReadonlySet<ItemId>;
}

/** What the current settings make reachable. */
export interface PruneContext {
  /**
   * While true nothing is pruned — the settings in force are provisional
   * defaults the user hasn't chosen yet (see the module doc).
   */
  readonly onboardingPending: boolean;
  /** Items produced by at least one currently-available recipe. */
  readonly reachableProducibleItems: ReadonlySet<ItemId>;
  /** Ids of the currently-available recipes. */
  readonly availableRecipeIds: ReadonlySet<RecipeId>;
  /** Items obtainable through a live Metastorage route. */
  readonly metastorageImportableItems: ReadonlySet<ItemId>;
  /** Raws the current region supplies directly. */
  readonly regionRawMaterials: ReadonlySet<ItemId>;
}

/**
 * The surviving state plus what it cost to get there. The collections
 * are freshly built and handed to the caller to own, so they're mutable
 * types — they drop straight into the plan's state setters.
 */
export interface PruneResult {
  readonly targets: ProductionTarget[];
  readonly recipeOverrides: Map<ItemId, RecipeId>;
  readonly manualRawMaterials: Set<ItemId>;
  readonly removedTargets: number;
  readonly removedOverrides: number;
  readonly removedRaws: number;
  /** Total removals — what the summary toast reports. */
  readonly total: number;
}

/**
 * Compute the prune, or `null` when there is nothing to apply.
 *
 * `null` covers both "onboarding hasn't been answered" and "nothing to
 * remove", because the caller does the same thing either way: leave the
 * plan alone and stay silent. Collapsing them keeps the caller a single
 * branch — the distinction only matters here.
 *
 * Idempotent: feeding a result's state back in returns `null`, which is
 * what stops the caller's state writes from producing a second toast.
 */
export function computePlanPrune(
  plan: PrunablePlan,
  context: PruneContext,
): PruneResult | null {
  if (context.onboardingPending) return null;

  const {
    reachableProducibleItems,
    availableRecipeIds,
    metastorageImportableItems,
    regionRawMaterials,
  } = context;

  // A target survives if anything can produce it locally OR a live
  // Metastorage route can import it.
  const targets = plan.targets.filter(
    (t) =>
      reachableProducibleItems.has(t.itemId) ||
      metastorageImportableItems.has(t.itemId),
  );
  const removedTargets = plan.targets.length - targets.length;

  let removedOverrides = 0;
  const recipeOverrides = new Map<ItemId, RecipeId>();
  for (const [itemId, recipeId] of plan.recipeOverrides) {
    if (availableRecipeIds.has(recipeId)) recipeOverrides.set(itemId, recipeId);
    else removedOverrides++;
  }

  // Keep a manual raw if the item is producible, is a regional raw (the
  // pin is redundant but harmless), or is importable here (hand-feeding
  // it frees the route for another item — symmetric with targets above).
  // Drop it only when the item is completely unsourceable in this
  // region, where the pin overrides nothing.
  let removedRaws = 0;
  const manualRawMaterials = new Set<ItemId>();
  for (const itemId of plan.manualRawMaterials) {
    if (
      reachableProducibleItems.has(itemId) ||
      regionRawMaterials.has(itemId) ||
      metastorageImportableItems.has(itemId)
    ) {
      manualRawMaterials.add(itemId);
    } else {
      removedRaws++;
    }
  }

  const total = removedTargets + removedOverrides + removedRaws;
  if (total === 0) return null;

  return {
    targets,
    recipeOverrides,
    manualRawMaterials,
    removedTargets,
    removedOverrides,
    removedRaws,
    total,
  };
}
