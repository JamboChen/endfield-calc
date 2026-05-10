import type {
  Item,
  Recipe,
  Facility,
  ItemId,
  RecipeId,
  ProductionNode,
  DetectedCycle,
  InvalidCycleInfo,
  ProductionDependencyGraph,
  ProductionGraphNode,
  CrucibleBin,
  RecipeBinAllocation,
} from "@/types";
import { forcedDisposalItems } from "@/data";
import { calcRate } from "@/lib/utils";
import { buildBipartiteGraph, detectSCCs, buildCondensedDAGAndSort } from "./graph-builder";
import { calculateFlows } from "./flow-solver";
import { packCrucibleBins } from "./multi-formula-packing";
import type {
  ProductionMaps,
  BipartiteGraph,
  SCCInfo,
  FlowData,
  RecipeChoice,
  InvalidSCCInfo,
} from "./calculator-types";

// Tolerance for floating-point residuals in surplus mass balance.
// LP facility counts can be fractions like 1/6 that don't have exact binary
// representations; recombining `production - consumption - target` can leave
// residuals on the order of 1e-13. Without this tolerance, a disposal recipe
// would be injected with facilityCount ≈ 0, rendering as a disconnected
// "0/min" sink in the UI (e.g. Xircon Effluent on Jade Gourd at 1/min).
// Matches `TARGET_VALIDATION_TOLERANCE` used by the LP solver.
const SURPLUS_EPSILON = 1e-6;

function injectDisposalRecipes(
  graph: BipartiteGraph,
  flowData: FlowData,
  maps: ProductionMaps,
  targets: Array<{ itemId: ItemId; rate: number }>,
): void {
  for (const itemId of forcedDisposalItems) {
    if (!graph.itemNodes.has(itemId)) continue;
    const itemNode = graph.itemNodes.get(itemId)!;
    if (itemNode.isRawMaterial) continue;

    let totalProduction = 0;
    graph.recipeOutputs.forEach((outputItems, recipeId) => {
      if (outputItems.has(itemId)) {
        const recipe = maps.recipeMap.get(recipeId)!;
        const facilityCount = flowData.recipeFacilityCounts.get(recipeId) || 0;
        const output = recipe.outputs.find((o) => o.itemId === itemId);
        if (output) {
          totalProduction +=
            calcRate(output.amount, recipe.craftingTime) * facilityCount;
        }
      }
    });

    let totalConsumption = 0;
    const consumers = graph.itemConsumedBy.get(itemId);
    if (consumers) {
      for (const recipeId of consumers) {
        const recipe = maps.recipeMap.get(recipeId)!;
        if (recipe.outputs.length === 0) continue;
        const facilityCount = flowData.recipeFacilityCounts.get(recipeId) || 0;
        const input = recipe.inputs.find((i) => i.itemId === itemId);
        if (input) {
          totalConsumption +=
            calcRate(input.amount, recipe.craftingTime) * facilityCount;
        }
      }
    }

    const targetDemand = targets.find((t) => t.itemId === itemId)?.rate || 0;

    const surplus = totalProduction - totalConsumption - targetDemand;
    if (surplus <= SURPLUS_EPSILON) continue;

    const disposalRecipe = Array.from(maps.recipeMap.values()).find(
      (r) =>
        r.outputs.length === 0 && r.inputs.some((i) => i.itemId === itemId),
    );
    if (!disposalRecipe) continue;

    if (graph.recipeNodes.has(disposalRecipe.id)) continue;

    const disposalInput = disposalRecipe.inputs.find(
      (i) => i.itemId === itemId,
    )!;
    const disposalRatePerFacility = calcRate(
      disposalInput.amount,
      disposalRecipe.craftingTime,
    );
    const disposalFacilityCount = surplus / disposalRatePerFacility;

    const facility = maps.facilityMap.get(disposalRecipe.facilityId);
    if (!facility) continue;

    graph.recipeNodes.set(disposalRecipe.id, {
      recipeId: disposalRecipe.id,
      recipe: disposalRecipe,
      facility,
    });
    graph.recipeInputs.set(disposalRecipe.id, new Set([itemId]));
    graph.recipeOutputs.set(disposalRecipe.id, new Set());

    if (!graph.itemConsumedBy.has(itemId)) {
      graph.itemConsumedBy.set(itemId, new Set());
    }
    graph.itemConsumedBy.get(itemId)!.add(disposalRecipe.id);

    flowData.recipeFacilityCounts.set(disposalRecipe.id, disposalFacilityCount);
  }
}

