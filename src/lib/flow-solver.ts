import type { ItemId, RecipeId, Recipe } from "@/types";
import { forcedRawMaterials, forcedDisposalItems, costlessRaws } from "@/data";
import { calcRate } from "@/lib/utils";
import { selectRecipe } from "./graph-builder";
import { solveLP, type LPInput, type LPItemConstraint } from "./lp-solver";

/**
 * Tolerance for post-LP target-satisfaction validation. The LP solver's
 * internal precision means a feasible solution may report a target item's
 * net production as e.g. 30 - 1e-7 = 29.9999999. We treat anything within
 * 1e-6 of the demand as satisfied.
 */
const TARGET_VALIDATION_TOLERANCE = 1e-6;
import type {
  ProductionMaps,
  BipartiteGraph,
  SCCInfo,
  CondensedNode,
  FlowData,
  InvalidSCCInfo,
} from "./calculator-types";

export async function calculateFlows(
  graph: BipartiteGraph,
  condensedOrder: CondensedNode[],
  targetRates: Map<ItemId, number>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  manualRawMaterials?: Set<ItemId>,
): Promise<{ flowData: FlowData; invalidSCCs: InvalidSCCInfo[] }> {
  const itemDemands = new Map<ItemId, number>();
  const recipeFacilityCounts = new Map<RecipeId, number>();
  const resolvedSCCIds = new Set<string>();
  const invalidSCCs: InvalidSCCInfo[] = [];

  targetRates.forEach((rate, itemId) => {
    itemDemands.set(itemId, rate);
  });

  const reversedOrder = [...condensedOrder].reverse();

  console.log(
    `[FLOW] Processing ${reversedOrder.length} condensed nodes in topological order`,
  );

  // Sequential async loop — each SCC's solve depends on the running
  // `itemDemands` / `recipeFacilityCounts` state populated by earlier
  // iterations, so we await each before processing the next. Using
  // a for-of loop instead of `.forEach` so `await` works correctly.
  for (let idx = 0; idx < reversedOrder.length; idx++) {
    const node = reversedOrder[idx];
    if (node.type === "scc") {
      console.log(`[FLOW] [${idx}] Processing SCC: ${node.scc.id}`);
      const solved = await solveSCCFlow(
        node.scc,
        graph,
        itemDemands,
        recipeFacilityCounts,
        targetRates,
        maps,
        recipeOverrides,
        resolvedSCCIds,
        manualRawMaterials,
      );

      if (!solved) {
        const reason =
          node.scc.externalInputs.size === 0
            ? "no_external_demand"
            : "no_solution";
        invalidSCCs.push({
          sccId: node.scc.id,
          involvedItems: node.scc.items,
          reason,
        });
        console.log(
          `  [FLOW] Recorded invalid SCC: ${node.scc.id} (${reason})`,
        );
      }
    } else if (node.type === "recipe") {
      console.log(`[FLOW] [${idx}] Processing recipe: ${node.recipeId}`);
      const recipeData = graph.recipeNodes.get(node.recipeId)!;
      const recipe = recipeData.recipe;

      const outputs = graph.recipeOutputs.get(node.recipeId)!;

      let facilityCount = 0;

      outputs.forEach((itemId) => {
        const demand = itemDemands.get(itemId) || 0;
        const output = recipe.outputs.find((o) => o.itemId === itemId);
        if (!output) return;

        const rate = calcRate(output.amount, recipe.craftingTime);
        if (rate > 0) {
          facilityCount = Math.max(facilityCount, demand / rate);
        }
      });

      recipeFacilityCounts.set(node.recipeId, facilityCount);
      console.log(`  Facility count: ${facilityCount.toFixed(4)}`);

      recipe.inputs.forEach((input) => {
        const inputDemand =
          calcRate(input.amount, recipe.craftingTime) * facilityCount;
        itemDemands.set(
          input.itemId,
          (itemDemands.get(input.itemId) || 0) + inputDemand,
        );
      });
    } else if (node.type === "item") {
      console.log(`[FLOW] [${idx}] Processing item: ${node.itemId}`);
    }
  }

  return {
    flowData: { itemDemands, recipeFacilityCounts, resolvedSCCIds },
    invalidSCCs,
  };
}

/**
 * Compute Phase 1 external demands and Phase 2 external output demands.
 */
