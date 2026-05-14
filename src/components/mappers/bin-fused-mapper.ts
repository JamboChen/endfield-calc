/**
 * Bin-fused merged-view mapper.
 *
 * Emits one flow node per `CrucibleBin` (instead of per recipe) so that
 * multi-formula buildings (Reactor / Expanded Crucible groups) appear as
 * a single card with the bin's external I/O. Internal flows between
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
  ProductionGraphNode,
  CrucibleBin,
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
import { calcRate } from "@/lib/utils";
import { buildBinActivitySums, pickBinHeadlineOutput } from "@/lib/plan-helpers";
import { assertFlowIntegrity } from "./flow-assertions";

/**
 * Map a production plan's `crucibleBins` to React Flow nodes/edges with
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
  const isDisposalBin = (bin: CrucibleBin): boolean => {
    if (bin.recipeIds.length !== 1) return false;
    const recipe = recipeById.get(bin.recipeIds[0]);
    return !!recipe && recipe.outputs.length === 0;
  };

  // Bin classification.
  const productionBins: CrucibleBin[] = [];
  const disposalBins: CrucibleBin[] = [];
  for (const bin of plan.crucibleBins) {
    if (isDisposalBin(bin)) disposalBins.push(bin);
    else productionBins.push(bin);
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
  type ProducerEntry = { binId: string; rate: number };
  type ConsumerEntry = { binId: string; rate: number };
  const producersByItem = new Map<ItemId, ProducerEntry[]>();
  const consumersByItem = new Map<ItemId, ConsumerEntry[]>();
  for (const bin of productionBins) {
    for (const out of bin.externalOutputs) {
      const outNode = plan.nodes.get(out.itemId);
      if (outNode?.type === "item" && outNode.isRawMaterial) continue;
      const arr = producersByItem.get(out.itemId) ?? [];
      arr.push({ binId: bin.id, rate: out.rate });
      producersByItem.set(out.itemId, arr);
    }
    for (const inp of bin.externalInputs) {
      const arr = consumersByItem.get(inp.itemId) ?? [];
      arr.push({ binId: bin.id, rate: inp.rate });
      consumersByItem.set(inp.itemId, arr);
    }
  }
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
  // Target sinks consume target items.
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "item") return;
    if (!node.isTarget || node.isRawMaterial) return;
    const userTargetRate = targetRates?.get(node.itemId) ?? node.productionRate;
    if (userTargetRate <= 0.001) return;
    const arr = consumersByItem.get(node.itemId as ItemId) ?? [];
    arr.push({ binId: createTargetSinkId(nodeId), rate: userTargetRate });
    consumersByItem.set(node.itemId as ItemId, arr);
  });

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
        if (need <= 0.001) break;
        const avail = remaining.get(producer.binId) ?? 0;
        if (avail <= 0.001) continue;
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

    // Find producer bins for this target.
    const producers = producersByItem.get(node.itemId as ItemId) ?? [];

    // Embed recipe info when the target has exactly one producer that
    // is itself a singleton (sole recipe in the bin) — keeps the
    // existing "terminal target" pattern.
    let embedded: {
      facility: Facility | null;
      facilityCount: number;
      recipe: Recipe | null;
    } | undefined;
    if (producers.length === 1) {
      const bin = plan.crucibleBins.find((b) => b.id === producers[0].binId);
      if (bin && bin.recipeIds.length === 1) {
        const recipe = recipeById.get(bin.recipeIds[0]);
        const facility = facilityById.get(bin.facilityId);
        if (recipe && facility) {
          // Only embed if the bin emits no separate flow node for itself
          // (terminal target: bin's only output is this target).
          const isTerminal = bin.externalOutputs.length === 1;
          if (isTerminal) {
            embedded = { facility, facilityCount: bin.buildingCount, recipe };
          }
        }
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
    if (disposalRate <= 0.001) continue;
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

  // Emit edges from the greedy allocation. Skip edges whose producer
  // bin or consumer didn't make it into the node set (defensive).
  const emittedNodeIds = new Set([
    ...flowNodes.map((n) => n.id),
    ...targetSinkNodes.map((n) => n.id),
    ...disposalSinkNodes.map((n) => n.id),
  ]);
  for (const [itemId, edges] of allocated.entries()) {
    const sourceItem = itemById.get(itemId);
    for (const edge of edges) {
      if (edge.rate <= 0.001) continue;
      // Skip if either endpoint is missing (would dangle).
      if (!emittedNodeIds.has(edge.producerId)) continue;
      // For raw materials we may need to emit a pickup node here.
      // (Already handled below in the raw-input pass.)
      // For consumer (target/disposal/bin), skip if not emitted.
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
      if (consumer.rate <= 0.001) continue;
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

  const isDisposalBin = (bin: CrucibleBin): boolean => {
    if (bin.recipeIds.length !== 1) return false;
    const recipe = recipeById.get(bin.recipeIds[0]);
    return !!recipe && recipe.outputs.length === 0;
  };

  // Building instance id: `${bin.id}-bldg${idx}`. We avoid the existing
  // `${recipeId}-f${idx}` convention because bin-instance != recipe-instance
  // and we don't want flow-utils' position-based regex to misinterpret.
  const buildingInstanceId = (binId: string, idx: number): string =>
    `${binId}-bldg${idx}`;

  // Build per-bin instance count and per-instance rates.
  type BinInstance = {
    bin: CrucibleBin;
    instanceIdx: number;
    instanceCount: number;
    perBuildingInputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }>;
    perBuildingOutputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }>;
    isPartialLoad: boolean;
  };

  const productionInstances: BinInstance[] = [];
  const disposalBins: CrucibleBin[] = [];
  for (const bin of plan.crucibleBins) {
    if (isDisposalBin(bin)) {
      disposalBins.push(bin);
      continue;
    }
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
  type Entry = { instanceId: string; rate: number };
  const producersByItem = new Map<ItemId, Entry[]>();
  const consumersByItem = new Map<ItemId, Entry[]>();
  for (const inst of productionInstances) {
    const id = buildingInstanceId(inst.bin.id, inst.instanceIdx);
    for (const out of inst.perBuildingOutputs) {
      if (out.rate <= 0.001) continue;
      const outNode = plan.nodes.get(out.itemId);
      if (outNode?.type === "item" && outNode.isRawMaterial) continue;
      const arr = producersByItem.get(out.itemId) ?? [];
      arr.push({ instanceId: id, rate: out.rate });
      producersByItem.set(out.itemId, arr);
    }
    for (const inp of inst.perBuildingInputs) {
      if (inp.rate <= 0.001) continue;
      const arr = consumersByItem.get(inp.itemId) ?? [];
      arr.push({ instanceId: id, rate: inp.rate });
      consumersByItem.set(inp.itemId, arr);
    }
  }
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
  // Target sinks consume target items.
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "item") return;
    if (!node.isTarget || node.isRawMaterial) return;
    const userTargetRate = targetRates?.get(node.itemId) ?? node.productionRate;
    if (userTargetRate <= 0.001) return;
    const arr = consumersByItem.get(node.itemId as ItemId) ?? [];
    arr.push({ instanceId: createTargetSinkId(nodeId), rate: userTargetRate });
    consumersByItem.set(node.itemId as ItemId, arr);
  });

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
        if (need <= 0.001) break;
        const avail = remaining.get(producer.instanceId) ?? 0;
        if (avail <= 0.001) continue;
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

  // Emit production-instance nodes.
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
          isDirectTarget: false,
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
    if (totalDemand <= 0.001) continue;
    const item = itemById.get(itemId);
    if (!item) continue;
    const transportCap = item.isLiquid ? 120 : 30;
    const pickupCount = Math.max(1, Math.ceil(totalDemand / transportCap));
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
    targetSinkNodes.push(
      createTargetSinkNode(
        targetSinkId,
        node.item,
        userTargetRate,
        items,
        facilities,
        undefined,
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
    if (disposalRate <= 0.001) continue;
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
  for (const [itemId, edges] of allocated.entries()) {
    const sourceItem = itemById.get(itemId);
    for (const edge of edges) {
      if (edge.rate <= 0.001) continue;
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

  // Raw-material → consumer edges (one per consumer-instance, drawn
  // from sequential pickup-point capacity).
  for (const [itemId, consumers] of consumersByItem.entries()) {
    if (producersByItem.has(itemId)) continue;
    const node = plan.nodes.get(itemId);
    if (node?.type !== "item" || !node.isRawMaterial) continue;
    const item = itemById.get(itemId);
    if (!item) continue;
    const transportCap = item.isLiquid ? 120 : 30;
    // Track remaining capacity per pickup point.
    const totalDemand = consumers.reduce((s, c) => s + c.rate, 0);
    const pickupCount = Math.max(1, Math.ceil(totalDemand / transportCap));
    const pickupRemaining: number[] = [];
    for (let i = 0; i < pickupCount; i++) {
      pickupRemaining.push(
        Math.min(transportCap, totalDemand - i * transportCap),
      );
    }
    let pickupIdx = 0;
    for (const consumer of consumers) {
      if (consumer.rate <= 0.001) continue;
      if (!emittedNodeIds.has(consumer.instanceId)) continue;
      let need = consumer.rate;
      while (need > 0.001 && pickupIdx < pickupCount) {
        const avail = pickupRemaining[pickupIdx];
        if (avail <= 0.001) {
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
        if (avail - take <= 0.001) pickupIdx += 1;
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

// CrucibleBin & ProductionGraphNode imports are referenced via type
// annotations above; intentionally exported via `void` to silence
// unused-import lints when tree-shaking infers them.
void ({} as ProductionGraphNode);
void ({} as CrucibleBin);
