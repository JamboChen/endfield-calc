import type { ProductionDependencyGraph } from "@/types";

/**
 * Find the first output item of a recipe node in the production graph.
 */
export function getRecipeOutputItemId(
  plan: ProductionDependencyGraph,
  recipeId: string,
): string | undefined {
  return plan.edges.find((e) => e.from === recipeId)?.to;
}

/**
 * Find the first input item of a recipe node (e.g., for disposal/sink recipes).
 */
export function getRecipeInputItemId(
  plan: ProductionDependencyGraph,
  recipeId: string,
): string | undefined {
  return plan.edges.find((e) => e.to === recipeId)?.from;
}

/**
 * Find the non-disposal producer recipe for an item.
 */
export function getNonDisposalProducerRecipeId(
  plan: ProductionDependencyGraph,
  itemId: string,
): string | undefined {
  return plan.edges.find((e) => {
    if (e.to !== itemId) return false;
    const n = plan.nodes.get(e.from);
    return n?.type === "recipe" && !n.isDisposal;
  })?.from;
}