function collectExternalDemands(
  scc: SCCInfo,
  graph: BipartiteGraph,
  recipeFacilityCounts: Map<RecipeId, number>,
  targetRates: Map<ItemId, number>,
  maps: ProductionMaps,
): {
  externalDemands: Map<ItemId, number>;
  externalOutputByItem: Map<
    ItemId,
    { demand: number; producers: { recipeIdx: number; rate: number }[] }
  >;
} {
  const externalDemands = new Map<ItemId, number>();
  const recipesList = Array.from(scc.recipes).map(
    (rid) => maps.recipeMap.get(rid)!,
  );

  scc.items.forEach((itemId) => {
    let demand = 0;
    const consumers = graph.itemConsumedBy.get(itemId);
    if (consumers) {
      consumers.forEach((recipeId) => {
        if (!scc.recipes.has(recipeId)) {
          const fc = recipeFacilityCounts.get(recipeId) || 0;
          const recipe = maps.recipeMap.get(recipeId)!;
          const input = recipe.inputs.find((i) => i.itemId === itemId);
          if (input) {
            demand += calcRate(input.amount, recipe.craftingTime) * fc;
          }
        }
      });
    }
    if (graph.targets.has(itemId)) {
      demand += targetRates.get(itemId) || 0;
    }
    if (demand > 0) externalDemands.set(itemId, demand);
  });

  // External outputs are items produced by SCC recipes but NOT in
  // `scc.items`. Their downstream consumer demand lives in `itemDemands`,
  // which this helper doesn't take as a parameter — the caller fills the
  // `demand` field after this function returns.
  const externalOutputByItem = new Map<
    ItemId,
    { demand: number; producers: { recipeIdx: number; rate: number }[] }
  >();
  for (let j = 0; j < recipesList.length; j++) {
    const recipe = recipesList[j];
    for (const out of recipe.outputs) {
      if (scc.items.has(out.itemId)) continue;
      const rate = calcRate(out.amount, recipe.craftingTime);
      if (rate <= 0) continue;
      let entry = externalOutputByItem.get(out.itemId);
      if (!entry) {
        entry = { demand: 0, producers: [] };
        externalOutputByItem.set(out.itemId, entry);
      }
      entry.producers.push({ recipeIdx: j, rate });
    }
  }
  return { externalDemands, externalOutputByItem };
}

/**
 * Determine whether a disposal item has any producer outside the given SCC.
 * If yes, the item's deficit inside the SCC can legitimately be propagated
 * to that external producer (the linear-DAG flow scales the upstream
 * recipe). If no, the LP must enforce strict balance — there is no
 * upstream that could fill a gap.
 */
function hasExternalProducer(
  itemId: ItemId,
  scc: SCCInfo,
  graph: BipartiteGraph,
): boolean {
  for (const [recipeId, outputs] of graph.recipeOutputs.entries()) {
    if (scc.recipes.has(recipeId)) continue;
    if (outputs.has(itemId)) return true;
  }
  return false;
}

/**
 * Build LP item-constraint set for an SCC's flow problem.
 *
 * For each item in `scc.items`:
 *   - Skipped if raw material (the LP-solver module also drops raw items
 *     from constraints; consumption appears only in the `rawCost` objective).
 *   - Strict equality (`production - consumption = externalDemand`) for
 *     non-disposal items — every unit must have a consumer.
 *   - For forced-disposal items, the constraint depends on `hasExternalProducer`:
 *     - WITH external producer: `disposal-slack` (`prod - cons + slack ≥
 *       externalDemand`, slack ≥ 0). Slack absorbs deficit and is propagated
 *       to upstream producers via `itemDemands`.
 *     - WITHOUT external producer: `min` (`prod - cons ≥ externalDemand`).
 *       Surplus goes to post-solve disposal sinks; deficit is impossible
 *       (LP would be infeasible) since no upstream can fill the gap.
 *
 * For each item in `externalOutputDemands` (items NOT in `scc.items` but
 * produced by SCC recipes with downstream demand):
 *   - `min` (`≥ demand`); over-production is allowed and surfaced as
 *     elevated production rate (or disposed for forced-disposal items).
 */
