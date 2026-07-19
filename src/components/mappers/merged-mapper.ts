import type { Node, Edge } from "@xyflow/react";
import type {
  Item,
  ItemId,
  Recipe,
  RecipeId,
  Facility,
  PlanMetastorageImport,
  ProductionDependencyGraph,
  ProductionGraphNode,
  FlowNodeData,
  FlowProductionNode,
  FlowTargetNode,
  FlowDisposalNode,
  FlowPowerNode,
  FlowEnvNode,
} from "@/types";
import {
  createEdge,
  createProductionFlowNode,
  createTargetSinkNode,
  createDisposalSinkNode,
  createPowerSinkNode,
  createEnvSinkNode,
  envBuffedMachines,
  buildCatalystIntakeByNode,
  routeCatalystIntakeToTopHandle,
} from "../flow/flow-utils";
import {
  createMetastorageSourceId,
  createTargetSinkId,
  createRawMaterialId,
} from "@/lib/node-keys";
import { calcRate, getRawSourceRate } from "@/lib/utils";
import { rawMaterialSources } from "@/data";
import { MIN_VISIBLE_RATE_PER_MIN } from "@/lib/flow-thresholds";
import { getRecipeOutputItemId, getRecipeInputItemId, getItemProducers, isRecipeTerminal, computeTransportAllocation } from "@/lib/plan-helpers";
import { assertFlowIntegrity } from "./flow-assertions";

/**
 * Vent/mine draw of a raw item node: a **producible raw** (Xiragen et al.)
 * carries `rawSupplyRate` = the mined portion only (its total
 * `productionRate` also includes the crafted portion), so pickup sizing
 * must use it. Ordinary raws leave `rawSupplyRate` undefined ⇒ the full
 * net `productionRate` is the draw.
 */
function rawDraw(node: {
  productionRate: number;
  rawSupplyRate?: number;
}): number {
  return node.rawSupplyRate ?? node.productionRate;
}

/**
 * Maps a ProductionDependencyGraph to React Flow nodes and edges in merged mode.
 */
