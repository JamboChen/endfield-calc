import type {
  Item,
  Recipe,
  Facility,
  ItemId,
  RecipeId,
  BinId,
  ProductionNode,
  DetectedCycle,
  InvalidCycleInfo,
  ProductionDependencyGraph,
  ProductionGraphNode,
  Bin,
  RecipeBinAllocation,
} from "@/types";
import { forcedDisposalItems, forcedRawMaterials } from "@/data";
import { calcRate } from "@/lib/utils";
import { buildBipartiteGraph, detectSCCs, buildCondensedDAGAndSort } from "./graph-builder";
import { calculateFlows } from "./flow-solver";
import { packBins } from "./multi-formula-packing";
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

/**
 * Compute the set of items reachable from raw materials via the active
 * recipe set (those with a positive slot allocation in the LP solution).
 * Fixpoint: start with `rawMaterials`, then repeatedly add the outputs
 * of any active recipe whose inputs are all already bootable.
 *
 * Used by `propagatePrefillCandidates` to filter 2-cycle items: a cycle
 * has an external entry whenever at least one of its items is reachable
 * from raws — the cycle bootstraps from that side without prefill, no
 * matter where the LP routed the actual flow.
 *
 * **Anti-pattern**: do not iterate over ALL recipes in `recipeMap`;
 * recipes the LP didn't pick aren't actually running and don't contribute
 * to bootability for THIS plan. Use `activeRecipeIds` (drawn from
 * `recipeBinAllocations.keys()`).
 */
function computeBootableItems(
  activeRecipeIds: Iterable<RecipeId>,
  recipeMap: Map<RecipeId, Recipe>,
  rawMaterials: ReadonlySet<ItemId>,
): Set<ItemId> {
  const bootable = new Set<ItemId>(rawMaterials);
  const activeRecipes: Recipe[] = [];
  for (const rid of activeRecipeIds) {
    const recipe = recipeMap.get(rid);
    if (recipe) activeRecipes.push(recipe);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const recipe of activeRecipes) {
      if (recipe.outputs.every((o) => bootable.has(o.itemId))) continue;
      if (recipe.inputs.every((i) => bootable.has(i.itemId))) {
        for (const o of recipe.outputs) {
          if (!bootable.has(o.itemId)) {
            bootable.add(o.itemId);
            changed = true;
          }
        }
      }
    }
  }
  return bootable;
}

/**
 * Populate per-(bin, recipe) and per-bin prefill-candidate lists for
 * every recipe-level **2-cycle** that lacks an external entry point.
 * Run after `packBins` so we can map SCC recipes back to their
 * hosting bins via `recipeBinAllocations`.
 *
 * **The 2-recipe cycle rule** (key invariant): items become prefill
 * candidates only when they're part of a TIGHT back-and-forth between
 * exactly two recipes. Larger cycles (3+ recipes) bootstrap from
 * nested 2-cycles or via the player's own startup inputs.
 *
 * **The dual filter** — for each (A, B) 2-cycle via items I (A→B)
 * and J (B→A), iterate every pair (binA, binB) where binA hosts A
 * and binB hosts B:
 *
 *   - **Intra-bin case** (binA == binB): the bin's port allocation
 *     determines whether a cycle item can flow in externally. Flag
 *     each cycle item that the bin's recipes consume but that is NOT
 *     in `bin.externalInputs` — the bin has no external port for
 *     that item, so the inner-inventory cycle can't bootstrap without
 *     a seed. Example: Xircon Crucible 3-formula bin (LX-Prod +
 *     Effluent-Prod + Xircon-Prod). Sewage is INTERNAL (Xircon-Prod
 *     produces, Effluent-Prod consumes; balanced → no port) → flag.
 *     Xircon Effluent is in externalInputs (LP allocates 60/min from
 *     other Effluent producers) → skip.
 *
 *   - **Inter-bin case** (binA != binB): the cycle spans two bins.
 *     Apply the bootability filter: flag only when BOTH I and J are
 *     non-bootable from raws via the active recipe set. If either
 *     side is bootable, the cycle bootstraps from that side without
 *     prefill. Example: planter ↔ seedcollector moss cycle — neither
 *     plant nor seed has a bootable producer, so both bins flag.
 *     Counter-example: in Xircon-60, when the (Effluent-Prod,
 *     Xircon-Prod) pair lands in different bins (Bin 1 hosts
 *     Effluent-Prod, Bin 0 hosts Xircon-Prod), Sewage is bootable
 *     via Furnace so no chip is emitted on either bin.
 *
 * The two cases reflect different physical realities: intra-bin
 * cycles are constrained by the bin's port allocation (a hard LP
 * decision), while inter-bin cycles can be resolved by belt routing
 * if a raws-reachable producer exists anywhere in the plan.
 *
 * Mutates `bins` in place (sets `bin.prefillCandidates`). Returns a
 * per-recipe map (UNION across all hosting bins of a given recipe id)
 * so `buildProductionGraph` can copy it onto each recipe's
 * `ProductionGraphNode`, where `merged-mapper` (bf=0) reads it for
 * the per-recipe chip rendering.
 */
