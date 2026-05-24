import type { ItemId, RecipeId } from "@/types";
import {
  forcedRawMaterials,
  forcedDisposalItems,
  costlessRaws,
} from "@/data";
import { calcRate } from "@/lib/utils";
import { solveLP, type LPInput, type LPItemConstraint } from "./lp-solver";
import type {
  ProductionMaps,
  BipartiteGraph,
  SCCInfo,
  FlowData,
  InvalidSCCInfo,
} from "./calculator-types";

/**
 * Solve the production flow as **one global LP** over every recipe in
 * the multi-recipe graph.
 *
 * Why one LP instead of the old per-SCC + topological-walk pipeline:
 *
 *   1. The graph now contains all alternative producers per item
 *      (graph-builder no longer applies a selectRecipe heuristic).
 *      A per-SCC LP would still pick one recipe per item locally, but
 *      that pick is only optimal *given the SCC's borders* — items
 *      outside the SCC that have multiple producers don't get any
 *      optimisation pass at all under the old "closed-form" branch
 *      (`facilityCount = demand / rate` assumes one producer).
 *
 *   2. A global LP picks recipes jointly under the lex objective
 *      `rawCost → buildingCount → power`. The Carbon Powder Yazhen flip
 *      (vs the old first-in-file Buckflower default) falls out
 *      automatically here.
 *
 *   3. The old backtracking machinery (`backtrackRecipeChoices` in
 *      `calculator.ts`) is subsumed: any feasible recipe combination is
 *      already in the LP's convex hull, so the LP finds it in one pass.
 *      If the LP is infeasible, no recipe combination would have helped.
 *
 *   4. `tryExtendSCCWithFeeders` is subsumed: feeders are simply
 *      additional producers in the same global LP.
 *
 * Constraint shape per item:
 *
 *   - **Raw** (forced or user-marked): excluded from balance constraints.
 *     The LP treats raws as infinite-supply (and `costlessRaws` as
 *     zero-cost) on the input side.
 *   - **User target**: `min: targetRate`. Surplus is allowed (surfaces
 *     as elevated production rate; not an error).
 *   - **Forced-disposal byproduct** (sewage, xirpoly, etc.): `disposal-slack: 0`.
 *     The LP must produce ≥ consumption; surplus is fine (handled by
 *     `injectDisposalRecipes`); deficit goes to a `disposalDeficit` map
 *     that the UI surfaces as a warning.
 *   - **Other intermediate**: `min: 0`. LP-optimal drives production to
 *     exactly match consumption because cost minimisation. `min` (rather
 *     than `equal`) is chosen for robustness against multi-output
 *     recipes whose byproducts have no consumer — `equal: 0` would
 *     incorrectly refuse to run them.
 *
 * Returns a `FlowData` plus a possibly-non-empty `invalidSCCs` list. The
 * LP either succeeds for the whole graph or fails as a unit; SCC-level
 * granularity exists only in the `InvalidSCCInfo` reporting (mapping the
 * single global infeasibility back to which detected SCCs were involved,
 * so the UI can highlight specific cycles).
 */
