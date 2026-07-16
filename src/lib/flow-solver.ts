import type { FacilityId, ItemId, RecipeId } from "@/types";
import { forcedDisposalItems, costlessRaws, rawMaterialSources } from "@/data";
import { calcRate, getRawSourceRate } from "@/lib/utils";
import {
  solveLP,
  type LPInput,
  type LPItemConstraint,
  type LPMetastorageImport,
  type LPPowerBalance,
  type LPSolution,
} from "./lp-solver";
import type {
  ProductionMaps,
  BipartiteGraph,
  SCCInfo,
  FlowData,
  FlowSolveMetrics,
  InvalidSCCInfo,
  MetastorageFlow,
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
 *     The LP must produce ≥ consumption; surplus is absorbed by the
 *     disposal recipes pre-injected into the graph by `buildBipartite
 *     Graph` (Liquid Cleaner + Sewage Inlet variants); deficit goes to
 *     a `disposalDeficit` map that the UI surfaces as a warning.
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
  rawCaps?: ReadonlyMap<ItemId, number>,
  facilityCaps?: ReadonlyMap<FacilityId, number>,
  /**
   * Metastorage import routes, **one selected item each** (the
   * auto-selection enumeration in `calculator.ts` calls this function
   * once per candidate). Each route adds one supply variable + a soft
   * TTV budget row to the LP — see `LPMetastorageImport`.
   */
  metastorageImports?: readonly LPMetastorageImport[],
  /**
   * Thermal Bank power generation. When `generationByRecipe` is
   * non-empty, the LP gains a hard power-balance row — generation must
   * cover fractional consumption incl. pump power — and, when
   * `minGeneration` is set, a hard whole-building generation floor
   * (the calculator's ceil-floor loop). See `LPPowerBalance`.
   */
  powerBalanceInput?: {
    generationByRecipe: ReadonlyMap<RecipeId, number>;
    minGeneration?: number;
  },
): Promise<{
  flowData: FlowData;
  invalidSCCs: InvalidSCCInfo[];
  /** Solution-quality metrics for the Metastorage candidate enumeration. */
  metrics: FlowSolveMetrics;
}> {
  const recipesList = Array.from(graph.recipeNodes.values()).map(
    (r) => r.recipe,
  );

  // Zero-recipe early return — only when every target is a raw (the
  // legacy "nothing to solve" case: graph empty or all targets raw).
  // Two situations deliberately FALL THROUGH to the LP instead:
  //   - Metastorage routes present: an import-only plan has zero
  //     recipe variables but live import variables.
  //   - A non-raw target exists (possible since Metastorage: an
  //     import-eligible producer-less target skips raw promotion).
  //     The LP reports it structurally infeasible — returning the
  //     feasible no-op here would fake success with zero supply.
  if (recipesList.length === 0 && (metastorageImports?.length ?? 0) === 0) {
    const allTargetsRaw = Array.from(targetRates.keys()).every((itemId) => {
      const node = graph.itemNodes.get(itemId);
      return node ? node.isRawMaterial : true;
    });
    if (allTargetsRaw) {
      return {
        flowData: {
          itemDemands: new Map(targetRates),
          recipeFacilityCounts: new Map(),
          metastorageFlows: [],
        },
        invalidSCCs: [],
        metrics: {
          feasible: true,
          slackMagnitude: 0,
          ttvOverusePerMinute: 0,
          powerShortfall: 0,
          totalRawCost: 0,
          totalBuildingCount: 0,
          totalPower: 0,
          totalTtvUsedPerMinute: 0,
        },
      };
    }
  }

  // --- Build per-item constraints over every item in the graph ---
  //
  // `graph.rawMaterials` already includes:
  //   - items in the per-region raw set the caller passed to
  //     `buildBipartiteGraph` that were visited during target-rooted
  //     traversal, AND
  //   - chain-leaf items auto-detected during traversal (items with
  //     no surviving producer recipe).
  //
  // We union with `manualRawMaterials` to cover manual-raw pins on
  // items NOT reached by target traversal (e.g. user pinned a raw on
  // an item then deleted the target that consumed it — the pin
  // remains in state but the item never enters the graph). These
  // items don't appear in any recipe constraint, so adding them is
  // a no-op for the LP, but the union keeps `rawMaterials` semantically
  // complete for callers that inspect it.
  const rawMaterials = new Set<ItemId>();
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

  // Pre-compute which forced-disposal items actually have a consumer in
  // the active graph. Strict-balance (equality) semantics only make
  // sense when a consumer exists — without one, surplus is structurally
  // unavoidable and slack-penalising it is meaningless. Items with no
  // consumer fall back to plain `min: 0` (the historical behaviour for
  // dead-end byproducts).
  const forcedDisposalItemsWithConsumer = new Set<ItemId>();
  for (const item of forcedDisposalItems) {
    const consumers = graph.itemConsumedBy.get(item);
    if (consumers && consumers.size > 0) {
      forcedDisposalItemsWithConsumer.add(item);
    }
  }

  for (const itemId of allItems) {
    if (rawMaterials.has(itemId)) continue;

    // Forced-disposal items WITH a consumer use strict-balance slack
    // semantics (whether the user also targets them or not). The
    // constraint becomes `production - consumption = targetRate` (with
    // two-sided slack absorbing both deficit and surplus). This forces
    // the LP to exactly hit target rate AND dispose every unit of
    // byproduct produced beyond it via the available disposer recipes,
    // instead of letting surplus dangle (the `min: rhs` default would
    // permit production > consumption + rhs).
    if (forcedDisposalItemsWithConsumer.has(itemId)) {
      const targetRate = targetRates.get(itemId) ?? 0;
      itemConstraints.set(itemId, {
        type: "disposal-slack",
        rhs: targetRate,
      });
    } else if (targetRates.has(itemId)) {
      // User-target items can be over-produced; the surplus surfaces in
      // the production view.
      itemConstraints.set(itemId, {
        type: "min",
        rhs: targetRates.get(itemId)!,
      });
    } else {
      // Plain intermediate (and forced-disposal items with no consumer
      // in this plan): production ≥ consumption (min: 0). LP-optimal
      // sets surplus = 0 because cost minimisation. The `min` semantics
      // (rather than `equal`) is robust against multi-output recipes
      // whose byproducts have no consumer in the plan — `equal: 0`
      // would refuse to run them; `min: 0` allows surplus that the
      // mapper can render as "unused byproduct".
      itemConstraints.set(itemId, { type: "min", rhs: 0 });
    }
  }

  // Power-balance input: forward the generation map (+ optional
  // whole-building floor) and derive the per-raw-item pump-power rates
  // (source-facility watts per item/min) from `rawMaterialSources` —
  // the same data the display-side pickup fold in `aggregateBinTotals`
  // uses, so LP balance and displayed consumption agree.
  // Synthetic-test raws absent from `rawMaterialSources` (or whose
  // source facility isn't in the plan's facilityMap) simply contribute
  // no pump power.
  let powerBalance: LPPowerBalance | undefined;
  if (
    powerBalanceInput &&
    powerBalanceInput.generationByRecipe.size > 0
  ) {
    const pumpPowerPerItemRate = new Map<ItemId, number>();
    for (const [itemId, cfg] of rawMaterialSources) {
      const sourcePower =
        maps.facilityMap.get(cfg.sourceFacility)?.powerConsumption ?? 0;
      if (sourcePower <= 0) continue;
      const perFacilityRate = getRawSourceRate(itemId, maps.itemMap.get(itemId));
      if (perFacilityRate <= 0) continue;
      pumpPowerPerItemRate.set(itemId, sourcePower / perFacilityRate);
    }
    powerBalance = {
      generationByRecipe: powerBalanceInput.generationByRecipe,
      pumpPowerPerItemRate,
      minGeneration: powerBalanceInput.minGeneration,
    };
  }

  const lpInput: LPInput = {
    recipes: recipesList,
    itemConstraints,
    rawMaterials,
    costlessRaws,
    rawCaps,
    facilityCaps,
    metastorageImports,
    powerBalance,
    facilityMap: maps.facilityMap,
  };

  if (import.meta.env?.DEV) {
    console.log(
      `[GLOBAL_FLOW] solving LP: ${recipesList.length} recipe vars, ${itemConstraints.size} item constraints, ${rawMaterials.size} raws, ${metastorageImports?.length ?? 0} metastorage route(s)`,
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
        metastorageFlows: [],
      },
      invalidSCCs,
      metrics: {
        feasible: false,
        failureReason: result.reason,
        slackMagnitude: 0,
        ttvOverusePerMinute: 0,
        powerShortfall: 0,
        totalRawCost: 0,
        totalBuildingCount: 0,
        totalPower: 0,
        totalTtvUsedPerMinute: 0,
      },
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
    if (result.disposalSurpluses.size > 0) {
      // Surplus = LP wanted to dispose more than available disposer
      // capacity allowed. Typical trigger: LIQUID_CLEAN_GATE_1 capped at N
      // while sewage production exceeds N × 120/min and no Liquid
      // Cleaner is available in the current domain.
      console.warn(
        `[GLOBAL_FLOW] Disposal surpluses (unabsorbed by disposer recipes):`,
        Object.fromEntries(result.disposalSurpluses),
      );
    }
    if (result.rawCapOveruse.size > 0) {
      // Mirror of the disposal-deficits log: the LP found a feasible
      // solution by spending cap-slack — the plan exceeds at least one
      // user-set raw-material limit. Informational only; over-cap
      // warnings already surface in the UI via `computeRawOverCapWarnings`.
      console.warn(
        `[GLOBAL_FLOW] Raw-cap overuse:`,
        Object.fromEntries(result.rawCapOveruse),
      );
    }
    if (result.importRates.size > 0) {
      for (const [source, rates] of result.importRates) {
        console.log(
          `[GLOBAL_FLOW] Metastorage imports from ${source}:`,
          Object.fromEntries(rates),
          `(TTV ${result.ttvUsedPerMinute.get(source)?.toFixed(2) ?? 0}/min)`,
        );
      }
    }
    if (result.ttvOveruse.size > 0) {
      console.warn(
        `[GLOBAL_FLOW] Metastorage TTV budget overuse:`,
        Object.fromEntries(result.ttvOveruse),
      );
    }
    detectMixedStrategies(graph, result.facilityCounts);
  }

  // --- Feasible-with-deficit: translate disposal slack to invalid SCCs ---
  //
  // The LP can report `feasible` even when a forced-disposal item's
  // `disposal-slack` variable absorbs a positive deficit (lp-solver
  // assigns `SLACK_PENALTY` per unit so this only happens when no
  // recipe combination satisfies the constraint without it). A non-zero
  // slack means some downstream consumer is "running" against supply
  // that doesn't actually exist — facility counts are populated but the
  // chain is operationally a phantom.
  //
  // The classic trigger: user pins a dismantle (fbottle-consuming)
  // recipe for a forced-disposal item whose corresponding FILLING
  // recipe consumes the same item to remake the fbottle. The bottle
  // balance forces `x_dism = x_fill`, all dismantler output gets eaten
  // by FILLING, and the original consumer's demand falls into slack.
  //
  // Each non-zero deficit gets mapped back to the SCC containing the
  // affected item — Tarjan SCCs partition the item set, so `find`
  // returns at most one. The existing `cycleWarning` pipeline in
  // `useProductionPlan` then surfaces this (it filters
  // `overriddenItemIds.length > 0`, which the user's pin guarantees).
  //
  // Dedupe by `sccId` because multiple deficit items can sit in the
  // same SCC (e.g. Sewage + Effluent both trapped in one cycle).
  const invalidSCCs: InvalidSCCInfo[] = [];
  const seenSccIds = new Set<string>();
  for (const [itemId, deficit] of result.disposalDeficits) {
    if (deficit <= 0) continue;
    const scc = sccs.find((s) => s.items.has(itemId));
    if (!scc) {
      // Defensive: in current data every forced-disposal item with a
      // deficit lives inside an SCC (byproduct chains form cycles). If
      // a future game-data shift produces a non-cyclic deficit, the
      // user-facing warning would silently disappear — log it so the
      // gap is observable in dev mode.
      if (import.meta.env?.DEV) {
        console.warn(
          `[GLOBAL_FLOW] deficit on ${itemId} (${deficit.toFixed(2)}/min) has no containing SCC; warning not surfaced`,
        );
      }
      continue;
    }
    if (seenSccIds.has(scc.id)) continue;
    seenSccIds.add(scc.id);
    invalidSCCs.push({
      sccId: scc.id,
      involvedItems: scc.items,
      reason: "no_solution",
    });
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
  // pre-LP semantics; forced-disposal raws are handled separately via
  // disposal-injection in `buildBipartiteGraph` + the LP's disposal-
  // slack constraint).
  for (const [itemId, produced] of rawByproduct.entries()) {
    const current = itemDemands.get(itemId) || 0;
    itemDemands.set(itemId, Math.max(0, current - produced));
  }

  return {
    flowData: {
      itemDemands,
      recipeFacilityCounts: result.facilityCounts,
      metastorageFlows: buildMetastorageFlows(metastorageImports, result),
    },
    invalidSCCs,
    metrics: buildSolveMetrics(result),
  };
}

/**
 * Join the input routes with the LP's import-rate / TTV outputs into the
 * flat per-route report consumed by `calculator.ts` (plan surfacing;
 * overuse entries feed the candidate-rejection diagnostics). Routes the
 * LP left unused (rate 0, no overuse) are omitted.
 */
function buildMetastorageFlows(
  metastorageImports: readonly LPMetastorageImport[] | undefined,
  result: LPSolution,
): MetastorageFlow[] {
  if (!metastorageImports || metastorageImports.length === 0) return [];
  const flows: MetastorageFlow[] = [];
  for (const route of metastorageImports) {
    const rate =
      result.importRates.get(route.sourceDomain)?.get(route.itemId) ?? 0;
    const overuse = result.ttvOveruse.get(route.sourceDomain) ?? 0;
    if (rate <= 0 && overuse <= 0) continue;
    flows.push({
      sourceDomain: route.sourceDomain,
      itemId: route.itemId,
      ratePerMinute: rate,
      ttvCostPerItem: route.ttvCostPerItem,
      ttvUsedPerMinute: rate * route.ttvCostPerItem,
      ttvBudgetPerMinute: route.ttvBudgetPerMinute,
      ttvOverusePerMinute: overuse,
    });
  }
  return flows;
}

/** Fold an LP solution into the enumeration-comparison metrics. */
function buildSolveMetrics(result: LPSolution): FlowSolveMetrics {
  let slack = 0;
  for (const v of result.disposalDeficits.values()) slack += v;
  for (const v of result.disposalSurpluses.values()) slack += v;
  for (const v of result.rawCapOveruse.values()) slack += v;
  let ttvOveruse = 0;
  for (const v of result.ttvOveruse.values()) ttvOveruse += v;
  slack += ttvOveruse;
  // `powerShortfall` is deliberately NOT folded into `slackMagnitude`:
  // watts and items/min are incommensurable, and summing them once let
  // the Metastorage selection trade a 50 ore/min cap violation for a
  // token 367 W of generation (user-reported route flip). It rides as
  // its own field and its own — lower-priority — comparison key in
  // `compareSolveMetrics`.
  let ttvUsed = 0;
  for (const v of result.ttvUsedPerMinute.values()) ttvUsed += v;
  return {
    feasible: true,
    slackMagnitude: slack,
    ttvOverusePerMinute: ttvOveruse,
    powerShortfall: result.powerShortfall,
    totalRawCost: result.totalRawCost,
    totalBuildingCount: result.totalBuildingCount,
    totalPower: result.totalPower,
    totalTtvUsedPerMinute: ttvUsed,
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
