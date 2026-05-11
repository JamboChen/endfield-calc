import type {
  ProductionDependencyGraph,
  ProductionGraphNode,
  ProductionNode,
  CrucibleBin,
  ItemId,
  RecipeId,
  Item,
  Recipe,
} from "@/types";
import { calcRate } from "@/lib/utils";

/**
 * Byproduct entry as rendered by `CustomProductionNode`. `amount` is the
 * recipe-level per-cycle amount when sourced from a recipe's outputs;
 * meaningless (0) when sourced from a bin's aggregated `externalOutputs`,
 * since the rate is already pre-scaled.
 */
export type NodeByproduct = {
  item: Item;
  amount: number;
  rate: number;
};

/**
 * Compute the list of byproduct outputs for a production node's card.
 *
 * Two paths based on whether the node is part of a grouped bin:
 *
 *   1. **Grouped bin** (`node.bin?.isGrouped === true`): use ONLY the
 *      bin's `binExtraOutputs` (its `externalOutputs` minus the
 *      headline). Items that are internally balanced inside the bin
 *      (e.g. Sewage in a `{LX, XE, X}` Xircon bin where X produces it
 *      and XE consumes it 1:1) live in `bin.internalItems` and are
 *      correctly absent from `externalOutputs` — using this path
 *      prevents the headline recipe's natural byproducts from
 *      reintroducing them.
 *
 *   2. **Singleton bin / per-recipe view** (no `node.bin`): use the
 *      headline recipe's secondary outputs. For singletons the recipe
 *      cannot internally cancel anything (only one recipe), so its
 *      raw outputs match the bin's externals. For per-recipe view
 *      there is no bin abstraction at all; the recipe's outputs are
 *      the authoritative byproduct source.
 *
 * Both paths dedupe against the headline (`node.item.id`) and against
 * each other so an item never appears twice.
 *
 * The two paths are NEVER combined: combining them was the root cause
 * of the "Sewage shown as 60/min external on the Xircon bin" display
 * bug — the headline recipe's outputs would re-add Sewage that the
 * bin had correctly classified as internal.
 */
export function computeNodeByproducts(
  node: ProductionNode,
  items: Item[],
): NodeByproduct[] {
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const seen = new Set<string>([node.item.id]);
  const result: NodeByproduct[] = [];

  // Grouped bin: bin.externalOutputs is authoritative; recipe-level
  // byproducts would re-introduce internally-balanced items.
  if (node.bin?.isGrouped) {
    for (const io of node.binExtraOutputs ?? []) {
      if (seen.has(io.itemId)) continue;
      const item = itemById.get(io.itemId);
      if (!item) continue;
      seen.add(io.itemId);
      result.push({ item, amount: 0, rate: io.rate });
    }
    return result;
  }

  // Singleton bin or per-recipe view: recipe.outputs is authoritative.
  // Byproduct rate is derived from primary output's rate via the cycle
  // ratio (byproduct.amount / primary.amount × headline targetRate); if
  // no primary match exists (defensive — recipe with no output matching
  // node.item.id), fall back to per-facility rate.
  const recipe = node.recipe;
  if (recipe && recipe.outputs.length > 1) {
    const primaryOutput = recipe.outputs.find(
      (p) => p.itemId === node.item.id,
    );
    for (const o of recipe.outputs) {
      if (o.itemId === node.item.id) continue;
      if (seen.has(o.itemId)) continue;
      const item = itemById.get(o.itemId);
      if (!item) continue;
      const rate = primaryOutput
        ? (o.amount / primaryOutput.amount) * node.targetRate
        : calcRate(o.amount, recipe.craftingTime) * node.facilityCount;
      seen.add(o.itemId);
      result.push({ item, amount: o.amount, rate });
    }
  }

  return result;
}

/**
 * Pick the bin's "headline" external output — the one displayed as the
 * card's primary item. Used by the bin-fusion view when a multi-formula
 * building has several external outputs and one of them must be chosen
 * for the prominent slot. Other external outputs become byproducts.
 *
 * Heuristic priority (deterministic):
 *   1. Items the user explicitly targeted.
 *   2. Highest item tier (more refined items take precedence).
 *   3. Solid items over liquids (solids are usually the "products";
 *      liquids tend to be intermediates or byproducts).
 *   4. Alphabetical itemId (stable tiebreak).
 *
 * Returns the headline `itemId` plus the bin recipe whose primary
 * output equals that item — or `null` if the bin has no external
 * outputs (degenerate case; pure consumer bin).
 */
export function pickBinHeadlineOutput(
  bin: CrucibleBin,
  items: Item[],
  recipes: Recipe[],
  targetItemIds: Set<ItemId>,
): { itemId: ItemId; recipeId: RecipeId } | null {
  if (bin.externalOutputs.length === 0) return null;

  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const recipeById = new Map(recipes.map((r) => [r.id, r] as const));

  // Score each output: lower score = higher priority.
  // Lex tuple: (isTarget desc, tier desc, isSolid desc, itemId asc).
  const scored = bin.externalOutputs.map((out) => {
    const item = itemById.get(out.itemId);
    return {
      itemId: out.itemId,
      isTarget: targetItemIds.has(out.itemId) ? 0 : 1,
      negTier: item ? -item.tier : 0,
      isLiquid: item?.isLiquid ? 1 : 0,
    };
  });
  scored.sort((a, b) => {
    if (a.isTarget !== b.isTarget) return a.isTarget - b.isTarget;
    if (a.negTier !== b.negTier) return a.negTier - b.negTier;
    if (a.isLiquid !== b.isLiquid) return a.isLiquid - b.isLiquid;
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
  });
  const headlineItemId = scored[0].itemId;

  // Find the bin recipe whose primary output is this item. Use
  // `getRecipeOutputItemId` semantics (same heuristic the rest of the
  // app uses for recipe primary-output selection) to handle multi-output
  // recipes deterministically.
  for (const rid of bin.recipeIds) {
    const recipe = recipeById.get(rid);
    if (!recipe) continue;
    if (recipe.outputs.some((o) => o.itemId === headlineItemId)) {
      return { itemId: headlineItemId, recipeId: rid };
    }
  }

  // Fallback: no recipe in the bin produces the headline item (would
  // indicate a data-layer bug — bin.externalOutputs is derived from the
  // bin's recipes). Return the first recipe id so callers don't crash.
  return { itemId: headlineItemId, recipeId: bin.recipeIds[0] };
}

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