export async function calculateFlows(
  graph: BipartiteGraph,
  sccs: SCCInfo[],
  targetRates: Map<ItemId, number>,
  maps: ProductionMaps,
  manualRawMaterials?: Set<ItemId>,
): Promise<{ flowData: FlowData; invalidSCCs: InvalidSCCInfo[] }> {
  const recipesList = Array.from(graph.recipeNodes.values()).map(
    (r) => r.recipe,
  );

  if (recipesList.length === 0) {
    // Nothing to solve. Either all targets are raws or the graph is
    // empty. Return a feasible no-op (no SCCs detected when no recipes).
    return {
      flowData: {
        itemDemands: new Map(targetRates),
        recipeFacilityCounts: new Map(),
      },
      invalidSCCs: [],
    };
  }

  // --- Build per-item constraints over every item in the graph ---
  const rawMaterials = new Set<ItemId>();
  for (const r of forcedRawMaterials) rawMaterials.add(r);
  for (const r of graph.rawMaterials) rawMaterials.add(r);
  if (manualRawMaterials) {
    for (const r of manualRawMaterials) rawMaterials.add(r);
  }

  const itemConstraints = new Map<ItemId, LPItemConstraint>();

  // Collect every item mentioned by any recipe (inputs or outputs).
  // Recipes added by `buildBipartiteGraph` may reference items that
  // aren't in `graph.itemNodes` (rare; mostly defensive).
  const allItems = new Set<ItemId>();
  for (const recipe of recipesList) {
    for (const input of recipe.inputs) allItems.add(input.itemId);
    for (const output of recipe.outputs) allItems.add(output.itemId);
  }
  for (const itemId of graph.itemNodes.keys()) allItems.add(itemId);

  for (const itemId of allItems) {
    if (rawMaterials.has(itemId)) continue;

    if (targetRates.has(itemId)) {
      // User-target items can be over-produced; the surplus surfaces in
      // the production view (and forced-disposal targets get a sink).
      itemConstraints.set(itemId, {
        type: "min",
        rhs: targetRates.get(itemId)!,
      });
    } else if (forcedDisposalItems.has(itemId)) {
      // Disposal-slack: production must cover consumption; deficits get
      // reported and propagated to upstream warnings. Surplus is fine
      // and gets handled post-solve by `injectDisposalRecipes`.
      itemConstraints.set(itemId, { type: "disposal-slack", rhs: 0 });
    } else {
      // Plain intermediate: production ≥ consumption (min: 0). LP-optimal
      // sets surplus = 0 because cost minimisation. The `min` semantics
      // (rather than `equal`) is robust against multi-output recipes
      // whose byproducts have no consumer in the plan — `equal: 0`
      // would refuse to run them; `min: 0` allows surplus that the
      // mapper can render as "unused byproduct".
      itemConstraints.set(itemId, { type: "min", rhs: 0 });
    }
  }

  const lpInput: LPInput = {
    recipes: recipesList,
    itemConstraints,
    rawMaterials,
    costlessRaws,
    facilityMap: maps.facilityMap,
  };

  if (import.meta.env?.DEV) {
    console.log(
      `[GLOBAL_FLOW] solving LP: ${recipesList.length} recipe vars, ${itemConstraints.size} item constraints, ${rawMaterials.size} raws`,
    );
  }

  const result = await solveLP(lpInput);

  if (!result.feasible) {
    if (import.meta.env?.DEV) {
      console.warn(`[GLOBAL_FLOW] LP infeasible: ${result.reason}`);
    }
    // Mark every detected SCC as invalid so the UI can highlight cycles
    // — LP infeasibility usually traces back to a cycle that can't
    // bootstrap. The mapper reads `invalidSCCs` for cycle styling.
    const invalidSCCs: InvalidSCCInfo[] = sccs.map((scc) => ({
      sccId: scc.id,
      involvedItems: scc.items,
      reason: scc.externalInputs.size === 0 ? "no_external_demand" : "no_solution",
    }));
    return {
      flowData: {
        itemDemands: new Map(targetRates),
        recipeFacilityCounts: new Map(),
      },
      invalidSCCs,
    };
  }

  if (import.meta.env?.DEV) {
    const activeRecipes = Array.from(result.facilityCounts.entries()).filter(
      ([, fc]) => fc > 0,
    );
    console.log(
      `[GLOBAL_FLOW] LP feasible: raw=${result.totalRawCost.toFixed(2)}, buildings=${result.totalBuildingCount.toFixed(2)}, power=${result.totalPower.toFixed(2)}; ${activeRecipes.length}/${recipesList.length} recipes active`,
    );
    if (result.disposalDeficits.size > 0) {
      console.warn(
        `[GLOBAL_FLOW] Disposal deficits:`,
        Object.fromEntries(result.disposalDeficits),
      );
    }
    detectMixedStrategies(graph, result.facilityCounts);
  }

  // --- Post-LP: derive itemDemands ---
  // Downstream consumers (calculator.ts buildProductionGraph) read
  // itemDemands only for raw items to compute their consumption rate;
  // populating it for all items mirrors the pre-LP behaviour and keeps
  // the data shape stable.
  //
  // For raw items specifically, we report **NET demand** (gross
  // consumption minus byproduct production from recipes that emit the
  // raw as a side-output, e.g. `liquid_purifier_xiranite_poly_1` emits
  // water). The pickup-count layer in the bin-fused mapper consumes
  // this value as `totalDemand` to size pump emissions; using gross
  // would over-count pickups.
  //
  // We sum gross consumption and gross production separately FIRST, then
  // compute net at the end — per-recipe netting interleaved with addition
  // would zero out negative intermediates and lose the byproduct credit
  // whenever a producer is processed before its consumers.
  const itemDemands = new Map<ItemId, number>(targetRates);
  const rawByproduct = new Map<ItemId, number>();
  for (const [recipeId, fc] of result.facilityCounts.entries()) {
    if (fc <= 0) continue;
    const recipe = maps.recipeMap.get(recipeId)!;
    for (const input of recipe.inputs) {
      const consumed = calcRate(input.amount, recipe.craftingTime) * fc;
      itemDemands.set(
        input.itemId,
        (itemDemands.get(input.itemId) || 0) + consumed,
      );
    }
    for (const output of recipe.outputs) {
      if (!rawMaterials.has(output.itemId)) continue;
      const produced = calcRate(output.amount, recipe.craftingTime) * fc;
      rawByproduct.set(
        output.itemId,
        (rawByproduct.get(output.itemId) || 0) + produced,
      );
    }
  }
  // Apply byproduct netting once: net = max(0, gross - byproduct).
  // Floor at 0 because byproduct surplus exceeding consumption means net
  // demand on the pump is zero (surplus is silently discarded — same as
  // pre-LP semantics; injectDisposalRecipes handles forced-disposal raws
  // separately).
  for (const [itemId, produced] of rawByproduct.entries()) {
    const current = itemDemands.get(itemId) || 0;
    itemDemands.set(itemId, Math.max(0, current - produced));
  }

  return {
    flowData: {
      itemDemands,
      recipeFacilityCounts: result.facilityCounts,
    },
    invalidSCCs: [],
  };
}