function buildLPInputForSCC(
  scc: SCCInfo,
  externalDemands: Map<ItemId, number>,
  externalOutputDemands: Map<ItemId, number>,
  graph: BipartiteGraph,
  maps: ProductionMaps,
): LPInput {
  const recipesList = Array.from(scc.recipes).map(
    (rid) => maps.recipeMap.get(rid)!,
  );
  const itemConstraints = new Map<ItemId, LPItemConstraint>();

  for (const itemId of scc.items) {
    if (graph.rawMaterials.has(itemId)) continue;
    const externalDemand = externalDemands.get(itemId) || 0;
    if (forcedDisposalItems.has(itemId)) {
      // Choose constraint type based on whether deficit is recoverable
      // upstream. WITH external producer (e.g. Sewage from Furnace outside
      // SCC) → `disposal-slack`: slack absorbs deficit, propagated to
      // itemDemands so upstream scales up. WITHOUT external producer →
      // `min`: surplus goes to post-solve disposal sink; deficit is
      // impossible (no upstream to fill it). Strict equality would force
      // absorber recipes to over-run upstream surplus — the PR #73 bug.
      const externalProducer = hasExternalProducer(itemId, scc, graph);
      if (externalProducer) {
        itemConstraints.set(itemId, {
          type: "disposal-slack",
          rhs: externalDemand,
        });
      } else {
        itemConstraints.set(itemId, { type: "min", rhs: externalDemand });
      }
    } else {
      itemConstraints.set(itemId, { type: "equal", rhs: externalDemand });
    }
  }

  for (const [itemId, demand] of externalOutputDemands.entries()) {
    if (graph.rawMaterials.has(itemId)) continue;
    if (itemConstraints.has(itemId)) continue;
    // External output items use `min` — under-production isn't allowed
    // (demand reflects user targets or downstream consumer rates), but
    // surplus is fine (disposed post-solve for forced-disposal items;
    // otherwise visible as elevated production rate).
    itemConstraints.set(itemId, { type: "min", rhs: demand });
  }

  // Aggregate raw-materials set: union of forced + manual + graph-tracked.
  const rawMaterials = new Set<ItemId>();
  for (const r of forcedRawMaterials) rawMaterials.add(r);
  for (const r of graph.rawMaterials) rawMaterials.add(r);

  return {
    recipes: recipesList,
    itemConstraints,
    rawMaterials,
    costlessRaws,
    facilityMap: maps.facilityMap,
  };
}

/**
 * Propagate raw-material consumption inside an SCC to `itemDemands`.
 *
 * The LP excludes raw materials from balance constraints (infinite supply).
 * When Tarjan places a raw in `scc.items` via a byproduct cycle (e.g.
 * water through `LIQUID_PURIFIER_XIRANITE_POLY`), Phase 5 misses it
 * because `scc.externalInputs` excludes `scc.items` by definition.
 *
 * Mirrors master heuristic's Phase 4 deficit logic, restricted to raw
 * items. `deficit = externalDemand − netProduction`, propagated via
 * `Math.max(existing, deficit)`. Surplus byproduct (negative deficit) is
 * ignored — conservative; never under-counts raw demand.
 */
function propagateRawMaterialDeficit(
  scc: SCCInfo,
  recipesList: Recipe[],
  recipeFacilityCounts: Map<RecipeId, number>,
  externalDemands: Map<ItemId, number>,
  itemDemands: Map<ItemId, number>,
  graph: BipartiteGraph,
  contextLabel: string,
): void {
  for (const itemId of scc.items) {
    if (!graph.rawMaterials.has(itemId)) continue;

    let netProduction = 0;
    for (const recipe of recipesList) {
      const fc = recipeFacilityCounts.get(recipe.id) ?? 0;
      if (fc === 0) continue;
      const outAmt =
        recipe.outputs.find((o) => o.itemId === itemId)?.amount ?? 0;
      const inAmt =
        recipe.inputs.find((i) => i.itemId === itemId)?.amount ?? 0;
      netProduction +=
        (calcRate(outAmt, recipe.craftingTime) -
          calcRate(inAmt, recipe.craftingTime)) *
        fc;
    }

    const externalDemand = externalDemands.get(itemId) ?? 0;
    const deficit = externalDemand - netProduction;

    if (deficit > 1e-9) {
      itemDemands.set(
        itemId,
        Math.max(itemDemands.get(itemId) ?? 0, deficit),
      );
      if (import.meta.env?.DEV) {
        console.log(
          `  [${contextLabel}] Raw ${itemId} deficit ${deficit.toFixed(4)}/min — propagated`,
        );
      }
    }
  }
}

