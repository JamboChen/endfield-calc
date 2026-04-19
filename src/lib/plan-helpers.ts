import type { ProductionDependencyGraph, ProductionGraphNode } from "@/types";
import { calcRate } from "@/lib/utils";

/**
 * Returns ALL output item IDs for a recipe node in the production graph.
 */
export function getRecipeOutputItemIds(
  plan: ProductionDependencyGraph,
  recipeId: string,
): string[] {
  return plan.edges
    .filter(
      (e) => e.from === recipeId && plan.nodes.get(e.to)?.type === "item",
    )
    .map((e) => e.to);
}

/**
 * Returns the primary output item of a recipe node. For multi-output recipes,
 * selects deterministically:
 *   1. Target items (the recipe's main purpose from the user's perspective)
 *   2. Items consumed by non-disposal recipes (active production chain items)
 *   3. First output alphabetically (stable fallback)
 */
export function getRecipeOutputItemId(
  plan: ProductionDependencyGraph,
  recipeId: string,
): string | undefined {
  const outputIds = getRecipeOutputItemIds(plan, recipeId);
  if (outputIds.length <= 1) return outputIds[0];

  // Prefer target items
  const targetOutput = outputIds.find((id) => {
    const node = plan.nodes.get(id);
    return node?.type === "item" && node.isTarget;
  });
  if (targetOutput) return targetOutput;

  // Prefer items consumed by non-disposal recipes (real production chain items)
  const consumedOutput = outputIds.find((id) =>
    plan.edges.some((e) => {
      if (e.from !== id) return false;
      const consumer = plan.nodes.get(e.to);
      return consumer?.type === "recipe" && !consumer.isDisposal;
    }),
  );
  if (consumedOutput) return consumedOutput;

  // Stable fallback: alphabetical
  return outputIds.sort()[0];
}

/**
 * Determines whether a recipe is a "terminal target" — meaning it can be
 * folded into a TargetSinkNode instead of being shown as a standalone node.
 *
 * A recipe is terminal only if:
 *   1. Its primary output is a target item with no non-disposal consumers
 *   2. None of its OTHER outputs are consumed by non-disposal recipes
 *
 * This ensures multi-output recipes that participate in cycles (e.g.,
 * pool_xiranite_poly_1 producing both xiranite_poly and liquid_sewage)
 * are never folded away — they must remain as visible nodes because
 * other recipes depend on their secondary outputs.
 */
export function isRecipeTerminal(
  plan: ProductionDependencyGraph,
  recipeId: string,
): boolean {
  const primaryOutputId = getRecipeOutputItemId(plan, recipeId);
  if (!primaryOutputId) return false;

  const primaryNode = plan.nodes.get(primaryOutputId);
  if (!primaryNode || primaryNode.type !== "item" || !primaryNode.isTarget)
    return false;

  // Primary output must not be consumed by any non-disposal recipe
  const primaryIsConsumed = plan.edges.some((e) => {
    if (e.from !== primaryOutputId) return false;
    const consumer = plan.nodes.get(e.to);
    return consumer?.type === "recipe" && !consumer.isDisposal;
  });
  if (primaryIsConsumed) return false;

  // No secondary output should be consumed by any recipe (including disposal).
  // Disposal-consumed secondaries must keep the recipe node visible so the
  // disposal edge has a source — otherwise the disposal sink ends up orphaned.
  const allOutputIds = getRecipeOutputItemIds(plan, recipeId);
  const hasSecondaryConsumer = allOutputIds.some((outId) => {
    if (outId === primaryOutputId) return false;
    return plan.edges.some((e) => {
      if (e.from !== outId) return false;
      return plan.nodes.get(e.to)?.type === "recipe";
    });
  });

  return !hasSecondaryConsumer;
}

/**
 * Returns all non-disposal recipes that produce an item, with their
 * individual production rates. Used to split flow across multiple producers
 * (e.g., liquid_sewage produced by both pool_xiranite_poly_1 and furnace).
 */
export function getItemProducers(
  plan: ProductionDependencyGraph,
  itemId: string,
): { recipeId: string; rate: number }[] {
  const itemNode = plan.nodes.get(itemId);
  if (itemNode?.type === "item" && itemNode.isRawMaterial) return [];

  return plan.edges
    .filter((e) => {
      if (e.to !== itemId) return false;
      const n = plan.nodes.get(e.from);
      return n?.type === "recipe" && !n.isDisposal;
    })
    .map((e) => {
      const node = plan.nodes.get(e.from) as Extract<
        ProductionGraphNode,
        { type: "recipe" }
      >;
      const out = node.recipe.outputs.find((o) => o.itemId === itemId);
      const rate = out
        ? calcRate(out.amount, node.recipe.craftingTime) * node.facilityCount
        : 0;
      return { recipeId: e.from, rate };
    })
    .filter((p) => p.rate > 0);
}

/**
 * Computes a greedy allocation of producer outputs to consumers, minimizing
 * the number of edges (pipe/belt connections) in the visualization.
 *
 * Instead of splitting each producer proportionally across all consumers,
 * assigns whole producer outputs to consumers first. A producer is only
 * split across consumers when its output exceeds one consumer's demand or
 * doesn't fully cover it.
 *
 * Producers are sorted by rate (descending) so large producers are assigned
 * first, maximizing the chance of whole-producer assignments.
 *
 * @returns consumerEdges — edges from producers to consumers with allocated rates
 * @returns remainingByProducer — leftover production per producer (for disposal)
 */
export function computeGreedyAllocation(
  producers: { recipeId: string; rate: number }[],
  consumers: { consumerId: string; demand: number }[],
): {
  consumerEdges: {
    producerRecipeId: string;
    consumerId: string;
    rate: number;
  }[];
  remainingByProducer: Map<string, number>;
} {
  // Sort producers by rate descending — assign large producers first
  const sorted = [...producers].sort((a, b) => b.rate - a.rate);
  const remaining = new Map(sorted.map((p) => [p.recipeId, p.rate]));

  const consumerEdges: {
    producerRecipeId: string;
    consumerId: string;
    rate: number;
  }[] = [];

  for (const consumer of consumers) {
    let remainingDemand = consumer.demand;
    for (const producer of sorted) {
      if (remainingDemand <= 0.001) break;
      const available = remaining.get(producer.recipeId) || 0;
      if (available <= 0.001) continue;

      const allocated = Math.min(available, remainingDemand);
      remaining.set(producer.recipeId, available - allocated);
      remainingDemand -= allocated;

      consumerEdges.push({
        producerRecipeId: producer.recipeId,
        consumerId: consumer.consumerId,
        rate: allocated,
      });
    }
  }

  return { consumerEdges, remainingByProducer: remaining };
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