/**
 * Dev-only diagnostic: detect items with multiple active producers in
 * the LP solution (a "mixed strategy"). Genuinely forced mixes occur
 * in real-data plans where multi-output recipes have byproduct balance
 * constraints — e.g. SC Wuling + Heavy Xiranite produces a mix on
 * `item_liquid_sewage` (furnace + pool) and `item_liquid_xiranite_poly`
 * (pool + purifier) because the LP needs both to balance lowpoly/sewage
 * flows. They're correct, not artifacts.
 *
 * Logged for telemetry. Does NOT throw, even in test mode: mixed
 * strategies are valid LP outputs and the table renderer
 * (`mergeItemNodes` in `useProductionTable.ts`) handles them by
 * emitting one row per active producer.
 */
function detectMixedStrategies(
  graph: BipartiteGraph,
  facilityCounts: Map<RecipeId, number>,
): void {
  const producersByItem = new Map<ItemId, RecipeId[]>();
  for (const [recipeId, fc] of facilityCounts.entries()) {
    if (fc <= 0) continue;
    const outputs = graph.recipeOutputs.get(recipeId);
    if (!outputs) continue;
    for (const itemId of outputs) {
      if (!producersByItem.has(itemId)) producersByItem.set(itemId, []);
      producersByItem.get(itemId)!.push(recipeId);
    }
  }
  for (const [itemId, producers] of producersByItem.entries()) {
    if (producers.length < 2) continue;
    const counts = producers
      .map((r) => `${r}=${facilityCounts.get(r)!.toFixed(3)}`)
      .join(", ");
    console.log(
      `[MIXED-STRATEGY] item ${itemId} has ${producers.length} active producers: ${counts}`,
    );
  }
}