function buildProductionGraph(
  graph: BipartiteGraph,
  flowData: FlowData,
  sccs: SCCInfo[],
  maps: ProductionMaps,
  invalidSCCs: InvalidSCCInfo[] = [],
  recipeOverrides?: Map<ItemId, RecipeId>,
  crucibleBins: CrucibleBin[] = [],
  recipeBinAllocations: Map<RecipeId, RecipeBinAllocation> = new Map(),
): ProductionDependencyGraph {
  const nodes = new Map<string, ProductionGraphNode>();
  const edges: Array<{ from: string; to: string }> = [];

  graph.itemNodes.forEach((itemNode, itemId) => {
    let productionRate = 0;

    if (itemNode.isRawMaterial) {
      productionRate = flowData.itemDemands.get(itemId) || 0;
    } else {
      graph.recipeOutputs.forEach((outputItems, recipeId) => {
        if (outputItems.has(itemId)) {
          const recipe = maps.recipeMap.get(recipeId)!;
          const facilityCount =
            flowData.recipeFacilityCounts.get(recipeId) || 0;
          const output = recipe.outputs.find((o) => o.itemId === itemId);
          if (output) {
            productionRate +=
              calcRate(output.amount, recipe.craftingTime) * facilityCount;
          }
        }
      });
    }

    nodes.set(itemId, {
      type: "item",
      itemId,
      item: itemNode.item,
      productionRate,
      isRawMaterial: itemNode.isRawMaterial,
      isTarget: graph.targets.has(itemId),
    });
  });

  // Build bin lookup keyed by allocation entry's binId.
  const binById = new Map<string, CrucibleBin>();
  for (const bin of crucibleBins) binById.set(bin.id, bin);

  graph.recipeNodes.forEach((recipeData, recipeId) => {
    // Resolve the recipe's physical facility via its primary bin (if any).
    // When Phase 3 swapped a `_1` demand into a `_2` bin (Expanded twin),
    // the recipe object still references its nominal facility — the bin
    // is the source of truth for the actually-built facility.
    const allocation = recipeBinAllocations.get(recipeId);
    let physicalFacility = recipeData.facility;
    let binId: string | undefined;
    let sisterRecipeIds: RecipeId[] = [];
    if (allocation && allocation.perBin.length > 0) {
      // Use the first bin entry as the primary association. Recipes split
      // across multiple bin types share the same facility type because the
      // ILP packing only mixes facilities at the equivalence-class level
      // (Phase 3 picks one facility per equivalence class).
      const primary = allocation.perBin[0];
      const bin = binById.get(primary.binId);
      if (bin) {
        binId = bin.id;
        const facLookup = maps.facilityMap.get(bin.facilityId);
        if (facLookup) physicalFacility = facLookup;
        sisterRecipeIds = bin.recipeIds.filter((rid) => rid !== recipeId);
      }
    }
    nodes.set(recipeId, {
      type: "recipe",
      recipeId,
      recipe: recipeData.recipe,
      facility: physicalFacility,
      facilityCount: flowData.recipeFacilityCounts.get(recipeId) || 0,
      isDisposal: recipeData.recipe.outputs.length === 0,
      binId,
      binSisterRecipeIds: sisterRecipeIds,
    });
  });

  graph.itemConsumedBy.forEach((recipeIds, itemId) => {
    recipeIds.forEach((recipeId) => {
      edges.push({ from: itemId, to: recipeId });
    });
  });

  graph.recipeOutputs.forEach((itemIds, recipeId) => {
    itemIds.forEach((itemId) => {
      edges.push({ from: recipeId, to: itemId });
    });
  });

  const activeSCCs = sccs.filter((scc) => !flowData.resolvedSCCIds.has(scc.id));
  const detectedCycles: DetectedCycle[] = activeSCCs.map((scc) => {
    const cycleNodes: ProductionNode[] = Array.from(scc.recipes).flatMap(
      (recipeId) => {
        const recipeData = graph.recipeNodes.get(recipeId)!;
        const facilityCount = flowData.recipeFacilityCounts.get(recipeId) || 0;
        const outputs = recipeData.recipe.outputs;

        // Resolve physical facility via the recipe's bin (consistent
        // with the production-graph node above). Without this, a cycle
        // node would show Phase 2's facility (e.g. Reactor) while the
        // rest of the plan shows Phase 3's pick (e.g. Expanded).
        const cycleAlloc = recipeBinAllocations.get(recipeId);
        let cycleFacility = recipeData.facility;
        let cycleBinId: string | undefined;
        let cycleSisters: RecipeId[] = [];
        if (cycleAlloc && cycleAlloc.perBin.length > 0) {
          const bin = binById.get(cycleAlloc.perBin[0].binId);
          if (bin) {
            cycleBinId = bin.id;
            const fac = maps.facilityMap.get(bin.facilityId);
            if (fac) cycleFacility = fac;
            cycleSisters = bin.recipeIds.filter((rid) => rid !== recipeId);
          }
        }

        return outputs.map((out) => ({
          item: graph.itemNodes.get(out.itemId)!.item,
          targetRate:
            calcRate(out.amount, recipeData.recipe.craftingTime) *
            facilityCount,
          recipe: recipeData.recipe,
          facility: cycleFacility,
          facilityCount,
          isRawMaterial: false,
          isTarget: false,
          dependencies: [],
          binId: cycleBinId,
          binSisterRecipeIds: cycleSisters,
        }));
      },
    );

    return {
      cycleId: scc.id,
      involvedItemIds: Array.from(scc.items),
      breakPointItemId: Array.from(scc.items)[0],
      cycleNodes,
      netOutputs: new Map(),
    };
  });

  const invalidCycles: InvalidCycleInfo[] = invalidSCCs.map((info) => ({
    cycleId: info.sccId,
    involvedItemIds: Array.from(info.involvedItems),
    involvedRecipeIds: Array.from(
      sccs.find((s) => s.id === info.sccId)?.recipes ?? [],
    ),
    reason: info.reason,
    overriddenItemIds: Array.from(info.involvedItems).filter(
      (itemId) => recipeOverrides?.has(itemId) ?? false,
    ),
  }));

  return {
    nodes,
    edges,
    targets: graph.targets,
    detectedCycles,
    invalidCycles,
    crucibleBins,
    recipeBinAllocations,
  };
}