function propagatePrefillCandidates(
  bins: Bin[],
  sccs: SCCInfo[],
  recipeBinAllocations: Map<RecipeId, RecipeBinAllocation>,
  recipeMap: Map<RecipeId, Recipe>,
): Map<RecipeId, ItemId[]> {
  const binsById = new Map<string, Bin>();
  for (const bin of bins) binsById.set(bin.id, bin);

  const bootable = computeBootableItems(
    recipeBinAllocations.keys(),
    recipeMap,
    forcedRawMaterials,
  );

  if (import.meta.env?.DEV) {
    console.log(
      `[PREFILL] bootable from raws (${bootable.size} items): [${Array.from(
        bootable,
      )
        .sort()
        .join(", ")}]`,
    );
  }

  // Per-(bin, recipe) accumulator. The bin-level union and per-recipe
  // union (across hosting bins) are derived below.
  type Key = string; // `${binId}::${recipeId}`
  const perBinRecipe = new Map<Key, Set<ItemId>>();
  const keyOf = (binId: string, rid: RecipeId): Key => `${binId}::${rid}`;
  const addToBinRecipe = (
    binId: string,
    recipeId: RecipeId,
    items: ItemId[],
    label: string,
  ) => {
    if (items.length === 0) return;
    const k = keyOf(binId, recipeId);
    let bucket = perBinRecipe.get(k);
    if (!bucket) {
      bucket = new Set<ItemId>();
      perBinRecipe.set(k, bucket);
    }
    for (const id of items) bucket.add(id);
    if (import.meta.env?.DEV) {
      console.log(
        `[PREFILL]   ${label} bin ${binId} <- recipe ${recipeId}: +[${items.join(", ")}]`,
      );
    }
  };

  for (const scc of sccs) {
    const sccItemSet = new Set(scc.items);

    // Singleton SCC with a self-loop is a degenerate 1-recipe cycle:
    // the recipe consumes its own output. Flag only if the looped item
    // is non-bootable (no external producer reachable from raws).
    if (scc.recipes.size === 1) {
      const onlyRid = Array.from(scc.recipes)[0];
      const recipe = recipeMap.get(onlyRid);
      if (!recipe) continue;
      const inputs = new Set(recipe.inputs.map((i) => i.itemId));
      const selfLoopItems = recipe.outputs
        .map((o) => o.itemId)
        .filter(
          (id) => inputs.has(id) && sccItemSet.has(id) && !bootable.has(id),
        );
      if (selfLoopItems.length === 0) continue;
      if (import.meta.env?.DEV) {
        console.log(
          `[PREFILL] SCC ${scc.id}: 1-recipe self-loop on [${selfLoopItems.join(", ")}]`,
        );
      }
      const alloc = recipeBinAllocations.get(onlyRid);
      if (!alloc) continue;
      for (const entry of alloc.perBin) {
        addToBinRecipe(entry.binId, onlyRid, selfLoopItems, "self-loop");
      }
      continue;
    }

    if (import.meta.env?.DEV) {
      console.log(
        `[PREFILL] SCC ${scc.id}: ${scc.recipes.size} recipe(s), items=[${Array.from(scc.items).join(", ")}]`,
      );
    }

    // Pair-wise 2-recipe cycle detection within the SCC.
    const recipeIds = Array.from(scc.recipes);
    for (let i = 0; i < recipeIds.length; i++) {
      for (let j = i + 1; j < recipeIds.length; j++) {
        const rA = recipeMap.get(recipeIds[i]);
        const rB = recipeMap.get(recipeIds[j]);
        if (!rA || !rB) continue;

        const aInputs = new Set(rA.inputs.map((inp) => inp.itemId));
        const bInputs = new Set(rB.inputs.map((inp) => inp.itemId));

        // Items A produces that B consumes (and are in SCC).
        const aToB = rA.outputs
          .map((o) => o.itemId)
          .filter((id) => sccItemSet.has(id) && bInputs.has(id));
        // Items B produces that A consumes (and are in SCC).
        const bToA = rB.outputs
          .map((o) => o.itemId)
          .filter((id) => sccItemSet.has(id) && aInputs.has(id));

        if (aToB.length === 0 || bToA.length === 0) continue;

        if (import.meta.env?.DEV) {
          console.log(
            `[PREFILL]   2-cycle (${recipeIds[i]}, ${recipeIds[j]}): A->B=[${aToB.join(", ")}], B->A=[${bToA.join(", ")}]`,
          );
        }

        const allocA = recipeBinAllocations.get(recipeIds[i]);
        const allocB = recipeBinAllocations.get(recipeIds[j]);
        if (!allocA || !allocB) continue;

        // Iterate every pair (binA hosts A, binB hosts B). Apply the
        // intra-bin filter when they're the same bin, the inter-bin
        // bootability filter otherwise.
        for (const entryA of allocA.perBin) {
          for (const entryB of allocB.perBin) {
            if (entryA.binId === entryB.binId) {
              // Intra-bin: same bin hosts both A and B.
              const bin = binsById.get(entryA.binId);
              if (!bin) continue;
              const externalSet = new Set<ItemId>(
                bin.externalInputs.map((io) => io.itemId),
              );
              // bToA = items A consumes. Flag those not externally
              // supplied to this bin.
              const aFlag = bToA.filter((id) => !externalSet.has(id));
              // aToB = items B consumes. Flag those not externally
              // supplied to this bin.
              const bFlag = aToB.filter((id) => !externalSet.has(id));
              if (aFlag.length === 0 && bFlag.length === 0) {
                if (import.meta.env?.DEV) {
                  console.log(
                    `[PREFILL]   intra-bin ${entryA.binId}: all cycle items externally supplied; skip`,
                  );
                }
                continue;
              }
              addToBinRecipe(entryA.binId, recipeIds[i], aFlag, "intra-bin");
              addToBinRecipe(entryB.binId, recipeIds[j], bFlag, "intra-bin");
            } else {
              // Inter-bin: bootability filter (BOTH halves non-bootable).
              const aToBNonBoot = aToB.filter((id) => !bootable.has(id));
              const bToANonBoot = bToA.filter((id) => !bootable.has(id));
              if (aToBNonBoot.length === 0 || bToANonBoot.length === 0) {
                if (import.meta.env?.DEV) {
                  const rescuedA = aToB.filter((id) => bootable.has(id));
                  const rescuedB = bToA.filter((id) => bootable.has(id));
                  console.log(
                    `[PREFILL]   inter-bin (${entryA.binId}, ${entryB.binId}) bootable-bypassed: A->B rescued=[${rescuedA.join(", ")}], B->A rescued=[${rescuedB.join(", ")}]`,
                  );
                }
                continue;
              }
              addToBinRecipe(
                entryA.binId,
                recipeIds[i],
                bToANonBoot,
                "inter-bin",
              );
              addToBinRecipe(
                entryB.binId,
                recipeIds[j],
                aToBNonBoot,
                "inter-bin",
              );
            }
          }
        }
      }
    }
  }

  // Derive per-bin union from per-(bin, recipe) lists. Each bin's
  // prefillCandidates = sorted union over its member recipes'
  // per-bin prefill items, filtered to inputs that some recipe in the
  // bin actually consumes (defensive).
  for (const bin of bins) {
    const merged = new Set<ItemId>();
    const consumedInBin = new Set<ItemId>();
    for (const rid of bin.recipeIds) {
      const recipe = recipeMap.get(rid);
      if (!recipe) continue;
      for (const inp of recipe.inputs) consumedInBin.add(inp.itemId);
    }
    for (const rid of bin.recipeIds) {
      const set = perBinRecipe.get(keyOf(bin.id, rid));
      if (!set) continue;
      for (const id of set) {
        if (consumedInBin.has(id)) merged.add(id);
      }
    }
    bin.prefillCandidates = Array.from(merged).sort();
  }

  // Derive per-recipe union (across ALL hosting bins of the same
  // recipe id) for the merged-mapper (bf=0) chip. A recipe rendered
  // as a single per-recipe node in bf=0 should warn if ANY hosting
  // bin needs prefill (conservative).
  const recipePrefill = new Map<RecipeId, Set<ItemId>>();
  for (const [k, set] of perBinRecipe.entries()) {
    const recipeId = k.slice(k.indexOf("::") + 2) as RecipeId;
    let bucket = recipePrefill.get(recipeId);
    if (!bucket) {
      bucket = new Set<ItemId>();
      recipePrefill.set(recipeId, bucket);
    }
    for (const id of set) bucket.add(id);
  }
  const finalRecipePrefill = new Map<RecipeId, ItemId[]>();
  for (const [rid, set] of recipePrefill.entries()) {
    finalRecipePrefill.set(rid, Array.from(set).sort());
  }
  return finalRecipePrefill;
}

