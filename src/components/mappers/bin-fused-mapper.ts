/**
 * Bin-fused merged-view mapper.
 *
 * Emits one flow node per `Bin` (instead of per recipe) so that
 * multi-formula buildings appear as a single card with the bin's
 * external I/O. Internal flows between
 * co-located recipes are hidden (no edges).
 *
 * For singletons (1 formula per bin, the common case), the output is
 * visually equivalent to the per-recipe merged-mapper: one card per
 * recipe with primary output + byproducts. Only grouped bins look
 * different — they have a "+N more" badge and show all the bin's
 * external outputs as the card's outputs (one as headline, others as
 * byproducts).
 *
 * The per-recipe mapper (`mapPlanToFlowMerged`) remains the fallback
 * when the user toggles "Show recipes" in Recipe View.
 */

import type { Edge } from "@xyflow/react";
import type {
  Item,
  ItemId,
  Recipe,
  Facility,
  ProductionDependencyGraph,
  Bin,
  FlowProductionNode,
  FlowTargetNode,
  FlowDisposalNode,
} from "@/types";
import {
  createEdge,
  createProductionFlowNode,
  createTargetSinkNode,
  createDisposalSinkNode,
} from "../flow/flow-utils";
import { createTargetSinkId, createRawMaterialId } from "@/lib/node-keys";
import { calcRate, getTransportCapacity } from "@/lib/utils";
import { MIN_VISIBLE_RATE_PER_MIN } from "@/lib/flow-thresholds";
import { buildBinActivitySums, pickBinHeadlineOutput } from "@/lib/plan-helpers";
import { assertFlowIntegrity } from "./flow-assertions";

/**
 * Map a production plan's `bins` to React Flow nodes/edges with
 * one node per bin (bin-fused view). Suitable for merged Recipe View
 * when the "Show buildings" toggle is on (default).
 */