function backtrackRecipeChoices(
  recipeChoices: Map<ItemId, RecipeChoice>,
  invalidSCCs: InvalidSCCInfo[],
  currentConstraints: Map<ItemId, Set<RecipeId>>,
): Map<ItemId, Set<RecipeId>> | null {
  if (invalidSCCs.length === 0) {
    return currentConstraints;
  }

  console.log(
    `[BACKTRACK] Attempting to backtrack for ${invalidSCCs.length} invalid SCCs`,
  );

  const problematicItems = new Set<ItemId>();
  invalidSCCs.forEach((scc) => {
    scc.involvedItems.forEach((itemId) => problematicItems.add(itemId));
  });

  console.log(
    `[BACKTRACK] Problematic items: ${Array.from(problematicItems).join(", ")}`,
  );

  const itemsWithChoices = Array.from(recipeChoices.values())
    .filter((choice) => problematicItems.has(choice.itemId))
    .sort((a, b) => b.currentIndex - a.currentIndex);

  if (itemsWithChoices.length === 0) {
    console.log(
      `[BACKTRACK] No alternative recipes available for problematic items`,
    );
    return null;
  }

  for (const choice of itemsWithChoices) {
    const nextIndex = choice.currentIndex + 1;

    if (nextIndex < choice.availableRecipes.length) {
      console.log(
        `[BACKTRACK] Trying next recipe for item ${choice.itemId}: ` +
          `index ${nextIndex}/${choice.availableRecipes.length}`,
      );

      const newConstraints = new Map(currentConstraints);

      const excludedRecipes = new Set(
        currentConstraints.get(choice.itemId) || [],
      );
      for (let i = 0; i <= choice.currentIndex; i++) {
        excludedRecipes.add(choice.availableRecipes[i]);
      }
      newConstraints.set(choice.itemId, excludedRecipes);

      choice.currentIndex = nextIndex;

      return newConstraints;
    }
  }

  console.log(`[BACKTRACK] All recipe combinations exhausted`);
  return null;
}