function buildProductionGraph(
  graph: BipartiteGraph,
  flowData: FlowData,
  sccs: SCCInfo[],
  maps: ProductionMaps,
  invalidSCCs: InvalidSCCInfo[] = [],
  recipeOverrides?: Map<ItemId, RecipeId>,
  bins: Bin[] = [],
  recipeBinAllocations: Map<RecipeId, RecipeBinAllocation> = new Map(),
  warnings: string[] = [],
  recipePrefill: Map<RecipeId, ItemId[]> = new Map(),
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
  const binById = new Map<BinId, Bin>();
  for (const bin of bins) binById.set(bin.id, bin);

  /**
   * Resolve the bin metadata for a given recipe. Returns the recipe's
   * physical facility (the bin's facility, which may differ from the
   * recipe's nominal `facilityId` when Phase 3 swapped variants), the
   * primary bin id, and sister recipe ids (other recipes co-located in
   * the same bin). When the recipe has no allocation (rare — only
   * happens before Phase 3 runs successfully), falls back to the
   * recipe's nominal facility.
   */
  const resolveBinInfo = (
    recipeId: RecipeId,
    fallbackFacility: Facility,
  ): { facility: Facility; binId: BinId | undefined; sisters: RecipeId[] } => {
    const allocation = recipeBinAllocations.get(recipeId);
    if (!allocation || allocation.perBin.length === 0) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[resolveBinInfo] recipe ${recipeId} has no bin allocation; using fallback facility`,
        );
      }
      return { facility: fallbackFacility, binId: undefined, sisters: [] };
    }
    // Use the first bin entry as the primary association. Recipes split
    // across multiple bin types share the same facility type because
    // Phase 3 picks one facility per equivalence class.
    const bin = binById.get(allocation.perBin[0].binId);
    if (!bin) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[resolveBinInfo] recipe ${recipeId} references missing bin ${allocation.perBin[0].binId}`,
        );
      }
      return { facility: fallbackFacility, binId: undefined, sisters: [] };
    }
    const fac = maps.facilityMap.get(bin.facilityId);
    return {
      facility: fac ?? fallbackFacility,
      binId: bin.id,
      sisters: bin.recipeIds.filter((rid) => rid !== recipeId),
    };
  };

  graph.recipeNodes.forEach((recipeData, recipeId) => {
    const { facility, binId, sisters } = resolveBinInfo(
      recipeId,
      recipeData.facility,
    );
    nodes.set(recipeId, {
      type: "recipe",
      recipeId,
      recipe: recipeData.recipe,
      facility,
      facilityCount: flowData.recipeFacilityCounts.get(recipeId) || 0,
      isDisposal: recipeData.recipe.outputs.length === 0,
      binId,
      binSisterRecipeIds: sisters,
      prefillCandidates: recipePrefill.get(recipeId) ?? [],
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
        const { facility, binId, sisters } = resolveBinInfo(
          recipeId,
          recipeData.facility,
        );

        return outputs.map((out) => ({
          item: graph.itemNodes.get(out.itemId)!.item,
          targetRate:
            calcRate(out.amount, recipeData.recipe.craftingTime) *
            facilityCount,
          recipe: recipeData.recipe,
          facility,
          facilityCount,
          isRawMaterial: false,
          isTarget: false,
          dependencies: [],
          binId,
          binSisterRecipeIds: sisters,
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
    bins,
    recipeBinAllocations,
    warnings,
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

export async function calculateProductionPlan(
  targets: Array<{ itemId: ItemId; rate: number }>,
  items: Item[],
  recipes: Recipe[],
  facilities: Facility[],
  recipeOverrides?: Map<ItemId, RecipeId>,
  manualRawMaterials?: Set<ItemId>,
): Promise<ProductionDependencyGraph> {
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
    const { flowData, invalidSCCs } = await calculateFlows(
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
      const packing = await packBins({
        recipeSlotDemands: flowData.recipeFacilityCounts,
        recipeMap: maps.recipeMap,
        itemMap: maps.itemMap,
        facilityMap: maps.facilityMap,
        recipeOverrides,
      });
      const recipePrefill = propagatePrefillCandidates(
        packing.bins,
        sccs,
        packing.allocations,
        maps.recipeMap,
      );
      return buildProductionGraph(
        graph,
        flowData,
        sccs,
        maps,
        [],
        recipeOverrides,
        packing.bins,
        packing.allocations,
        packing.warnings,
        recipePrefill,
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
      const packing = await packBins({
        recipeSlotDemands: flowData.recipeFacilityCounts,
        recipeMap: maps.recipeMap,
        itemMap: maps.itemMap,
        facilityMap: maps.facilityMap,
        recipeOverrides,
      });
      const recipePrefill = propagatePrefillCandidates(
        packing.bins,
        sccs,
        packing.allocations,
        maps.recipeMap,
      );
      return buildProductionGraph(
        graph,
        flowData,
        sccs,
        maps,
        invalidSCCs,
        recipeOverrides,
        packing.bins,
        packing.allocations,
        packing.warnings,
        recipePrefill,
      );
    }

    recipeConstraints = newConstraints;
  }

  throw new Error(
    `Maximum iterations (${MAX_ITERATIONS}) reached. Cannot find valid production plan.`,
  );
}