async function solveSCCFlow(
  scc: SCCInfo,
  graph: BipartiteGraph,
  itemDemands: Map<ItemId, number>,
  recipeFacilityCounts: Map<RecipeId, number>,
  targetRates: Map<ItemId, number>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  resolvedSCCIds?: Set<string>,
  manualRawMaterials?: Set<ItemId>,
): Promise<boolean> {
  console.log(`[SCC_SOLVE] Solving flow for SCC: ${scc.id}`);

  const recipesList = Array.from(scc.recipes).map(
    (rid) => maps.recipeMap.get(rid)!,
  );
  if (recipesList.length === 0 || scc.items.size === 0) {
    console.log(`  [SCC_SOLVE] Empty system, skipping`);
    return false;
  }

  // --- Phase 1 + 2: external demands + external output demands ---
  const { externalDemands, externalOutputByItem } = collectExternalDemands(
    scc,
    graph,
    recipeFacilityCounts,
    targetRates,
    maps,
  );
  // Populate external-output demands from itemDemands (helper omits this).
  const externalOutputDemands = new Map<ItemId, number>();
  for (const itemId of externalOutputByItem.keys()) {
    const d = itemDemands.get(itemId) || 0;
    if (d > 0) externalOutputDemands.set(itemId, d);
  }
  // Drop entries that have zero demand — they don't constrain the LP.
  for (const itemId of [...externalOutputByItem.keys()]) {
    if (!externalOutputDemands.has(itemId)) {
      externalOutputByItem.delete(itemId);
    }
  }

  if (externalDemands.size === 0 && externalOutputByItem.size === 0) {
    console.log(`  [SCC_SOLVE] No external demand, this is an invalid cycle`);
    return tryExtendSCCWithFeeders(
      scc,
      graph,
      itemDemands,
      recipeFacilityCounts,
      targetRates,
      maps,
      recipeOverrides,
      resolvedSCCIds,
      manualRawMaterials,
    );
  }

  console.log(
    `  [SCC_SOLVE] External demands: ${externalDemands.size} item(s); external outputs: ${externalOutputByItem.size} item(s)`,
  );

  // --- Build LP input and solve ---
  const lpInput = buildLPInputForSCC(
    scc,
    externalDemands,
    externalOutputDemands,
    graph,
    maps,
  );
  const result = await solveLP(lpInput);

  if (!result.feasible) {
    console.warn(
      `  [SCC_SOLVE] Infeasible (${result.reason}); falling through to feeder extension`,
    );
    return tryExtendSCCWithFeeders(
      scc,
      graph,
      itemDemands,
      recipeFacilityCounts,
      targetRates,
      maps,
      recipeOverrides,
      resolvedSCCIds,
      manualRawMaterials,
    );
  }

  console.log(
    `  [SCC_SOLVE] Solution found (raw=${result.totalRawCost.toFixed(2)}, power=${result.totalPower.toFixed(2)}):`,
  );
  for (const recipe of recipesList) {
    const fc = result.facilityCounts.get(recipe.id) ?? 0;
    recipeFacilityCounts.set(recipe.id, fc);
    console.log(`    Recipe ${recipe.id}: ${fc.toFixed(4)} facilities`);
  }

  // --- Phase 4: Propagate disposal deficits ---
  // Disposal-slack constraints with positive slack values mean the SCC has
  // a deficit on that disposal item that must be supplied by upstream
  // producers (typically scaled up via the linear-DAG flow processing).
  // The LP module already filters deficits below its epsilon, so every
  // entry here is meaningful.
  for (const [itemId, deficit] of result.disposalDeficits.entries()) {
    itemDemands.set(itemId, Math.max(itemDemands.get(itemId) || 0, deficit));
    console.log(
      `  [SCC_SOLVE] Item ${itemId} disposal deficit ${deficit.toFixed(4)}/min — propagated`,
    );
  }

  // --- Phase 4.5: Propagate raw-material consumption inside SCC ---
  // Raw materials in scc.items (placed there by Tarjan via byproduct
  // cycles, e.g. water through LIQUID_PURIFIER_XIRANITE_POLY) are
  // excluded from LP constraints and missed by Phase 5. Mirrors master's
  // Phase 4 semantics for raw items only.
  propagateRawMaterialDeficit(
    scc,
    recipesList,
    recipeFacilityCounts,
    externalDemands,
    itemDemands,
    graph,
    "SCC_SOLVE",
  );

  // --- Phase 5: Propagate external-input consumption ---
  scc.externalInputs.forEach((inputItemId) => {
    let totalConsumption = 0;
    scc.recipes.forEach((recipeId) => {
      const recipe = maps.recipeMap.get(recipeId)!;
      const fc = recipeFacilityCounts.get(recipeId) || 0;
      const input = recipe.inputs.find((i) => i.itemId === inputItemId);
      if (input) {
        totalConsumption += calcRate(input.amount, recipe.craftingTime) * fc;
      }
    });
    if (totalConsumption > 0) {
      itemDemands.set(
        inputItemId,
        (itemDemands.get(inputItemId) || 0) + totalConsumption,
      );
      console.log(
        `  [SCC_SOLVE] External input ${inputItemId} demand: ${totalConsumption.toFixed(4)}/min`,
      );
    }
  });

  return true;
}