export function mapPlanToFlowBinFused(
  plan: ProductionDependencyGraph,
  items: Item[],
  recipes: Recipe[],
  facilities: Facility[],
  targetRates?: Map<ItemId, number>,
  ceilMode = false,
): {
  nodes: (FlowProductionNode | FlowTargetNode | FlowDisposalNode)[];
  edges: Edge[];
} {
  const flowNodes: FlowProductionNode[] = [];
  const targetSinkNodes: FlowTargetNode[] = [];
  const disposalSinkNodes: FlowDisposalNode[] = [];
  const flowEdges: Edge[] = [];
  let edgeIdCounter = 0;

  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const recipeById = new Map(recipes.map((r) => [r.id, r] as const));
  const facilityById = new Map(facilities.map((f) => [f.id, f] as const));
  const targetItemIds = new Set(plan.targets);

  // Skip disposal bins from regular production-node emission; they
  // become disposal sink nodes below.
  const isDisposalBin = (bin: Bin): boolean => {
    if (bin.recipeIds.length !== 1) return false;
    const recipe = recipeById.get(bin.recipeIds[0]);
    return !!recipe && recipe.outputs.length === 0;
  };

  const productionBins: Bin[] = [];
  const disposalBins: Bin[] = [];
  for (const bin of plan.bins) {
    if (isDisposalBin(bin)) disposalBins.push(bin);
    else productionBins.push(bin);
  }

  // Identify "singleton-terminal" bins: bins whose sole purpose is to
  // produce a target item with no other consumers in the plan. These
  // are folded into the target sink's embedded productionInfo
  // (matching `merged-mapper.ts`' `isRecipeTerminal` behaviour) — the
  // bin's input edges route directly to the target sink so the
  // visualisation looks identical to bf=0 for simple A→B chains.
  //
  // Detection happens BEFORE building producer/consumer maps so the
  // bin→sink redirect is baked into map construction. The alternative
  // — building maps with skipped-bin entries that get retroactively
  // dropped — leaves phantom state in the data structures that several
  // isolated-node bugs traced back to.
  //
  // Conditions (all must hold):
  //   1. The bin hosts a single recipe (no grouping).
  //   2. The bin has exactly one external output.
  //   3. That output is a target item.
  //   4. The bin is the sole producer of the target (no other
  //      production bin lists this item in `externalOutputs`).
  //   5. The target's only consumer is its own target sink (no
  //      production bin's `externalInputs` lists it, no disposal
  //      bin's recipe consumes it).
  //
  // Condition 5 is stricter than `isRecipeTerminal` (which permits
  // disposal of the primary output). The stricter rule keeps disposal
  // edges intact — a disposal sink consuming the primary would dangle
  // if we skipped the bin.
  const singletonTerminalBinIds = new Set<string>();
  const sinkByBinId = new Map<string, string>();
  const singletonTerminalBinByTargetItem = new Map<ItemId, Bin>();
  for (const bin of productionBins) {
    if (bin.recipeIds.length !== 1) continue;
    if (bin.externalOutputs.length !== 1) continue;
    const outputItemId = bin.externalOutputs[0].itemId;
    if (!targetItemIds.has(outputItemId)) continue;
    // Sole producer: no other production bin outputs this item.
    const otherProducer = productionBins.some(
      (b) =>
        b.id !== bin.id &&
        b.externalOutputs.some((o) => o.itemId === outputItemId),
    );
    if (otherProducer) continue;
    // No production-bin consumer.
    const productionConsumer = productionBins.some((b) =>
      b.externalInputs.some((i) => i.itemId === outputItemId),
    );
    if (productionConsumer) continue;
    // No disposal-bin consumer.
    const disposalConsumer = disposalBins.some((b) => {
      const r = recipeById.get(b.recipeIds[0]);
      return r?.inputs.some((i) => i.itemId === outputItemId) ?? false;
    });
    if (disposalConsumer) continue;
    singletonTerminalBinIds.add(bin.id);
    sinkByBinId.set(bin.id, createTargetSinkId(outputItemId));
    singletonTerminalBinByTargetItem.set(outputItemId, bin);
  }

  // Per-item producer-bin and consumer-bin lookups built from the bins'
  // external I/O. A bin appears as a producer for each item in its
  // externalOutputs and as a consumer for each item in its
  // externalInputs.
  //
  // Raw materials are deliberately NOT registered as producers even when
  // a bin produces them as a byproduct (e.g. Liquid Purifier outputs
  // Liquid Water). Reason: raw items are conceptually pickup-sourced; the
  // merged-mapper (bf=0) makes the same call via `getItemProducers`
  // returning [] for raw items, ensuring a raw-material pickup node is
  // emitted regardless of byproduct producers. Mirroring that here keeps
  // bf=1 visually consistent with bf=0 — the byproduct still appears on
  // the producing bin's card (via `bin.externalOutputs` →
  // `binExtraOutputs` → `computeNodeByproducts`), but no edge is drawn
  // from it; consumer bins receive their raw input from the pickup node
  // emitted in the rawMaterialDemand loop below.
  //
  // Singleton-terminal bins (identified above) are EXCLUDED from
  // producer registration and have their consumer registrations
  // redirected to the target sink id. This bakes the merged-mapper's
  // terminal-recipe edge rerouting into map construction time so the
  // greedy allocator and edge emission don't need to know about the
  // skip.
  type ProducerEntry = { binId: string; rate: number };
  type ConsumerEntry = { binId: string; rate: number };
  const producersByItem = new Map<ItemId, ProducerEntry[]>();
  const consumersByItem = new Map<ItemId, ConsumerEntry[]>();
  for (const bin of productionBins) {
    const skipped = singletonTerminalBinIds.has(bin.id);
    // Skip producer registration for singleton-terminal bins: their
    // output → target-sink edge would be redundant with the embed.
    if (!skipped) {
      for (const out of bin.externalOutputs) {
        const outNode = plan.nodes.get(out.itemId);
        if (outNode?.type === "item" && outNode.isRawMaterial) continue;
        const arr = producersByItem.get(out.itemId) ?? [];
        arr.push({ binId: bin.id, rate: out.rate });
        producersByItem.set(out.itemId, arr);
      }
    }
    // Redirect consumer registration for singleton-terminal bins:
    // input items now have the target sink as consumer, so edges from
    // upstream producers land on the sink directly.
    const consumerBinId = sinkByBinId.get(bin.id) ?? bin.id;
    for (const inp of bin.externalInputs) {
      const arr = consumersByItem.get(inp.itemId) ?? [];
      arr.push({ binId: consumerBinId, rate: inp.rate });
      consumersByItem.set(inp.itemId, arr);
    }
  }
  // Target sinks consume target items. Registered BEFORE disposal bins
  // so the greedy allocator gives targets priority over disposal in
  // edge cases where producer output is split between them. Prevents
  // floating-point noise from leaving a target sink ε under-allocated
  // — disposal's surplus is implicit (whatever is left after targets,
  // consumers, and internal use).
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "item") return;
    if (!node.isTarget || node.isRawMaterial) return;
    const userTargetRate = targetRates?.get(node.itemId) ?? node.productionRate;
    if (userTargetRate <= MIN_VISIBLE_RATE_PER_MIN) return;
    const arr = consumersByItem.get(node.itemId as ItemId) ?? [];
    arr.push({ binId: createTargetSinkId(nodeId), rate: userTargetRate });
    consumersByItem.set(node.itemId as ItemId, arr);
  });
  // Disposal bins consume items too — register them as consumers so
  // producer bins route surplus to disposal correctly.
  for (const bin of disposalBins) {
    const recipe = recipeById.get(bin.recipeIds[0]);
    if (!recipe || recipe.inputs.length === 0) continue;
    const inp = recipe.inputs[0];
    const rate = calcRate(inp.amount, recipe.craftingTime) * bin.buildingCount;
    const arr = consumersByItem.get(inp.itemId) ?? [];
    // Disposal "consumer" id is the disposal sink node id.
    const disposalSinkId = `disposal-${bin.recipeIds[0]}`;
    arr.push({ binId: disposalSinkId, rate });
    consumersByItem.set(inp.itemId, arr);
  }

  // Raw-material pickup tracking. A raw material is an item with no
  // producing bin (any consumer's input that's not in producersByItem).
  const rawMaterialDemand = new Map<ItemId, number>();
  for (const [itemId, consumers] of consumersByItem.entries()) {
    if (producersByItem.has(itemId)) continue;
    const node = plan.nodes.get(itemId);
    if (node?.type !== "item" || !node.isRawMaterial) continue;
    rawMaterialDemand.set(
      itemId,
      consumers.reduce((s, c) => s + c.rate, 0),
    );
  }

  // Greedy producer→consumer allocation per item. Produces one edge
  // per (producer, consumer) pair with the allocated rate. Whole-
  // producer assignments minimise edge count vs. proportional split.
  type AllocEdge = { producerId: string; consumerId: string; rate: number };
  const allocated = new Map<ItemId, AllocEdge[]>();
  for (const [itemId, producers] of producersByItem.entries()) {
    const consumers = consumersByItem.get(itemId) ?? [];
    if (consumers.length === 0) continue;
    const sortedProducers = [...producers].sort((a, b) => b.rate - a.rate);
    const remaining = new Map(sortedProducers.map((p) => [p.binId, p.rate]));
    const out: AllocEdge[] = [];
    for (const consumer of consumers) {
      let need = consumer.rate;
      for (const producer of sortedProducers) {
        if (need <= MIN_VISIBLE_RATE_PER_MIN) break;
        const avail = remaining.get(producer.binId) ?? 0;
        if (avail <= MIN_VISIBLE_RATE_PER_MIN) continue;
        const take = Math.min(avail, need);
        remaining.set(producer.binId, avail - take);
        need -= take;
        out.push({
          producerId: producer.binId,
          consumerId: consumer.binId,
          rate: take,
        });
      }
    }
    allocated.set(itemId, out);
  }

  // Per-bin sum of recipe activities — used in ceilMode=OFF to show
  // mean activity on grouped bin cards instead of the integer
  // `bin.buildingCount`. Mirrors `aggregateBinTotals`' ceilMode=OFF
  // accounting so the card label matches the stats / table footer.
  const sumByBin = buildBinActivitySums(plan);

  // Emit production-bin nodes.
  for (const bin of productionBins) {
    if (singletonTerminalBinIds.has(bin.id)) continue;
    const headline = pickBinHeadlineOutput(bin, items, recipes, targetItemIds);
    const facility = facilityById.get(bin.facilityId);
    if (!facility) continue;
    if (!headline) continue; // pure consumer bin; skip.

    const headlineItem = itemById.get(headline.itemId);
    const headlineRecipe = recipeById.get(headline.recipeId);
    if (!headlineItem || !headlineRecipe) continue;

    const headlineRate =
      bin.externalOutputs.find((o) => o.itemId === headline.itemId)?.rate ?? 0;

    // For grouped bins, list the bin's other external outputs so the
    // card renders them as byproducts (covers items from sister
    // recipes that aren't on the headline recipe's outputs).
    const binExtraOutputs = bin.isGrouped
      ? bin.externalOutputs
          .filter((io) => io.itemId !== headline.itemId)
          .map((io) => ({
            itemId: io.itemId,
            rate: io.rate,
            isLiquid: io.isLiquid,
          }))
      : undefined;

    // Card-displayed building count:
    //   - ceilMode=ON: physical `bin.buildingCount` (integer for grouped
    //     bins, fractional for singletons on single-formula facilities).
    //   - ceilMode=OFF: mean of per-recipe activities (sum_activities /
    //     recipe_count). Reduces to `bin.buildingCount` for singletons;
    //     for grouped bins, surfaces partial-load info that the integer
    //     count would otherwise hide. Bounded above by `bin.buildingCount`
    //     so it never exceeds the ceilMode=ON value.
    const recipeCount = Math.max(1, bin.recipeIds.length);
    const sumActivities = sumByBin.get(bin.id) ?? bin.buildingCount;
    const facilityCount = ceilMode
      ? bin.buildingCount
      : sumActivities / recipeCount;

    flowNodes.push(
      createProductionFlowNode(
        bin.id,
        {
          item: headlineItem,
          targetRate: headlineRate,
          recipe: headlineRecipe,
          facility,
          facilityCount,
          isRawMaterial: false,
          isTarget: targetItemIds.has(headline.itemId),
          dependencies: [],
          binId: bin.id,
          binSisterRecipeIds: bin.recipeIds.filter(
            (rid) => rid !== headline.recipeId,
          ),
          binExtraOutputs,
          bin: bin.isGrouped ? bin : undefined,
        },
        items,
        facilities,
        ceilMode,
        {
          isDirectTarget: targetItemIds.has(headline.itemId),
          directTargetRate: targetItemIds.has(headline.itemId)
            ? (targetRates?.get(headline.itemId) ?? headlineRate)
            : undefined,
        },
      ),
    );
  }

  // Emit raw-material pickup nodes (one per distinct raw item).
  const emittedRawMaterials = new Set<ItemId>();
  const ensureRawMaterialNode = (itemId: ItemId): string => {
    const rawNodeId = createRawMaterialId(itemId);
    if (emittedRawMaterials.has(itemId)) return rawNodeId;
    emittedRawMaterials.add(itemId);
    const node = plan.nodes.get(itemId);
    if (node?.type !== "item") return rawNodeId;
    flowNodes.push(
      createProductionFlowNode(
        rawNodeId,
        {
          item: node.item,
          targetRate: rawMaterialDemand.get(itemId) ?? node.productionRate,
          recipe: null,
          facility: null,
          facilityCount: 0,
          isRawMaterial: true,
          isTarget: false,
          dependencies: [],
        },
        items,
        facilities,
        ceilMode,
        { isDirectTarget: false },
      ),
    );
    return rawNodeId;
  };

  // Emit target sink nodes.
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "item") return;
    if (!node.isTarget || node.isRawMaterial) return;
    const targetSinkId = createTargetSinkId(nodeId);
    const userTargetRate = targetRates?.get(node.itemId) ?? node.productionRate;
    // Mirror the consumer-registration guard above: zero-rate targets
    // have no incoming edges, so emitting a sink for them produces an
    // isolated node that trips assertFlowIntegrity in dev mode.
    if (userTargetRate <= MIN_VISIBLE_RATE_PER_MIN) return;

    // Embed recipe info when this target's producer is a singleton-
    // terminal bin — i.e. one we excluded from `producersByItem` and
    // from the bin-emission loop above. The embed becomes the target
    // sink's facility chip, matching `merged-mapper.ts`' terminal-recipe
    // collapse for bf=0 parity.
    let embedded: {
      facility: Facility | null;
      facilityCount: number;
      recipe: Recipe | null;
    } | undefined;
    const terminalBin = singletonTerminalBinByTargetItem.get(
      node.itemId as ItemId,
    );
    if (terminalBin) {
      const recipe = recipeById.get(terminalBin.recipeIds[0]);
      const facility = facilityById.get(terminalBin.facilityId);
      if (recipe && facility) {
        embedded = {
          facility,
          facilityCount: terminalBin.buildingCount,
          recipe,
        };
      }
    }

    targetSinkNodes.push(
      createTargetSinkNode(
        targetSinkId,
        node.item,
        userTargetRate,
        items,
        facilities,
        embedded,
        ceilMode,
      ),
    );
  });

  // Emit disposal sink nodes.
  for (const bin of disposalBins) {
    const recipe = recipeById.get(bin.recipeIds[0]);
    if (!recipe || recipe.inputs.length === 0) continue;
    const facility = facilityById.get(bin.facilityId);
    if (!facility) continue;
    const inp = recipe.inputs[0];
    const consumedItem = itemById.get(inp.itemId);
    if (!consumedItem) continue;
    const disposalRate =
      calcRate(inp.amount, recipe.craftingTime) * bin.buildingCount;
    if (disposalRate <= MIN_VISIBLE_RATE_PER_MIN) continue;
    disposalSinkNodes.push(
      createDisposalSinkNode(
        `disposal-${bin.recipeIds[0]}`,
        consumedItem,
        disposalRate,
        facility,
        bin.buildingCount,
        items,
        facilities,
        ceilMode,
      ),
    );
  }

  // Emit edges from the greedy allocation. Defensive endpoint check
  // filters dangling edges in case a producer or consumer was dropped.
  const emittedNodeIds = new Set([
    ...flowNodes.map((n) => n.id),
    ...targetSinkNodes.map((n) => n.id),
    ...disposalSinkNodes.map((n) => n.id),
  ]);
  for (const [itemId, edges] of allocated.entries()) {
    const sourceItem = itemById.get(itemId);
    for (const edge of edges) {
      if (edge.rate <= MIN_VISIBLE_RATE_PER_MIN) continue;
      if (!emittedNodeIds.has(edge.producerId)) continue;
      if (!emittedNodeIds.has(edge.consumerId)) continue;
      flowEdges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          edge.producerId,
          edge.consumerId,
          edge.rate,
          sourceItem,
          undefined,
          ceilMode,
        ),
      );
    }
  }

  // Raw-material edges: each consumer of a raw item gets an edge from a
  // pickup node. Consumers can be production bins (id = bin.id) or
  // disposal sinks (id = `disposal-...`).
  for (const [itemId, consumers] of consumersByItem.entries()) {
    if (producersByItem.has(itemId)) continue;
    const node = plan.nodes.get(itemId);
    if (node?.type !== "item" || !node.isRawMaterial) continue;
    const sourceItem = itemById.get(itemId);
    const rawNodeId = ensureRawMaterialNode(itemId);
    for (const consumer of consumers) {
      if (consumer.rate <= MIN_VISIBLE_RATE_PER_MIN) continue;
      if (!emittedNodeIds.has(consumer.binId)) continue;
      flowEdges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          rawNodeId,
          consumer.binId,
          consumer.rate,
          sourceItem,
          undefined,
          ceilMode,
        ),
      );
    }
  }

  const allNodes: (FlowProductionNode | FlowTargetNode | FlowDisposalNode)[] = [
    ...flowNodes,
    ...targetSinkNodes,
    ...disposalSinkNodes,
  ];
  assertFlowIntegrity("bin-fused-mapper", allNodes, flowEdges);
  return { nodes: allNodes, edges: flowEdges };
}