export function mapPlanToFlowMerged(
  plan: ProductionDependencyGraph,
  items: Item[],
  facilities: Facility[],
  targetRates?: Map<ItemId, number>,
  ceilMode = false,
): { nodes: (FlowProductionNode | FlowTargetNode | FlowDisposalNode | FlowPowerNode | FlowEnvNode)[]; edges: Edge[] } {
  const flowNodes: Node<FlowNodeData>[] = [];
  const flowEdges: Edge[] = [];
  const targetSinkNodes: FlowTargetNode[] = [];
  // Lookup maps for env-sink coverage (buffed machines by formula).
  const facilityById = new Map(facilities.map((f) => [f.id, f] as const));
  const recipeById = new Map<RecipeId, Recipe>();
  for (const n of plan.nodes.values()) {
    if (n.type === "recipe") recipeById.set(n.recipeId, n.recipe);
  }

  let edgeIdCounter = 0;

  // Pre-calculate which items are upstream (have consumers)
  const upstreamItemIds = new Set<string>();
  plan.edges.forEach((edge) => {
    if (plan.nodes.get(edge.from)?.type === "item") {
      upstreamItemIds.add(edge.from);
    }
  });

  // Metastorage imports act as additional producers throughout this
  // mapper. `producersOf` wraps `getItemProducers` with the per-item
  // import pseudo-producer (id = `createMetastorageSourceId`), so the
  // single-vs-multi-producer branching below treats imported supply
  // uniformly; `ensureImportNode` lazily emits the source node the
  // first time an edge references it.
  // Keyed by the raw item-id string: lookups below use `edge.from` /
  // `getRecipeOutputItemId` (both `string`), so a string key avoids
  // `as ItemId` casts at every call site. The value is a LIST because
  // a region can receive the same item from multiple source regions —
  // each is a distinct producer node (`createMetastorageSourceId`
  // keys on source + item). `importByNodeId` reverse-maps a producer
  // node id back to its import for lazy emission.
  const importsByItem = new Map<string, PlanMetastorageImport[]>();
  const importByNodeId = new Map<string, PlanMetastorageImport>();
  for (const imp of plan.metastorageImports) {
    if (imp.ratePerMinute <= MIN_VISIBLE_RATE_PER_MIN) continue;
    const list = importsByItem.get(imp.itemId) ?? [];
    list.push(imp);
    importsByItem.set(imp.itemId, list);
    importByNodeId.set(
      createMetastorageSourceId(imp.sourceDomain, imp.itemId),
      imp,
    );
  }
  // Vent pseudo-producer id → its producible-raw item node, so
  // `ensureProducerNode` can materialise the pickup node on demand.
  const ventProducerItem = new Map<
    string,
    Extract<ProductionGraphNode, { type: "item" }>
  >();
  const producersOf = (itemId: string): { id: string; rate: number }[] => {
    const itemNode = plan.nodes.get(itemId);
    let out: { id: string; rate: number }[];
    if (itemNode?.type === "item" && itemNode.rawSupplyRate !== undefined) {
      // Producible raw (Xiragen et al.): dual-sourced. `getItemProducers`
      // excludes raws, so scan its recipe producers directly AND add the
      // vent as a pseudo-producer (rate = mined portion). The multi-
      // producer greedy allocation then splits every consumer's demand
      // between the transmuter (craft) and the vent pickup.
      out = [];
      for (const e of plan.edges) {
        if (e.to !== itemId) continue;
        const n = plan.nodes.get(e.from);
        if (n?.type !== "recipe" || n.isDisposal) continue;
        const o = n.recipe.outputs.find((oo) => oo.itemId === itemId);
        const rate = o
          ? calcRate(o.amount, n.recipe.craftingTime) * n.facilityCount
          : 0;
        if (rate > MIN_VISIBLE_RATE_PER_MIN) out.push({ id: e.from, rate });
      }
      if (itemNode.rawSupplyRate > MIN_VISIBLE_RATE_PER_MIN) {
        const ventId = createRawMaterialId(itemId);
        ventProducerItem.set(ventId, itemNode);
        out.push({ id: ventId, rate: itemNode.rawSupplyRate });
      }
    } else {
      out = getItemProducers(plan, itemId).map((p) => ({
        id: p.recipeId,
        rate: p.rate,
      }));
    }
    for (const imp of importsByItem.get(itemId) ?? []) {
      out.push({
        id: createMetastorageSourceId(imp.sourceDomain, imp.itemId),
        rate: imp.ratePerMinute,
      });
    }
    return out;
  };
  /** Emit the import source node for `imp` once (idempotent). */
  const ensureImportNode = (imp: PlanMetastorageImport): void => {
    const importNodeId = createMetastorageSourceId(imp.sourceDomain, imp.itemId);
    if (flowNodes.some((n) => n.id === importNodeId)) return;
    const node = plan.nodes.get(imp.itemId);
    if (node?.type !== "item") return;
    flowNodes.push(
      createProductionFlowNode(
        importNodeId,
        {
          item: node.item,
          targetRate: imp.ratePerMinute,
          recipe: null,
          facility: null,
          facilityCount: 0,
          isRawMaterial: false,
          isTarget: false,
          dependencies: [],
          metastorageImport: imp,
        },
        items,
        facilities,
        ceilMode,
        { isDirectTarget: false },
      ),
    );
  };
  /** Emit the import node first when the edge's producer is the import source. */
  const ensureProducerNode = (producerId: string): void => {
    const imp = importByNodeId.get(producerId);
    if (imp) {
      ensureImportNode(imp);
      return;
    }
    // Vent pseudo-producer of a producible raw → materialise its pickup
    // node (sized on the mined portion) if no consumer already emitted it.
    const ventItem = ventProducerItem.get(producerId);
    if (ventItem && !flowNodes.some((n) => n.id === producerId)) {
      const cfg = rawMaterialSources.get(ventItem.itemId);
      const sourceFacility = cfg
        ? (facilities.find((f) => f.id === cfg.sourceFacility) ?? null)
        : null;
      const perFacilityRate = getRawSourceRate(ventItem.itemId, ventItem.item);
      const ventDraw = ventItem.rawSupplyRate ?? 0;
      const pickupCount = perFacilityRate > 0 ? ventDraw / perFacilityRate : 0;
      flowNodes.push(
        createProductionFlowNode(
          producerId,
          {
            item: ventItem.item,
            targetRate: ventDraw,
            recipe: null,
            facility: sourceFacility,
            facilityCount: pickupCount,
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
    }
  };
  /**
   * Terminal-target recipes normally fold into the target sink (embed).
   * When the output item is also Metastorage-supplied the fold is
   * disabled — the sink needs two real inbound edges (local producer +
   * import source), which an embed cannot represent. Used by both the
   * recipe-emission skip and the input-edge redirect so they stay in
   * lockstep.
   *
   * Also disabled for a **producible raw** (Xiragen et al.): it has two
   * producers (transmuter + vent), so its transmuter must render as a
   * real node feeding the sink alongside the vent pickup, never an embed.
   */
  const isFoldedTerminalRecipe = (recipeNodeId: string): boolean => {
    if (!isRecipeTerminal(plan, recipeNodeId)) return false;
    const outputItemId = getRecipeOutputItemId(plan, recipeNodeId);
    if (outputItemId && importsByItem.has(outputItemId)) return false;
    const outNode = outputItemId ? plan.nodes.get(outputItemId) : undefined;
    if (outNode?.type === "item" && outNode.rawSupplyRate !== undefined)
      return false;
    return true;
  };

  // Create production nodes (recipe nodes only)
  plan.nodes.forEach((node, nodeId) => {
    if (node.type === "recipe") {
      const outputItemId = getRecipeOutputItemId(plan, nodeId);
      const outputItemNode = outputItemId
        ? (plan.nodes.get(outputItemId) as
          | Extract<ProductionGraphNode, { type: "item" }>
          | undefined)
        : undefined;

      // Skip recipe node if it's a folded terminal target (no consumers,
      // no secondary outputs feeding other recipes, and not sharing its
      // target with a Metastorage import — see `isFoldedTerminalRecipe`).
      // Multi-output recipes that participate in cycles must NOT be
      // skipped.
      if (outputItemNode && !isFoldedTerminalRecipe(nodeId)) {
        // Use per-recipe output rate rather than total item production rate.
        // For single-producer items these are equal; for multi-producer items
        // (e.g. feeder + override both producing the same item) each visual
        // node shows only its own contribution.
        const recipeOutput = node.recipe.outputs.find(
          (o) => o.itemId === outputItemNode.itemId,
        );
        const perRecipeRate = recipeOutput
          ? calcRate(recipeOutput.amount, node.recipe.craftingTime) *
            node.facilityCount
          : outputItemNode.productionRate;

        flowNodes.push(
           createProductionFlowNode(
            nodeId,
            {
              item: outputItemNode.item,
              targetRate: perRecipeRate,
              recipe: node.recipe,
              facility: node.facility,
              facilityCount: node.facilityCount,
              isRawMaterial: false,
              isTarget: outputItemNode.isTarget,
              dependencies: [],
              binId: node.binId,
              binSisterRecipeIds: node.binSisterRecipeIds,
              // bf=0 chip: this recipe's specific prefill items (not the
              // bin's full union). Empty for recipes that don't sit on
              // a stuck 2-cycle, which is most of them. See
              // `propagatePrefillCandidates` in calculator.ts.
              prefillCandidates: node.prefillCandidates ?? [],
            },
            items,
            facilities,
            ceilMode,
            {
              isDirectTarget: outputItemNode.isTarget,
              directTargetRate: outputItemNode.isTarget
                ? (targetRates?.get(outputItemNode.itemId) ??
                    outputItemNode.productionRate)
                : undefined,
            },
          ),
        );
      }
    }
  });

  // Pre-compute producer→consumer allocation for multi-producer items.
  // Assigns whole producer outputs to consumers wherever possible (exact-fit,
  // then whole-fit, then best-fit split), minimizing pipe/belt connections.
  // Only applies to items with 2+ non-disposal producers.
  type AllocationResult = {
    edges: { producerId: string; consumerId: string; rate: number }[];
    remainingByProducer: Map<string, number>;
  };
  const greedyAllocations = new Map<string, AllocationResult>();

  {
    // Collect all non-disposal consumers per item
    const itemConsumers = new Map<string, { consumerId: string; demand: number }[]>();

    plan.edges.forEach((edge) => {
      const source = plan.nodes.get(edge.from);
      const target = plan.nodes.get(edge.to);
      if (
        source?.type === "item" &&
        target?.type === "recipe" &&
        !target.isDisposal
      ) {
        const inputAmount =
          target.recipe.inputs.find((i) => i.itemId === source.itemId)
            ?.amount || 0;
        const demand =
          calcRate(inputAmount, target.recipe.craftingTime) *
          target.facilityCount;
        if (!itemConsumers.has(edge.from))
          itemConsumers.set(edge.from, []);
        itemConsumers.get(edge.from)!.push({
          consumerId: edge.to,
          demand,
        });
      }
    });

    // Also collect target sink consumers for multi-producer target items.
    // Producible-raw targets qualify (transmuter + vent = 2 producers).
    plan.nodes.forEach((node, nodeId) => {
      if (
        node.type !== "item" ||
        !node.isTarget ||
        (node.isRawMaterial && node.rawSupplyRate === undefined)
      )
        return;
      const producers = producersOf(nodeId);
      if (producers.length <= 1) return;

      const isTerminalTarget = !upstreamItemIds.has(nodeId);
      const anyHasFlowNode = producers.some((p) =>
        flowNodes.some((n) => n.id === p.id),
      );
      if (!isTerminalTarget || anyHasFlowNode || importsByItem.has(node.itemId)) {
        const targetSinkId = createTargetSinkId(node.itemId);
        const userTargetRate =
          targetRates?.get(node.itemId) ?? node.productionRate;
        if (!itemConsumers.has(nodeId)) itemConsumers.set(nodeId, []);
        // Prepend target sink so greedy allocation assigns the primary
        // producer (e.g. the user's override recipe) to the target first,
        // leaving feeder recipes for internal consumers.  This avoids
        // creating visual cycles when a feeder recipe was added.
        itemConsumers.get(nodeId)!.unshift({
          consumerId: targetSinkId,
          demand: userTargetRate,
        });
      }
    });

    // Run the allocation for multi-producer items
    itemConsumers.forEach((consumers, itemId) => {
      const producers = producersOf(itemId);
      if (producers.length <= 1) return;
      greedyAllocations.set(
        itemId,
        computeTransportAllocation(
          producers,
          consumers.map((c) => ({ id: c.consumerId, rate: c.demand })),
        ),
      );
    });
  }

  // Create edges: Recipe → Item → Recipe
  plan.edges.forEach((edge) => {
    const sourceNode = plan.nodes.get(edge.from);
    const targetNode = plan.nodes.get(edge.to);

    if (!sourceNode || !targetNode) return;

    // Recipe → Item (produce)
    if (sourceNode.type === "recipe" && targetNode.type === "item") {
      // Don't create visible edge, just track the relationship
      return;
    }

    // Item → Recipe (consume)
    if (sourceNode.type === "item" && targetNode.type === "recipe") {
      // Skip disposal recipe edges — disposal sinks create their own edges
      if (targetNode.isDisposal) return;

      // Find ALL producers of this item — recipes plus the Metastorage
      // import pseudo-producer (handles multi-producer items like
      // liquid_sewage produced by both pool_xiranite_poly_1 and furnace)
      const producers = producersOf(edge.from);

      // Determine where this flow should end (redirect uses the same
      // fold predicate as the recipe-emission skip above).
      const isTerminalTargetRecipe = isFoldedTerminalRecipe(edge.to);

      let flowTargetId = edge.to;
      if (isTerminalTargetRecipe) {
        const outputItemId = getRecipeOutputItemId(plan, edge.to);
        const outputNode = outputItemId ? plan.nodes.get(outputItemId) : undefined;
        if (outputNode?.type === "item") {
          flowTargetId = createTargetSinkId(outputNode.itemId);
        }
      }

      // Calculate total consumption rate
      const inputAmount =
        targetNode.recipe.inputs.find(
          (inp) => inp.itemId === sourceNode.itemId,
        )?.amount || 0;
      const totalFlowRate =
        calcRate(inputAmount, targetNode.recipe.craftingTime) *
        targetNode.facilityCount;

      const greedy = greedyAllocations.get(edge.from);

      if (greedy) {
        // Multi-producer: use pre-computed allocation
        for (const ae of greedy.edges) {
          if (ae.consumerId !== edge.to) continue;
          if (ae.rate <= MIN_VISIBLE_RATE_PER_MIN) continue;
          ensureProducerNode(ae.producerId);
          flowEdges.push(
            createEdge(
              `e${edgeIdCounter++}`,
              ae.producerId,
              flowTargetId,
              ae.rate,
              sourceNode.item,
              undefined,
              ceilMode,
            ),
          );
        }
      } else if (producers.length > 0) {
        // Single producer (possibly the Metastorage import source):
        // direct edge at full rate
        ensureProducerNode(producers[0].id);
        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            producers[0].id,
            flowTargetId,
            totalFlowRate,
            sourceNode.item,
            undefined,
            ceilMode,
          ),
        );
      } else if (sourceNode.isRawMaterial) {
        // Raw material → Recipe: create node for raw material, tagged
        // with its source facility (unloader_1 / pump_1 / pump_2) and
        // the fractional pickup count. Downstream rendering applies
        // `formatCount(value, ceilMode)` to render ceiled vs fractional.
        // Power for these facilities is summed by `aggregateBinTotals`.
        //
        // Note: this legacy (bf=0) view does NOT route raw byproducts
        // as separate edges. The pickup card's `targetRate` already
        // shows the LP-computed NET external demand
        // (`sourceNode.productionRate`), but the sum of pickup→consumer
        // edges is the GROSS per-consumer demand. Byproduct supply
        // appears on the producing recipe's card but isn't drawn as an
        // edge here. See `mapPlanToFlowBinFused` for the byproduct-
        // routing implementation in the default (bf=1) view.
        const rawMaterialNodeId = createRawMaterialId(sourceNode.itemId);

        if (!flowNodes.find((n) => n.id === rawMaterialNodeId)) {
          const cfg = rawMaterialSources.get(sourceNode.itemId);
          const sourceFacility = cfg
            ? (facilities.find((f) => f.id === cfg.sourceFacility) ?? null)
            : null;
          const perFacilityRate = getRawSourceRate(
            sourceNode.itemId,
            sourceNode.item,
          );
          const ventDraw = rawDraw(sourceNode);
          const pickupCount =
            perFacilityRate > 0 ? ventDraw / perFacilityRate : 0;
          flowNodes.push(
            createProductionFlowNode(
              rawMaterialNodeId,
              {
                item: sourceNode.item,
                targetRate: ventDraw,
                recipe: null,
                facility: sourceFacility,
                facilityCount: pickupCount,
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
        }

        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            rawMaterialNodeId,
            flowTargetId,
            totalFlowRate,
            sourceNode.item,
            undefined,
            ceilMode,
          ),
        );
      }
    }
  });

  // Create target sink nodes
  plan.nodes.forEach((node, nodeId) => {
    if (
      node.type === "item" &&
      node.isTarget &&
      (!node.isRawMaterial || node.rawSupplyRate !== undefined)
    ) {
      // Producible-raw target: fed by the transmuter (craft) + vent
      // pickup, split by the greedy allocation. Force its sink edges even
      // when terminal (the vent pseudo-producer has no flow node yet, so
      // `anyProducerHasFlowNode` can be false).
      const isProducibleRawTarget = node.rawSupplyRate !== undefined;
      const targetNodeId = createTargetSinkId(node.itemId);

      // Find ALL producers of this target item (recipes + Metastorage)
      const producers = producersOf(nodeId);
      const hasImport = importsByItem.has(node.itemId);

      const isTerminalTarget = !upstreamItemIds.has(nodeId);

      // Check if ANY producer already has a production flow node
      const anyProducerHasFlowNode = producers.some((p) =>
        flowNodes.some((n) => n.id === p.id),
      );

      const userTargetRate =
        targetRates?.get(node.itemId) ?? node.productionRate;

      // Only embed recipe info in the sink when there's exactly one producer
      // without a separate flow node (terminal target with single recipe).
      // An import pseudo-producer never embeds — `plan.nodes` has no
      // entry for the import source id, so the lookup stays undefined
      // and the sink gets a regular import edge instead.
      const soleProducer =
        producers.length === 1
          ? (plan.nodes.get(producers[0].id) as
              | Extract<ProductionGraphNode, { type: "recipe" }>
              | undefined)
          : undefined;
      const shouldEmbedRecipeInfo = soleProducer && !anyProducerHasFlowNode;

      targetSinkNodes.push(
        createTargetSinkNode(
          targetNodeId,
          node.item,
          userTargetRate,
          items,
          facilities,
          shouldEmbedRecipeInfo
            ? {
                facility: soleProducer.facility,
                facilityCount: soleProducer.facilityCount,
                recipe: soleProducer.recipe,
              }
            : undefined,
          ceilMode,
        ),
      );

      // Edge from producer(s) to target sink:
      // - Always for non-terminal targets
      // - Also for terminal targets when the recipe already has a production node
      //   (byproduct scenario: recipe serves a primary output elsewhere)
      // - Also when Metastorage supplies this target (the import source
      //   node replaces the embed for import-only targets)
      if (
        producers.length > 0 &&
        (!isTerminalTarget ||
          anyProducerHasFlowNode ||
          hasImport ||
          isProducibleRawTarget)
      ) {
        const greedy = greedyAllocations.get(nodeId);

        // Determine which producers contribute and how much
        const edgesToCreate: { producerRecipeId: string; rate: number }[] = [];

        if (greedy) {
          // Multi-producer: use pre-computed allocation
          for (const ae of greedy.edges) {
            if (ae.consumerId !== targetNodeId) continue;
            if (ae.rate > MIN_VISIBLE_RATE_PER_MIN) {
              edgesToCreate.push({ producerRecipeId: ae.producerId, rate: ae.rate });
            }
          }
        } else if (producers.length > 0) {
          // Single producer: full target rate
          edgesToCreate.push({ producerRecipeId: producers[0].id, rate: userTargetRate });
        }

        for (const { producerRecipeId, rate: edgeRate } of edgesToCreate) {
          ensureProducerNode(producerRecipeId);
          const producerNode = plan.nodes.get(producerRecipeId);
          let edgeFacilityCount: number | undefined;
          if (producerNode?.type === "recipe") {
            const outputEntry = producerNode.recipe.outputs.find(
              (o) => o.itemId === node.itemId,
            );
            if (outputEntry) {
              const ratePerFacility = calcRate(
                outputEntry.amount,
                producerNode.recipe.craftingTime,
              );
              edgeFacilityCount = Math.ceil(edgeRate / ratePerFacility);
            }
          }
          flowEdges.push(
            createEdge(
              `e${edgeIdCounter++}`,
              producerRecipeId,
              targetNodeId,
              edgeRate,
              node.item,
              undefined,
              ceilMode,
              edgeFacilityCount,
            ),
          );
        }
      }
    }
  });

  // Create disposal / power sink nodes for zero-output recipes (power =
  // burn recipe carrying `powerGeneration`; same flow, different card).
  const disposalSinkNodes: (FlowDisposalNode | FlowPowerNode | FlowEnvNode)[] = [];
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "recipe" || !node.isDisposal) return;

    const disposalSinkId = `disposal-${nodeId}`;

    // Find the consumed item (edge: item -> disposal recipe)
    const consumedItemId = getRecipeInputItemId(plan, nodeId);
    if (!consumedItemId) return;

    const consumedItemNode = plan.nodes.get(consumedItemId);
    if (!consumedItemNode || consumedItemNode.type !== "item") return;

    const disposalRate =
      calcRate(
        node.recipe.inputs[0].amount,
        node.recipe.craftingTime,
      ) * node.facilityCount;

    // Defensive: skip phantom sinks below display threshold. The calculator
    // already filters via SURPLUS_EPSILON; this guards against any future
    // path that injects a near-zero disposal recipe and prevents an isolated
    // node from violating flow integrity.
    if (disposalRate <= MIN_VISIBLE_RATE_PER_MIN) return;

    // Env sink FIRST (before power) — vaporize bins are also disposal.
    // The legacy merged view keeps ONE aggregate env node per env.
    disposalSinkNodes.push(
      node.envSupport !== undefined
        ? createEnvSinkNode(
            disposalSinkId,
            consumedItemNode.item,
            disposalRate,
            node.facility,
            node.facilityCount,
            node.recipeId,
            node.envSupport,
            envBuffedMachines(plan, node.envSupport, facilityById, recipeById),
            [],
            items,
            facilities,
            ceilMode,
          )
        : node.powerGeneration
        ? createPowerSinkNode(
            disposalSinkId,
            consumedItemNode.item,
            disposalRate,
            node.facility,
            node.facilityCount,
            node.powerGeneration,
            items,
            facilities,
            ceilMode,
          )
        : createDisposalSinkNode(
            disposalSinkId,
            consumedItemNode.item,
            disposalRate,
            node.facility,
            node.facilityCount,
            items,
            facilities,
            ceilMode,
          ),
    );

    // Create edges from producers with remaining output after consumer allocation
    const greedy = greedyAllocations.get(consumedItemId);
    const producers = getItemProducers(plan, consumedItemId);
    let allocatedToSink = 0;

    for (const producer of producers) {
      // Use greedy remaining if available, otherwise full proportional split
      let edgeRate: number;
      if (greedy) {
        edgeRate = greedy.remainingByProducer.get(producer.recipeId) || 0;
      } else {
        const totalProduction = producers.reduce((sum, p) => sum + p.rate, 0);
        edgeRate =
          totalProduction > 0
            ? disposalRate * (producer.rate / totalProduction)
            : disposalRate;
      }

      if (edgeRate <= MIN_VISIBLE_RATE_PER_MIN) continue;
      allocatedToSink += edgeRate;

      // Compute how many facilities of this producer contribute
      const producerNode = plan.nodes.get(producer.recipeId);
      let edgeFacilityCount: number | undefined;
      if (producerNode?.type === "recipe") {
        const outputEntry = producerNode.recipe.outputs.find(
          (o) => o.itemId === consumedItemNode.itemId,
        );
        if (outputEntry) {
          const ratePerFacility = calcRate(
            outputEntry.amount,
            producerNode.recipe.craftingTime,
          );
          edgeFacilityCount = Math.ceil(edgeRate / ratePerFacility);
        }
      }
      flowEdges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          producer.recipeId,
          disposalSinkId,
          edgeRate,
          consumedItemNode.item,
          undefined,
          ceilMode,
          edgeFacilityCount,
        ),
      );
    }

    // Raw-consuming sink (1.4 vaporizers burn raw gas): no recipe
    // producer exists, so the pickup node supplies the sink directly.
    // Mirrors the raw→consumer branch of the edge handler above (which
    // deliberately skips disposal recipes). The pickup node is created
    // here when no other consumer already forced it into the flow.
    const rawRemainder = disposalRate - allocatedToSink;
    if (
      consumedItemNode.isRawMaterial &&
      rawRemainder > MIN_VISIBLE_RATE_PER_MIN
    ) {
      const rawMaterialNodeId = createRawMaterialId(consumedItemNode.itemId);
      if (!flowNodes.find((n2) => n2.id === rawMaterialNodeId)) {
        const cfg = rawMaterialSources.get(consumedItemNode.itemId);
        const sourceFacility = cfg
          ? (facilities.find((f) => f.id === cfg.sourceFacility) ?? null)
          : null;
        const perFacilityRate = getRawSourceRate(
          consumedItemNode.itemId,
          consumedItemNode.item,
        );
        const ventDraw = rawDraw(consumedItemNode);
        const pickupCount =
          perFacilityRate > 0 ? ventDraw / perFacilityRate : 0;
        flowNodes.push(
          createProductionFlowNode(
            rawMaterialNodeId,
            {
              item: consumedItemNode.item,
              targetRate: ventDraw,
              recipe: null,
              facility: sourceFacility,
              facilityCount: pickupCount,
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
      }
      flowEdges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          rawMaterialNodeId,
          disposalSinkId,
          rawRemainder,
          consumedItemNode.item,
          undefined,
          ceilMode,
        ),
      );
    }
  });

  // Re-home the catalyst portion of each transmuter's intake to its top
  // "catalyst" handle (crafted / vent / import / self-loop alike).
  routeCatalystIntakeToTopHandle(
    flowEdges,
    buildCatalystIntakeByNode(flowNodes),
    new Map(items.map((i) => [i.id, i] as const)),
    ceilMode,
    () => `e${edgeIdCounter++}`,
  );

  const allNodes = [...flowNodes, ...targetSinkNodes, ...disposalSinkNodes] as (
    | FlowProductionNode
    | FlowTargetNode
    | FlowDisposalNode
    | FlowPowerNode
    | FlowEnvNode
  )[];
  assertFlowIntegrity("merged-mapper", allNodes, flowEdges);
  return { nodes: allNodes, edges: flowEdges };
}