export function calculateProductionPlan(
  targets: Array<{ itemId: ItemId; rate: number }>,
  items: Item[],
  recipes: Recipe[],
  facilities: Facility[],
  recipeOverrides?: Map<ItemId, RecipeId>,
  manualRawMaterials?: Set<ItemId>,
): ProductionDependencyGraph {
  if (targets.length === 0) throw new Error("No targets specified");

  const maps: ProductionMaps = {
    itemMap: new Map(items.map((i) => [i.id, i])),
    recipeMap: new Map(recipes.map((r) => [r.id, r])),
    facilityMap: new Map(facilities.map((f) => [f.id, f])),
  };

  const MAX_ITERATIONS = 100;
  let iteration = 0;
  let recipeConstraints = new Map<ItemId, Set<RecipeId>>();

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`\n=== ITERATION ${iteration} ===`);

    const { graph, recipeChoices } = buildBipartiteGraph(
      targets,
      maps,
      recipeOverrides,
      manualRawMaterials,
      recipeConstraints,
    );

    const sccs = detectSCCs(graph);
    const condensedOrder = buildCondensedDAGAndSort(graph, sccs);
    const targetRatesMap = new Map(targets.map((t) => [t.itemId, t.rate]));
    const { flowData, invalidSCCs } = calculateFlows(
      graph,
      condensedOrder,
      targetRatesMap,
      maps,
      recipeOverrides,
      manualRawMaterials,
    );

    if (invalidSCCs.length === 0) {
      console.log(
        `[SUCCESS] Valid production plan found in ${iteration} iteration(s)`,
      );
      injectDisposalRecipes(graph, flowData, maps, targets);
      const packing = packCrucibleBins({
        recipeSlotDemands: flowData.recipeFacilityCounts,
        recipeMap: maps.recipeMap,
        itemMap: maps.itemMap,
        facilityMap: maps.facilityMap,
        recipeOverrides,
      });
      return buildProductionGraph(
        graph,
        flowData,
        sccs,
        maps,
        [],
        recipeOverrides,
        packing.bins,
        packing.allocations,
      );
    }

    console.log(
      `[ITERATION ${iteration}] Found ${invalidSCCs.length} invalid SCC(s), attempting backtrack`,
    );

    const newConstraints = backtrackRecipeChoices(
      recipeChoices,
      invalidSCCs,
      recipeConstraints,
    );

    if (newConstraints === null) {
      console.warn(
        `[FAILED] Cannot find valid production plan after ${iteration} iterations. ` +
          `Returning best-effort result with ${invalidSCCs.length} invalid cycle(s).`,
      );
      injectDisposalRecipes(graph, flowData, maps, targets);
      const packing = packCrucibleBins({
        recipeSlotDemands: flowData.recipeFacilityCounts,
        recipeMap: maps.recipeMap,
        itemMap: maps.itemMap,
        facilityMap: maps.facilityMap,
        recipeOverrides,
      });
      return buildProductionGraph(
        graph,
        flowData,
        sccs,
        maps,
        invalidSCCs,
        recipeOverrides,
        packing.bins,
        packing.allocations,
      );
    }

    recipeConstraints = newConstraints;
  }

  throw new Error(
    `Maximum iterations (${MAX_ITERATIONS}) reached. Cannot find valid production plan.`,
  );
}