/**
 * Per-building bin-fused mapper for Facility View.
 *
 * Like `mapPlanToFlowBinFused` but emits `ceil(bin.buildingCount)` nodes
 * per bin — each representing one physical building running all the
 * bin's formulas. Per-building rates = bin's total rates ÷ buildingCount
 * (uniform distribution; the ILP guarantees integer building counts so
 * this is exact for grouped bins).
 *
 * Each per-building consumer gets its own edge from upstream producers,
 * matching the existing Facility View philosophy (per-instance fidelity).
 * Raw materials use pickup nodes sized by transport capacity.
 */
export function mapPlanToFlowBinFusedSeparated(
  plan: ProductionDependencyGraph,
  items: Item[],
  recipes: Recipe[],
  facilities: Facility[],
  targetRates?: Map<ItemId, number>,
  ceilMode = false,
): {
  nodes: (FlowProductionNode | FlowTargetNode | FlowDisposalNode)[];
  edges: Edge[];
} {
  const flowNodes: FlowProductionNode[] = [];
  const targetSinkNodes: FlowTargetNode[] = [];
  const disposalSinkNodes: FlowDisposalNode[] = [];
  const flowEdges: Edge[] = [];
  let edgeIdCounter = 0;

  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const recipeById = new Map(recipes.map((r) => [r.id, r] as const));
  const facilityById = new Map(facilities.map((f) => [f.id, f] as const));
  const targetItemIds = new Set(plan.targets);

  const isDisposalBin = (bin: Bin): boolean => {
    if (bin.recipeIds.length !== 1) return false;
    const recipe = recipeById.get(bin.recipeIds[0]);
    return !!recipe && recipe.outputs.length === 0;
  };

  // Building instance id: `${bin.id}-bldg${idx}`. We avoid the existing
  // `${recipeId}-f${idx}` convention because bin-instance != recipe-instance
  // and we don't want flow-utils' position-based regex to misinterpret.
  const buildingInstanceId = (binId: string, idx: number): string =>
    `${binId}-bldg${idx}`;

  // Cycle-pair set for backward-edge tagging. Built from
  // `plan.detectedCycles` (unresolved SCCs, even if LP-solved).
  //
  // Why tag at the mapper instead of relying solely on
  // `applyEdgeStyling`'s post-layout position check: ELK reads
  // `edge.data.direction === "backward"` in `layout.ts` and sets
  // `elk.layered.priority.direction` accordingly. Without the tag,
  // cycle edges get default priority and ELK's layered cycle breaking
  // picks edges to reverse via its internal heuristic; the resulting
  // node positions then differ from the legacy per-recipe Facility
  // View layout. The position-based fallback handles final styling
  // either way, but the node positions themselves diverge if we don't
  // feed ELK the semantic-cycle hint.
  const cyclePairs = new Set<string>();
  plan.detectedCycles.forEach((cycle) => {
    const recipeIds = cycle.cycleNodes
      .filter((cn) => cn.recipe !== null)
      .map((cn) => cn.recipe!.id);
    for (const a of recipeIds) {
      for (const b of recipeIds) {
        if (a !== b) cyclePairs.add(`${a}:${b}`);
      }
    }
  });

  // Extract bin id from a per-building instance id ("bin-xxx-bldg0"
  // → "bin-xxx") or from a target/disposal sink id (no match — returns
  // null and the caller treats the id as not-a-building).
  const binIdFromInstanceId = (instanceId: string): string | null => {
    const m = instanceId.match(/^(.+)-bldg\d+$/);
    return m ? m[1] : null;
  };

  // Determine if an edge between two building-instances crosses a
  // detected-cycle boundary. Either direction of an SCC pair counts as
  // backward (symmetric — both directions of a 2-recipe cycle get the
  // tag, ELK's GREEDY strategy picks which to reverse).
  const binsById = new Map<string, Bin>();
  for (const bin of plan.bins) binsById.set(bin.id, bin);
  const isCycleEdge = (
    producerInstanceId: string,
    consumerInstanceId: string,
  ): boolean => {
    if (cyclePairs.size === 0) return false;
    const producerBinId = binIdFromInstanceId(producerInstanceId);
    const consumerBinId = binIdFromInstanceId(consumerInstanceId);
    if (!producerBinId || !consumerBinId) return false;
    const producerBin = binsById.get(producerBinId);
    const consumerBin = binsById.get(consumerBinId);
    if (!producerBin || !consumerBin) return false;
    for (const pr of producerBin.recipeIds) {
      for (const cr of consumerBin.recipeIds) {
        if (cyclePairs.has(`${pr}:${cr}`)) return true;
      }
    }
    return false;
  };

  // Build per-bin instance count and per-instance rates.
  type BinInstance = {
    bin: Bin;
    instanceIdx: number;
    instanceCount: number;
    perBuildingInputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }>;
    perBuildingOutputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }>;
    isPartialLoad: boolean;
  };

  // Classify bins: production (recipes with outputs) vs disposal
  // (recipes with no outputs). Done up front so singleton-terminal
  // detection can use both sets.
  const productionBins: Bin[] = [];
  const disposalBins: Bin[] = [];
  for (const bin of plan.bins) {
    if (isDisposalBin(bin)) disposalBins.push(bin);
    else productionBins.push(bin);
  }

  // Identify "singleton-terminal" bins. Same 5 conditions as the
  // merged bin-fused mapper above (single recipe, single external
  // output, target item, sole producer, target sink is the sole
  // consumer), with one extra gate for Facility View:
  // `Math.max(1, Math.ceil(bin.buildingCount)) === 1`. Multi-building
  // targets fall through to per-building emission. Detection runs
  // before map build for the same reason as in the merged path —
  // baking the bin→sink redirect in avoids phantom-state bugs.
  const singletonTerminalBinIds = new Set<string>();
  const sinkByBinId = new Map<string, string>();
  const singletonTerminalBinByTargetItem = new Map<ItemId, Bin>();
  for (const bin of productionBins) {
    if (bin.recipeIds.length !== 1) continue;
    if (bin.externalOutputs.length !== 1) continue;
    if (Math.max(1, Math.ceil(bin.buildingCount)) !== 1) continue;
    const outputItemId = bin.externalOutputs[0].itemId;
    if (!targetItemIds.has(outputItemId)) continue;
    const otherProducer = productionBins.some(
      (b) =>
        b.id !== bin.id &&
        b.externalOutputs.some((o) => o.itemId === outputItemId),
    );
    if (otherProducer) continue;
    const productionConsumer = productionBins.some((b) =>
      b.externalInputs.some((i) => i.itemId === outputItemId),
    );
    if (productionConsumer) continue;
    const disposalConsumer = disposalBins.some((b) => {
      const r = recipeById.get(b.recipeIds[0]);
      return r?.inputs.some((i) => i.itemId === outputItemId) ?? false;
    });
    if (disposalConsumer) continue;
    singletonTerminalBinIds.add(bin.id);
    sinkByBinId.set(bin.id, createTargetSinkId(outputItemId));
    singletonTerminalBinByTargetItem.set(outputItemId, bin);
  }

  // Build per-bin instance count and per-instance rates. Singleton-
  // terminal bins are excluded from instance emission entirely — their
  // single building's data is rendered via the target sink's embed.
  const productionInstances: BinInstance[] = [];
  for (const bin of productionBins) {
    if (singletonTerminalBinIds.has(bin.id)) continue;
    const N = Math.max(1, Math.ceil(bin.buildingCount));
    // Per-building rates: total bin rate ÷ N. For integer buildingCount
    // (always true for grouped bins after Phase 3 ILP), this is exact.
    // For singletons with fractional facilityCount, the last instance is
    // partial-load (consistent with existing Facility View behaviour).
    const fullLoadFraction = Math.min(1, bin.buildingCount / N);
    const perBuildingInputsAvg = bin.externalInputs.map((io) => ({
      itemId: io.itemId,
      rate: (io.rate / bin.buildingCount) * fullLoadFraction,
      isLiquid: io.isLiquid,
    }));
    const perBuildingOutputsAvg = bin.externalOutputs.map((io) => ({
      itemId: io.itemId,
      rate: (io.rate / bin.buildingCount) * fullLoadFraction,
      isLiquid: io.isLiquid,
    }));
    for (let i = 0; i < N; i++) {
      // For fractional buildingCount, only the last instance may be
      // partial-load. Distribute the partial fraction to the last index.
      const isLastFractional = i === N - 1 && bin.buildingCount < N;
      const loadFraction = isLastFractional
        ? bin.buildingCount - (N - 1)
        : 1;
      const inputs = perBuildingInputsAvg.map((io) => ({
        itemId: io.itemId,
        rate: (io.rate / fullLoadFraction) * loadFraction,
        isLiquid: io.isLiquid,
      }));
      const outputs = perBuildingOutputsAvg.map((io) => ({
        itemId: io.itemId,
        rate: (io.rate / fullLoadFraction) * loadFraction,
        isLiquid: io.isLiquid,
      }));
      productionInstances.push({
        bin,
        instanceIdx: i,
        instanceCount: N,
        perBuildingInputs: inputs,
        perBuildingOutputs: outputs,
        isPartialLoad: loadFraction < 0.999,
      });
    }
  }

  // Producer/consumer lookups keyed by per-building instance id.
  // Raw materials are deliberately NOT registered as producers — see
  // the equivalent block in `mapPlanToFlowBinFused` above for the
  // rationale. The raw-pickup loop downstream emits pickup nodes for
  // raw items based on consumer demand, matching bf=0 behaviour.
  //
  // Singleton-terminal bins are absent from productionInstances (we
  // skipped them above), so they contribute no producer entries. For
  // their INPUT items, however, we still need consumer entries — and
  // those redirect to the target sink id so input edges land on the
  // sink directly, matching merged-mapper's terminal-recipe edge
  // rerouting.
  type Entry = { instanceId: string; rate: number };
  const producersByItem = new Map<ItemId, Entry[]>();
  const consumersByItem = new Map<ItemId, Entry[]>();
  for (const inst of productionInstances) {
    const id = buildingInstanceId(inst.bin.id, inst.instanceIdx);
    for (const out of inst.perBuildingOutputs) {
      if (out.rate <= MIN_VISIBLE_RATE_PER_MIN) continue;
      const outNode = plan.nodes.get(out.itemId);
      if (outNode?.type === "item" && outNode.isRawMaterial) continue;
      const arr = producersByItem.get(out.itemId) ?? [];
      arr.push({ instanceId: id, rate: out.rate });
      producersByItem.set(out.itemId, arr);
    }
    for (const inp of inst.perBuildingInputs) {
      if (inp.rate <= MIN_VISIBLE_RATE_PER_MIN) continue;
      const arr = consumersByItem.get(inp.itemId) ?? [];
      arr.push({ instanceId: id, rate: inp.rate });
      consumersByItem.set(inp.itemId, arr);
    }
  }
  // Add consumer entries for singleton-terminal bins' inputs, keyed by
  // their target sink id so upstream producer edges land on the sink.
  // Each skipped bin contributes its single building's worth of input
  // rate (N === 1 by the singleton-terminal detection gate).
  for (const bin of productionBins) {
    if (!singletonTerminalBinIds.has(bin.id)) continue;
    const sinkId = sinkByBinId.get(bin.id);
    if (!sinkId) continue;
    for (const inp of bin.externalInputs) {
      if (inp.rate <= MIN_VISIBLE_RATE_PER_MIN) continue;
      const arr = consumersByItem.get(inp.itemId) ?? [];
      arr.push({ instanceId: sinkId, rate: inp.rate });
      consumersByItem.set(inp.itemId, arr);
    }
  }
  // Target sinks consume target items. Registered BEFORE disposal so
  // greedy allocation gives targets priority. See the equivalent
  // ordering note in `mapPlanToFlowBinFused` above.
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "item") return;
    if (!node.isTarget || node.isRawMaterial) return;
    const userTargetRate = targetRates?.get(node.itemId) ?? node.productionRate;
    if (userTargetRate <= MIN_VISIBLE_RATE_PER_MIN) return;
    const arr = consumersByItem.get(node.itemId as ItemId) ?? [];
    arr.push({ instanceId: createTargetSinkId(nodeId), rate: userTargetRate });
    consumersByItem.set(node.itemId as ItemId, arr);
  });
  // Disposal bins consume items; register one disposal-sink consumer
  // per disposal bin (not per building, since disposal sinks aren't
  // visualised per-instance in the existing app).
  for (const bin of disposalBins) {
    const recipe = recipeById.get(bin.recipeIds[0]);
    if (!recipe || recipe.inputs.length === 0) continue;
    const inp = recipe.inputs[0];
    const rate = calcRate(inp.amount, recipe.craftingTime) * bin.buildingCount;
    const sinkId = `disposal-${bin.recipeIds[0]}`;
    const arr = consumersByItem.get(inp.itemId) ?? [];
    arr.push({ instanceId: sinkId, rate });
    consumersByItem.set(inp.itemId, arr);
  }

  // Greedy producer→consumer allocation per item, similar to merged.
  type AllocEdge = { producerId: string; consumerId: string; rate: number };
  const allocated = new Map<ItemId, AllocEdge[]>();
  for (const [itemId, producers] of producersByItem.entries()) {
    const consumers = consumersByItem.get(itemId) ?? [];
    if (consumers.length === 0) continue;
    const sortedProducers = [...producers].sort((a, b) => b.rate - a.rate);
    const remaining = new Map(sortedProducers.map((p) => [p.instanceId, p.rate]));
    const out: AllocEdge[] = [];
    for (const consumer of consumers) {
      let need = consumer.rate;
      for (const producer of sortedProducers) {
        if (need <= MIN_VISIBLE_RATE_PER_MIN) break;
        const avail = remaining.get(producer.instanceId) ?? 0;
        if (avail <= MIN_VISIBLE_RATE_PER_MIN) continue;
        const take = Math.min(avail, need);
        remaining.set(producer.instanceId, avail - take);
        need -= take;
        out.push({
          producerId: producer.instanceId,
          consumerId: consumer.instanceId,
          rate: take,
        });
      }
    }
    allocated.set(itemId, out);
  }

  // Emit production-instance nodes. (Singleton-terminal bins were
  // excluded from `productionInstances` upstream — no guard needed
  // here.)
  for (const inst of productionInstances) {
    const headline = pickBinHeadlineOutput(inst.bin, items, recipes, targetItemIds);
    const facility = facilityById.get(inst.bin.facilityId);
    if (!facility) continue;
    if (!headline) continue;

    const headlineItem = itemById.get(headline.itemId);
    const headlineRecipe = recipeById.get(headline.recipeId);
    if (!headlineItem || !headlineRecipe) continue;

    const headlineRate =
      inst.perBuildingOutputs.find((o) => o.itemId === headline.itemId)?.rate ?? 0;
    const id = buildingInstanceId(inst.bin.id, inst.instanceIdx);

    // Per-building extra outputs scaled to one building.
    const binExtraOutputs = inst.bin.isGrouped
      ? inst.perBuildingOutputs
          .filter((io) => io.itemId !== headline.itemId)
          .map((io) => ({
            itemId: io.itemId,
            rate: io.rate,
            isLiquid: io.isLiquid,
          }))
      : undefined;

    flowNodes.push(
      createProductionFlowNode(
        id,
        {
          item: headlineItem,
          targetRate: headlineRate,
          recipe: headlineRecipe,
          facility,
          facilityCount: 1,
          isRawMaterial: false,
          isTarget: targetItemIds.has(headline.itemId),
          dependencies: [],
          binId: inst.bin.id,
          binSisterRecipeIds: inst.bin.recipeIds.filter(
            (rid) => rid !== headline.recipeId,
          ),
          binExtraOutputs,
          bin: inst.bin.isGrouped ? inst.bin : undefined,
        },
        items,
        facilities,
        ceilMode,
        {
          facilityIndex: inst.instanceIdx,
          totalFacilities: inst.instanceCount,
          isPartialLoad: inst.isPartialLoad,
          // Per-building cards carrying a target headline get
          // `isDirectTarget: true` plus their per-building
          // `directTargetRate` so the amber Star ribbon renders.
          // Without this, no per-building card in Facility View shows
          // the target star — a regression noticed on Xircon Poly @
          // 60/min where the {LX, XE, X} bin's two buildings produce
          // the target but looked indistinguishable from non-target
          // buildings.
          isDirectTarget: targetItemIds.has(headline.itemId),
          directTargetRate: targetItemIds.has(headline.itemId)
            ? headlineRate
            : undefined,
        },
      ),
    );
  }

  // Emit pickup nodes for raw materials (transport-capacity-sized).
  const emittedRawNodes = new Set<string>();
  for (const [itemId, consumers] of consumersByItem.entries()) {
    if (producersByItem.has(itemId)) continue;
    const node = plan.nodes.get(itemId);
    if (node?.type !== "item" || !node.isRawMaterial) continue;
    const totalDemand = consumers.reduce((s, c) => s + c.rate, 0);
    if (totalDemand <= MIN_VISIBLE_RATE_PER_MIN) continue;
    const item = itemById.get(itemId);
    if (!item) continue;
    const transportCap = getTransportCapacity(item);
    // Subtract MIN_VISIBLE_RATE_PER_MIN before ceiling to avoid
    // emitting an extra empty pickup node from FP noise on totalDemand
    // (see allocator-side comment for the full rationale).
    const pickupCount = Math.max(
      1,
      Math.ceil((totalDemand - MIN_VISIBLE_RATE_PER_MIN) / transportCap),
    );
    for (let i = 0; i < pickupCount; i++) {
      const pickupId = `${createRawMaterialId(itemId)}-p${i}`;
      if (emittedRawNodes.has(pickupId)) continue;
      emittedRawNodes.add(pickupId);
      const capacity = Math.min(transportCap, totalDemand - i * transportCap);
      const isPartialLoad = capacity < transportCap * 0.999;
      flowNodes.push(
        createProductionFlowNode(
          pickupId,
          {
            item,
            targetRate: capacity,
            recipe: null,
            facility: null,
            facilityCount: 0,
            isRawMaterial: true,
            isTarget: false,
            dependencies: [],
          },
          items,
          facilities,
          ceilMode,
          {
            facilityIndex: i,
            totalFacilities: pickupCount,
            isPartialLoad,
            isDirectTarget: false,
          },
        ),
      );
    }
  }

  // Emit target sinks.
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "item") return;
    if (!node.isTarget || node.isRawMaterial) return;
    const targetSinkId = createTargetSinkId(nodeId);
    const userTargetRate = targetRates?.get(node.itemId) ?? node.productionRate;
    // Mirror the consumer-registration guard: zero-rate targets have no
    // incoming edges; emitting a sink for them produces an isolated
    // node that trips assertFlowIntegrity in dev mode.
    if (userTargetRate <= MIN_VISIBLE_RATE_PER_MIN) return;

    // Embed recipe info when this target's producer is a singleton-
    // terminal bin — i.e. one we excluded from productionInstances
    // upstream. The embed becomes the target sink's facility chip
    // (matches the singleton-terminal embed in the merged bin-fused
    // mapper above).
    let embedded: {
      facility: Facility | null;
      facilityCount: number;
      recipe: Recipe | null;
    } | undefined;
    const terminalBin = singletonTerminalBinByTargetItem.get(
      node.itemId as ItemId,
    );
    if (terminalBin) {
      const recipe = recipeById.get(terminalBin.recipeIds[0]);
      const facility = facilityById.get(terminalBin.facilityId);
      if (recipe && facility) {
        embedded = {
          facility,
          facilityCount: terminalBin.buildingCount,
          recipe,
        };
      }
    }

    targetSinkNodes.push(
      createTargetSinkNode(
        targetSinkId,
        node.item,
        userTargetRate,
        items,
        facilities,
        embedded,
        ceilMode,
      ),
    );
  });

  // Emit disposal sinks.
  for (const bin of disposalBins) {
    const recipe = recipeById.get(bin.recipeIds[0]);
    if (!recipe || recipe.inputs.length === 0) continue;
    const facility = facilityById.get(bin.facilityId);
    if (!facility) continue;
    const inp = recipe.inputs[0];
    const consumedItem = itemById.get(inp.itemId);
    if (!consumedItem) continue;
    const disposalRate =
      calcRate(inp.amount, recipe.craftingTime) * bin.buildingCount;
    if (disposalRate <= MIN_VISIBLE_RATE_PER_MIN) continue;
    disposalSinkNodes.push(
      createDisposalSinkNode(
        `disposal-${bin.recipeIds[0]}`,
        consumedItem,
        disposalRate,
        facility,
        bin.buildingCount,
        items,
        facilities,
        ceilMode,
      ),
    );
  }

  const emittedNodeIds = new Set([
    ...flowNodes.map((n) => n.id),
    ...targetSinkNodes.map((n) => n.id),
    ...disposalSinkNodes.map((n) => n.id),
  ]);

  // Bin → consumer edges (per-building, one per allocation entry).
  // Edges between building-instances of bins that participate in the
  // same detected cycle get `direction: "backward"` so ELK's layered
  // layout deprioritizes them during cycle breaking (see `layout.ts`),
  // preserving cycle node positioning across views.
  for (const [itemId, edges] of allocated.entries()) {
    const sourceItem = itemById.get(itemId);
    for (const edge of edges) {
      if (edge.rate <= MIN_VISIBLE_RATE_PER_MIN) continue;
      if (!emittedNodeIds.has(edge.producerId)) continue;
      if (!emittedNodeIds.has(edge.consumerId)) continue;
      const direction = isCycleEdge(edge.producerId, edge.consumerId)
        ? "backward"
        : undefined;
      flowEdges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          edge.producerId,
          edge.consumerId,
          edge.rate,
          sourceItem,
          direction,
          ceilMode,
        ),
      );
    }
  }

  // Raw-material → consumer edges (one per consumer-instance, drawn
  // from sequential pickup-point capacity).
  for (const [itemId, consumers] of consumersByItem.entries()) {
    if (producersByItem.has(itemId)) continue;
    const node = plan.nodes.get(itemId);
    if (node?.type !== "item" || !node.isRawMaterial) continue;
    const item = itemById.get(itemId);
    if (!item) continue;
    const transportCap = getTransportCapacity(item);
    // Track remaining capacity per pickup point.
    const totalDemand = consumers.reduce((s, c) => s + c.rate, 0);
    // Subtract MIN_VISIBLE_RATE_PER_MIN from totalDemand before ceiling
    // to avoid emitting an extra empty pickup node when totalDemand is
    // an exact multiple of transportCap plus FP noise (e.g.,
    // 480.0000001 / 120 rounds up to 5 instead of 4). The downstream
    // allocator skips pickups with capacity below this same threshold,
    // so any such sub-visible "p_N" would be isolated.
    const pickupCount = Math.max(
      1,
      Math.ceil((totalDemand - MIN_VISIBLE_RATE_PER_MIN) / transportCap),
    );
    const pickupRemaining: number[] = [];
    for (let i = 0; i < pickupCount; i++) {
      pickupRemaining.push(
        Math.min(transportCap, totalDemand - i * transportCap),
      );
    }
    let pickupIdx = 0;
    for (const consumer of consumers) {
      if (consumer.rate <= MIN_VISIBLE_RATE_PER_MIN) continue;
      if (!emittedNodeIds.has(consumer.instanceId)) continue;
      let need = consumer.rate;
      while (need > MIN_VISIBLE_RATE_PER_MIN && pickupIdx < pickupCount) {
        const avail = pickupRemaining[pickupIdx];
        if (avail <= MIN_VISIBLE_RATE_PER_MIN) {
          pickupIdx += 1;
          continue;
        }
        const take = Math.min(avail, need);
        pickupRemaining[pickupIdx] = avail - take;
        need -= take;
        const pickupId = `${createRawMaterialId(itemId)}-p${pickupIdx}`;
        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            pickupId,
            consumer.instanceId,
            take,
            item,
            undefined,
            ceilMode,
          ),
        );
        if (avail - take <= MIN_VISIBLE_RATE_PER_MIN) pickupIdx += 1;
      }
    }
  }

  const allNodes: (FlowProductionNode | FlowTargetNode | FlowDisposalNode)[] = [
    ...flowNodes,
    ...targetSinkNodes,
    ...disposalSinkNodes,
  ];
  assertFlowIntegrity("bin-fused-separated-mapper", allNodes, flowEdges);
  return { nodes: allNodes, edges: flowEdges };
}