/**
 * Recover from an SCC that the main `solveSCCFlow` couldn't satisfy by
 * adding an alternative producer (a "feeder") for one or more SCC items
 * that have a recipe override pointing at an in-SCC recipe.
 *
 * Process:
 *   1. For each SCC item with a recipe override, find an alternative
 *      recipe outside the SCC that produces it; add it as a feeder.
 *   2. Mutate the bipartite graph + SCC info to include the feeder
 *      recipes (with rollback bookkeeping in case the LP still fails).
 *   3. Build an LP for the extended SCC, pinning the original
 *      override recipe(s) so LP honors the user's recipe choice.
 *   4. Validate that target items in the SCC are satisfied; rollback if
 *      not.
 *   5. Propagate external-input consumption into `itemDemands` so
 *      upstream linear-DAG processing scales producers accordingly.
 */
async function tryExtendSCCWithFeeders(
  scc: SCCInfo,
  graph: BipartiteGraph,
  itemDemands: Map<ItemId, number>,
  recipeFacilityCounts: Map<RecipeId, number>,
  targetRates: Map<ItemId, number>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  resolvedSCCIds?: Set<string>,
  manualRawMaterials?: Set<ItemId>,
): Promise<boolean> {
  if (!recipeOverrides || recipeOverrides.size === 0) return false;

  const feedersAdded: {
    feederRecipe: import("@/types").Recipe;
    overrideRecipeId: RecipeId;
    overrideDemand: number;
  }[] = [];

  for (const itemId of scc.items) {
    if (!recipeOverrides.has(itemId)) continue;
    const overrideRecipeId = recipeOverrides.get(itemId)!;
    if (!scc.recipes.has(overrideRecipeId)) continue;

    const alternatives = Array.from(maps.recipeMap.values()).filter(
      (r) =>
        r.id !== overrideRecipeId &&
        !scc.recipes.has(r.id) &&
        r.outputs.some((o) => o.itemId === itemId) &&
        r.inputs.some((inp) => !scc.items.has(inp.itemId)),
    );
    if (alternatives.length === 0) continue;

    const feeder = selectRecipe(alternatives, scc.items);

    let overrideDemand = 0;
    if (graph.targets.has(itemId)) {
      overrideDemand += targetRates.get(itemId) || 0;
    }
    const consumers = graph.itemConsumedBy.get(itemId);
    if (consumers) {
      consumers.forEach((rid) => {
        if (!scc.recipes.has(rid)) {
          const fc = recipeFacilityCounts.get(rid) || 0;
          const recipe = maps.recipeMap.get(rid)!;
          const input = recipe.inputs.find((i) => i.itemId === itemId);
          if (input) {
            overrideDemand += calcRate(input.amount, recipe.craftingTime) * fc;
          }
        }
      });
    }

    feedersAdded.push({ feederRecipe: feeder, overrideRecipeId, overrideDemand });
  }

  if (feedersAdded.length === 0) return false;

  const originalSCCRecipes = new Set(scc.recipes);
  const originalExternalInputs = new Set(scc.externalInputs);
  const addedRecipeIds: RecipeId[] = [];
  const addedItemIds: ItemId[] = [];
  const addedConsumptionEdges: { itemId: ItemId; recipeId: RecipeId }[] = [];

  const rollback = () => {
    for (const id of scc.recipes) {
      if (!originalSCCRecipes.has(id)) scc.recipes.delete(id);
    }
    for (const id of scc.externalInputs) {
      if (!originalExternalInputs.has(id)) scc.externalInputs.delete(id);
    }
    for (const id of addedRecipeIds) {
      graph.recipeNodes.delete(id);
      graph.recipeInputs.delete(id);
      graph.recipeOutputs.delete(id);
      recipeFacilityCounts.delete(id);
    }
    for (const id of addedItemIds) {
      graph.itemNodes.delete(id);
      graph.rawMaterials.delete(id);
    }
    for (const { itemId, recipeId } of addedConsumptionEdges) {
      graph.itemConsumedBy.get(itemId)?.delete(recipeId);
    }
  };

  for (const { feederRecipe } of feedersAdded) {
    const facility = maps.facilityMap.get(feederRecipe.facilityId);
    if (!facility) continue;

    if (!graph.recipeNodes.has(feederRecipe.id)) {
      graph.recipeNodes.set(feederRecipe.id, {
        recipeId: feederRecipe.id,
        recipe: feederRecipe,
        facility,
      });
      graph.recipeInputs.set(feederRecipe.id, new Set());
      graph.recipeOutputs.set(feederRecipe.id, new Set());
      addedRecipeIds.push(feederRecipe.id);
    }

    for (const out of feederRecipe.outputs) {
      graph.recipeOutputs.get(feederRecipe.id)!.add(out.itemId);
      if (!graph.itemNodes.has(out.itemId)) {
        const outItem = maps.itemMap.get(out.itemId);
        if (outItem) {
          graph.itemNodes.set(out.itemId, {
            itemId: out.itemId,
            item: outItem,
            isRawMaterial: false,
          });
          addedItemIds.push(out.itemId);
        }
      }
    }

    for (const inp of feederRecipe.inputs) {
      graph.recipeInputs.get(feederRecipe.id)!.add(inp.itemId);
      if (!graph.itemConsumedBy.has(inp.itemId)) {
        graph.itemConsumedBy.set(inp.itemId, new Set());
      }
      graph.itemConsumedBy.get(inp.itemId)!.add(feederRecipe.id);
      addedConsumptionEdges.push({
        itemId: inp.itemId,
        recipeId: feederRecipe.id,
      });

      if (!graph.itemNodes.has(inp.itemId)) {
        const inpItem = maps.itemMap.get(inp.itemId);
        if (inpItem) {
          const isRaw =
            forcedRawMaterials.has(inp.itemId) ||
            (manualRawMaterials?.has(inp.itemId) ?? false);
          graph.itemNodes.set(inp.itemId, {
            itemId: inp.itemId,
            item: inpItem,
            isRawMaterial: isRaw,
          });
          if (isRaw) graph.rawMaterials.add(inp.itemId);
          addedItemIds.push(inp.itemId);
        }
      }

      if (!scc.items.has(inp.itemId)) {
        scc.externalInputs.add(inp.itemId);
      }
    }

    scc.recipes.add(feederRecipe.id);
    console.log(
      `  [SCC_EXTEND] Added feeder recipe ${feederRecipe.id} to SCC ${scc.id}`,
    );
  }

  // Recompute external demands for the extended SCC.
  const externalDemands = new Map<ItemId, number>();
  for (const itemId of scc.items) {
    let demand = 0;
    const consumers = graph.itemConsumedBy.get(itemId);
    if (consumers) {
      consumers.forEach((recipeId) => {
        if (!scc.recipes.has(recipeId)) {
          const fc = recipeFacilityCounts.get(recipeId) || 0;
          const recipe = maps.recipeMap.get(recipeId)!;
          const input = recipe.inputs.find((i) => i.itemId === itemId);
          if (input) {
            demand += calcRate(input.amount, recipe.craftingTime) * fc;
          }
        }
      });
    }
    if (graph.targets.has(itemId)) {
      demand += targetRates.get(itemId) || 0;
    }
    if (demand > 0) externalDemands.set(itemId, demand);
  }

  // External outputs from extended recipes.
  const extRecipesList = Array.from(scc.recipes).map(
    (rid) => maps.recipeMap.get(rid)!,
  );
  const externalOutputDemands = new Map<ItemId, number>();
  for (const recipe of extRecipesList) {
    for (const out of recipe.outputs) {
      if (scc.items.has(out.itemId)) continue;
      const d = itemDemands.get(out.itemId) || 0;
      if (d > 0) externalOutputDemands.set(out.itemId, d);
    }
  }

  // Pin the user-overridden recipe(s) so LP honors the user's choice
  // rather than substituting a cheaper alternative produced by the feeder.
  // Mirrors the heuristic's pinnedRecipes logic in `tryExtendSCCWithFeeders`.
  const pinnedOverrides = new Map<RecipeId, number>();
  for (const { overrideRecipeId, overrideDemand } of feedersAdded) {
    const overrideRecipe = maps.recipeMap.get(overrideRecipeId);
    if (!overrideRecipe) continue;
    const outputItem = overrideRecipe.outputs.find((o) =>
      scc.items.has(o.itemId),
    );
    if (!outputItem) continue;
    const rate = calcRate(outputItem.amount, overrideRecipe.craftingTime);
    if (rate > 0) {
      pinnedOverrides.set(overrideRecipeId, overrideDemand / rate);
    }
  }

  const lpInput = {
    ...buildLPInputForSCC(
      scc,
      externalDemands,
      externalOutputDemands,
      graph,
      maps,
    ),
    pinnedRecipes: pinnedOverrides,
  };
  const result = await solveLP(lpInput);

  if (!result.feasible) {
    console.warn(
      `  [SCC_EXTEND] Extended LP still infeasible for SCC ${scc.id}`,
    );
    rollback();
    return false;
  }

  console.log(
    `  [SCC_EXTEND] Extended LP solution found (raw=${result.totalRawCost.toFixed(2)}, power=${result.totalPower.toFixed(2)}):`,
  );
  for (const recipe of extRecipesList) {
    const fc = result.facilityCounts.get(recipe.id) ?? 0;
    recipeFacilityCounts.set(recipe.id, fc);
    console.log(`    Recipe ${recipe.id}: ${fc.toFixed(4)} facilities`);
  }

  // Validate that target items in the SCC are actually satisfied by the
  // extended solution. (LP can technically return a solution that satisfies
  // every constraint we wrote, but we want to double-check primary targets.)
  for (const itemId of scc.items) {
    if (!graph.targets.has(itemId)) continue;
    let netProduction = 0;
    for (const recipe of extRecipesList) {
      const fc = recipeFacilityCounts.get(recipe.id) || 0;
      const out = recipe.outputs.find((o) => o.itemId === itemId)?.amount || 0;
      const inp = recipe.inputs.find((i) => i.itemId === itemId)?.amount || 0;
      netProduction +=
        (calcRate(out, recipe.craftingTime) -
          calcRate(inp, recipe.craftingTime)) *
        fc;
    }
    const externalDemand = externalDemands.get(itemId) || 0;
    if (externalDemand - netProduction > TARGET_VALIDATION_TOLERANCE) {
      console.warn(
        `  [SCC_EXTEND] Target ${itemId} unresolved: produced ${netProduction.toFixed(4)} vs demand ${externalDemand.toFixed(4)}`,
      );
      rollback();
      return false;
    }
  }

  // Phase 4.5: raw-material consumption inside the extended SCC.
  // Same rationale as solveSCCFlow's call site — raw items in scc.items
  // are skipped by Phase 5's externalInputs iteration.
  propagateRawMaterialDeficit(
    scc,
    extRecipesList,
    recipeFacilityCounts,
    externalDemands,
    itemDemands,
    graph,
    "SCC_EXTEND",
  );

  // Phase 5: external input propagation.
  scc.externalInputs.forEach((inputItemId) => {
    let totalConsumption = 0;
    scc.recipes.forEach((recipeId) => {
      const recipe = maps.recipeMap.get(recipeId)!;
      const fc = recipeFacilityCounts.get(recipeId) || 0;
      const input = recipe.inputs.find((i) => i.itemId === inputItemId);
      if (input) {
        totalConsumption += calcRate(input.amount, recipe.craftingTime) * fc;
      }
    });
    if (totalConsumption > 0) {
      itemDemands.set(
        inputItemId,
        (itemDemands.get(inputItemId) || 0) + totalConsumption,
      );
      console.log(
        `  [SCC_EXTEND] External input ${inputItemId} demand: ${totalConsumption.toFixed(4)}/min`,
      );
    }
  });

  resolvedSCCIds?.add(scc.id);
  return true;
}
