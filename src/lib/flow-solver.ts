import type { ItemId, RecipeId } from "@/types";
import { solveOverdetermined } from "./linear-solver";
import { forcedRawMaterials, forcedDisposalItems } from "@/data";
import { calcRate } from "@/lib/utils";
import { selectRecipe } from "./graph-builder";
import type {
  SystemRow,
  ProductionMaps,
  BipartiteGraph,
  SCCInfo,
  CondensedNode,
  FlowData,
  InvalidSCCInfo,
} from "./calculator-types";

const isAllZeroRow = (row: number[]): boolean =>
  row.every((v) => Math.abs(v) < 1e-9);

// Drops equations the SCC solver must not enforce:
//   1. Unsatisfiable: forced-disposal item with zero LHS and non-zero RHS —
//      surplus is handled later by injectDisposalRecipes.
//   2. Slack: forced-disposal-surplus (rhs < 0) or forced-raw-supply items,
//      dropped greedily while keeping at least numVars rows so the system
//      stays determined. Disposal-surplus rows go first: their RHS encodes
//      a real surplus from pinned recipes (production > consumption), and
//      keeping them as equality forces free recipes to over-consume the
//      byproduct (e.g. POOL_LIQUID_XIRANITE_POLY over-running to absorb
//      Sewage from the Hetonite chain). Raw-material rows go next (their
//      deficit is always absorbed by external supply). Disposal rows with
//      rhs ≈ 0 stay if possible — they may encode a useful balance
//      constraint (e.g. LOWPOLY tying Pool/Purifier ratio).
const filterImpossibleDisposalRows = (
  rows: SystemRow[],
  numVars: number,
  rawMaterials: Set<ItemId>,
): SystemRow[] => {
  const base = rows.filter(
    ({ row, rhs, itemId }) =>
      !forcedDisposalItems.has(itemId) ||
      !isAllZeroRow(row) ||
      Math.abs(rhs) < 1e-9,
  );
  const isDisposalSurplus = (r: SystemRow) =>
    forcedDisposalItems.has(r.itemId) && r.rhs < -1e-9;
  const isRawSlack = (r: SystemRow) => rawMaterials.has(r.itemId);
  const isDisposalBalanced = (r: SystemRow) =>
    forcedDisposalItems.has(r.itemId) && Math.abs(r.rhs) < 1e-9;
  const remaining = base.slice();
  for (const isSlack of [isDisposalSurplus, isRawSlack, isDisposalBalanced]) {
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining.length <= numVars) break;
      if (isSlack(remaining[i])) remaining.splice(i, 1);
    }
  }
  return remaining;
};

export function calculateFlows(
  graph: BipartiteGraph,
  condensedOrder: CondensedNode[],
  targetRates: Map<ItemId, number>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  manualRawMaterials?: Set<ItemId>,
): { flowData: FlowData; invalidSCCs: InvalidSCCInfo[] } {
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

  reversedOrder.forEach((node, idx) => {
    if (node.type === "scc") {
      console.log(`[FLOW] [${idx}] Processing SCC: ${node.scc.id}`);
      const solved = solveSCCFlow(
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
  });

  return {
    flowData: { itemDemands, recipeFacilityCounts, resolvedSCCIds },
    invalidSCCs,
  };
}

function solveSCCFlow(
  scc: SCCInfo,
  graph: BipartiteGraph,
  itemDemands: Map<ItemId, number>,
  recipeFacilityCounts: Map<RecipeId, number>,
  targetRates: Map<ItemId, number>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  resolvedSCCIds?: Set<string>,
  manualRawMaterials?: Set<ItemId>,
): boolean {
  console.log(`[SCC_SOLVE] Solving flow for SCC: ${scc.id}`);

  const recipesList = Array.from(scc.recipes).map(
    (rid) => maps.recipeMap.get(rid)!,
  );
  const itemsList = Array.from(scc.items);
  const n = itemsList.length;
  const m = recipesList.length;

  if (m === 0 || n === 0) {
    console.log(`  [SCC_SOLVE] Empty system, skipping`);
    return false;
  }

  // --- Phase 1: Compute external demands for SCC-internal items ---
  const externalDemands = new Map<ItemId, number>();

  scc.items.forEach((itemId) => {
    let demand = 0;

    const consumers = graph.itemConsumedBy.get(itemId);
    if (consumers) {
      consumers.forEach((recipeId) => {
        if (!scc.recipes.has(recipeId)) {
          const facilityCount = recipeFacilityCounts.get(recipeId) || 0;
          const recipe = maps.recipeMap.get(recipeId)!;
          const input = recipe.inputs.find((i) => i.itemId === itemId);
          if (input) {
            const consumption =
              calcRate(input.amount, recipe.craftingTime) * facilityCount;
            demand += consumption;
            console.log(
              `    Item ${itemId} consumed by external recipe ${recipeId}: ${consumption.toFixed(4)}`,
            );
          }
        }
      });
    }

    if (graph.targets.has(itemId)) {
      // Use raw target rate, NOT itemDemands — itemDemands has already
      // accumulated input demand from external consumer recipes processed
      // earlier in reverse-topo order (those are added separately above
      // via `consumers`), so reading from itemDemands double-counts.
      const targetDemand = targetRates.get(itemId) || 0;
      demand += targetDemand;
      console.log(
        `    Item ${itemId} is target with demand: ${targetDemand.toFixed(4)}`,
      );
    }

    if (demand > 0) {
      externalDemands.set(itemId, demand);
    }
  });

  // --- Phase 2: Compute external output demands ---
  const externalOutputByItem = new Map<
    ItemId,
    { demand: number; producers: { recipeIdx: number; rate: number }[] }
  >();

  for (let j = 0; j < m; j++) {
    const recipe = recipesList[j];

    for (const out of recipe.outputs) {
      if (scc.items.has(out.itemId)) continue;

      const demand = itemDemands.get(out.itemId) || 0;
      if (demand <= 0) continue;

      const rate = calcRate(out.amount, recipe.craftingTime);
      if (rate <= 0) continue;

      let entry = externalOutputByItem.get(out.itemId);
      if (!entry) {
        entry = { demand, producers: [] };
        externalOutputByItem.set(out.itemId, entry);
      }
      entry.producers.push({ recipeIdx: j, rate });
      console.log(
        `    Recipe ${recipe.id} produces external item ${out.itemId} with demand: ${demand.toFixed(4)}/min (rate: ${rate.toFixed(4)}/facility)`,
      );
    }
  }

  const hasExternalOutputDemand = externalOutputByItem.size > 0;

  if (externalDemands.size === 0 && !hasExternalOutputDemand) {
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
    `  External demands (internal items): ${externalDemands.size}, External output items: ${externalOutputByItem.size}`,
  );

  // --- Phase 3: Solve with pinned facility counts ---
  const pinnedRecipes = new Map<number, number>();
  const sharedOutputConstraints: { itemId: ItemId; demand: number }[] = [];

  externalOutputByItem.forEach(({ demand, producers }, itemId) => {
    if (producers.length === 1) {
      const { recipeIdx, rate } = producers[0];
      const pinnedCount = demand / rate;
      const prev = pinnedRecipes.get(recipeIdx) ?? 0;
      pinnedRecipes.set(recipeIdx, Math.max(prev, pinnedCount));
      console.log(
        `  Pinning recipe ${recipesList[recipeIdx].id} (index ${recipeIdx}) to ${pinnedCount.toFixed(4)} facilities (single producer of ${itemId})`,
      );
    } else {
      sharedOutputConstraints.push({ itemId, demand });
      console.log(
        `  Shared constraint: ${producers.length} producers of external ${itemId} (total demand ${demand.toFixed(4)}/min)`,
      );
    }
  });

  if (pinnedRecipes.size > 0 || sharedOutputConstraints.length > 0) {
    const freeIndices = Array.from({ length: m }, (_, i) => i).filter(
      (i) => !pinnedRecipes.has(i),
    );
    const freeM = freeIndices.length;

    const rawRows: SystemRow[] = [];

    for (let i = 0; i < n; i++) {
      const itemId = itemsList[i];
      const row = new Array(freeM).fill(0);
      const externalDemand = externalDemands.get(itemId) || 0;
      let rhs = externalDemand;

      for (let j = 0; j < m; j++) {
        const recipe = recipesList[j];
        const output =
          recipe.outputs.find((o) => o.itemId === itemId)?.amount || 0;
        const input =
          recipe.inputs.find((inp) => inp.itemId === itemId)?.amount || 0;
        const coeff =
          calcRate(output, recipe.craftingTime) -
          calcRate(input, recipe.craftingTime);

        if (pinnedRecipes.has(j)) {
          rhs -= coeff * pinnedRecipes.get(j)!;
        } else {
          const freeIdx = freeIndices.indexOf(j);
          row[freeIdx] = coeff;
        }
      }

      rawRows.push({ row, rhs, itemId });
    }

    for (const { itemId, demand } of sharedOutputConstraints) {
      const row = new Array(freeM).fill(0);
      const producers = externalOutputByItem.get(itemId)!.producers;
      for (const { recipeIdx, rate } of producers) {
        const freeIdx = freeIndices.indexOf(recipeIdx);
        if (freeIdx >= 0) row[freeIdx] += rate;
      }
      rawRows.push({ row, rhs: demand, itemId });
    }

    const filteredRows = filterImpossibleDisposalRows(
      rawRows,
      freeM,
      graph.rawMaterials,
    );
    const matrix = filteredRows.map((e) => e.row);
    const constants = filteredRows.map((e) => e.rhs);
    const effectiveN = filteredRows.length;

    console.log(
      `  Building reduced system: ${effectiveN} items × ${freeM} free recipes (${pinnedRecipes.size} pinned, ${sharedOutputConstraints.length} shared-output constraints, ${n + sharedOutputConstraints.length - effectiveN} disposal rows filtered)`,
    );
    filteredRows.forEach(({ row, rhs, itemId }, i) => {
      console.log(
        `    Equation ${i} (${itemId}):`,
        row.map((v, fi) => `${v.toFixed(2)}*r${freeIndices[fi]}`).join(" + "),
        `= ${rhs.toFixed(4)}`,
      );
    });

    const freeSolution = solveOverdetermined(matrix, constants, freeM);

    if (!freeSolution) {
      console.warn(
        `  [SCC_SOLVE] Cannot solve reduced SCC ${scc.id} - system has no solution`,
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

    console.log(`  Solution found:`);
    for (let j = 0; j < m; j++) {
      let facilityCount: number;
      if (pinnedRecipes.has(j)) {
        facilityCount = pinnedRecipes.get(j)!;
      } else {
        const freeIdx = freeIndices.indexOf(j);
        facilityCount = Math.max(0, freeSolution[freeIdx]);
      }
      recipeFacilityCounts.set(recipesList[j].id, facilityCount);
      console.log(
        `    Recipe ${recipesList[j].id}: ${facilityCount.toFixed(4)} facilities${pinnedRecipes.has(j) ? " (pinned)" : ""}`,
      );
    }
  } else {
    const rawRows: SystemRow[] = [];

    for (let i = 0; i < n; i++) {
      const itemId = itemsList[i];
      const row = new Array(m).fill(0);
      const rhs = externalDemands.get(itemId) || 0;

      for (let j = 0; j < m; j++) {
        const recipe = recipesList[j];
        const output =
          recipe.outputs.find((o) => o.itemId === itemId)?.amount || 0;
        const input =
          recipe.inputs.find((inp) => inp.itemId === itemId)?.amount || 0;
        row[j] =
          calcRate(output, recipe.craftingTime) -
          calcRate(input, recipe.craftingTime);
      }

      rawRows.push({ row, rhs, itemId });
    }

    const filteredRows = filterImpossibleDisposalRows(
      rawRows,
      m,
      graph.rawMaterials,
    );
    const matrix = filteredRows.map((e) => e.row);
    const constants = filteredRows.map((e) => e.rhs);
    const effectiveN = filteredRows.length;

    console.log(
      `  Building linear system: ${effectiveN} items × ${m} recipes (${n - effectiveN} disposal rows filtered)`,
    );
    filteredRows.forEach(({ row, rhs, itemId }, i) => {
      console.log(
        `    Equation ${i} (${itemId}):`,
        row.map((v, j) => `${v.toFixed(2)}*r${j}`).join(" + "),
        `= ${rhs.toFixed(4)}`,
      );
    });

    const solution =
      effectiveN === 0
        ? new Array(m).fill(0)
        : solveOverdetermined(matrix, constants, m);

    if (!solution) {
      console.warn(
        `  [SCC_SOLVE] Cannot solve SCC ${scc.id} - system has no solution`,
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

    console.log(`  Solution found:`);
    for (let j = 0; j < m; j++) {
      const facilityCount = Math.max(0, solution[j]);
      recipeFacilityCounts.set(recipesList[j].id, facilityCount);
      console.log(
        `    Recipe ${recipesList[j].id}: ${facilityCount.toFixed(4)} facilities`,
      );
    }
  }

  // --- Phase 4: Compute deficits for SCC-internal items and propagate ---
  for (let i = 0; i < n; i++) {
    const itemId = itemsList[i];
    let netProduction = 0;

    for (let j = 0; j < m; j++) {
      const recipe = recipesList[j];
      const facilityCount = recipeFacilityCounts.get(recipe.id) || 0;
      const output =
        recipe.outputs.find((o) => o.itemId === itemId)?.amount || 0;
      const input =
        recipe.inputs.find((inp) => inp.itemId === itemId)?.amount || 0;

      netProduction +=
        (calcRate(output, recipe.craftingTime) -
          calcRate(input, recipe.craftingTime)) *
        facilityCount;
    }

    const externalDemand = externalDemands.get(itemId) || 0;
    const deficit = externalDemand - netProduction;

    if (deficit > 1e-9) {
      itemDemands.set(itemId, Math.max(itemDemands.get(itemId) || 0, deficit));
      console.log(
        `  Item ${itemId} has deficit of ${deficit.toFixed(4)}/min — propagated to external producers`,
      );
    }
  }

  // --- Phase 5: Propagate demands to external inputs ---
  scc.externalInputs.forEach((inputItemId) => {
    let totalConsumption = 0;

    scc.recipes.forEach((recipeId) => {
      const recipe = maps.recipeMap.get(recipeId)!;
      const facilityCount = recipeFacilityCounts.get(recipeId) || 0;
      const input = recipe.inputs.find((i) => i.itemId === inputItemId);

      if (input) {
        const consumption =
          calcRate(input.amount, recipe.craftingTime) * facilityCount;
        totalConsumption += consumption;
      }
    });

    if (totalConsumption > 0) {
      itemDemands.set(
        inputItemId,
        (itemDemands.get(inputItemId) || 0) + totalConsumption,
      );
      console.log(
        `  External input ${inputItemId} demand increased by: ${totalConsumption.toFixed(4)}/min`,
      );
    }
  });

  return true;
}

function tryExtendSCCWithFeeders(
  scc: SCCInfo,
  graph: BipartiteGraph,
  itemDemands: Map<ItemId, number>,
  recipeFacilityCounts: Map<RecipeId, number>,
  targetRates: Map<ItemId, number>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  resolvedSCCIds?: Set<string>,
  manualRawMaterials?: Set<ItemId>,
): boolean {
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

    feedersAdded.push({
      feederRecipe: feeder,
      overrideRecipeId,
      overrideDemand,
    });
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

  const extItemsList = Array.from(scc.items);
  const extRecipesList = Array.from(scc.recipes).map(
    (rid) => maps.recipeMap.get(rid)!,
  );
  const n = extItemsList.length;
  const m = extRecipesList.length;

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

  const pinnedRecipes = new Map<number, number>();
  for (const { overrideRecipeId, overrideDemand } of feedersAdded) {
    const overrideIdx = extRecipesList.findIndex(
      (r) => r.id === overrideRecipeId,
    );
    if (overrideIdx === -1) continue;

    const overrideRecipe = extRecipesList[overrideIdx];
    const outputItem = overrideRecipe.outputs.find((o) =>
      scc.items.has(o.itemId),
    );
    if (!outputItem) continue;

    const rate = calcRate(outputItem.amount, overrideRecipe.craftingTime);
    if (rate > 0) {
      pinnedRecipes.set(overrideIdx, overrideDemand / rate);
      console.log(
        `  [SCC_EXTEND] Pinning override recipe ${overrideRecipe.id} (index ${overrideIdx}) to ${(overrideDemand / rate).toFixed(4)} facilities`,
      );
    }
  }

  if (pinnedRecipes.size === 0) {
    rollback();
    return false;
  }

  const freeIndices = Array.from({ length: m }, (_, i) => i).filter(
    (i) => !pinnedRecipes.has(i),
  );
  const freeM = freeIndices.length;

  const extRawRows: SystemRow[] = [];

  for (let i = 0; i < n; i++) {
    const itemId = extItemsList[i];
    const row = new Array(freeM).fill(0);
    const externalDemand = externalDemands.get(itemId) || 0;
    let rhs = externalDemand;

    for (let j = 0; j < m; j++) {
      const recipe = extRecipesList[j];
      const output =
        recipe.outputs.find((o) => o.itemId === itemId)?.amount || 0;
      const input =
        recipe.inputs.find((inp) => inp.itemId === itemId)?.amount || 0;
      const coeff =
        calcRate(output, recipe.craftingTime) -
        calcRate(input, recipe.craftingTime);

      if (pinnedRecipes.has(j)) {
        rhs -= coeff * pinnedRecipes.get(j)!;
      } else {
        const freeIdx = freeIndices.indexOf(j);
        row[freeIdx] = coeff;
      }
    }

    extRawRows.push({ row, rhs, itemId });
  }

  const extFilteredRows = filterImpossibleDisposalRows(
    extRawRows,
    freeM,
    graph.rawMaterials,
  );
  const matrix = extFilteredRows.map((e) => e.row);
  const constants = extFilteredRows.map((e) => e.rhs);
  const extEffectiveN = extFilteredRows.length;

  console.log(
    `  [SCC_EXTEND] Solving extended system: ${extEffectiveN} items × ${freeM} free recipes (${pinnedRecipes.size} pinned, ${m} total)`,
  );

  const freeSolution = solveOverdetermined(matrix, constants, freeM);

  if (!freeSolution) {
    console.warn(
      `  [SCC_EXTEND] Extended system still has no solution for SCC ${scc.id}`,
    );
    rollback();
    return false;
  }

  console.log(`  [SCC_EXTEND] Solution found:`);
  for (let j = 0; j < m; j++) {
    let facilityCount: number;
    if (pinnedRecipes.has(j)) {
      facilityCount = pinnedRecipes.get(j)!;
    } else {
      const freeIdx = freeIndices.indexOf(j);
      facilityCount = Math.max(0, freeSolution[freeIdx]);
    }
    recipeFacilityCounts.set(extRecipesList[j].id, facilityCount);
    console.log(
      `    Recipe ${extRecipesList[j].id}: ${facilityCount.toFixed(4)} facilities${pinnedRecipes.has(j) ? " (pinned)" : ""}`,
    );
  }

  // --- Phase 4: Compute deficits ---
  for (let i = 0; i < n; i++) {
    const itemId = extItemsList[i];
    let netProduction = 0;

    for (let j = 0; j < m; j++) {
      const recipe = extRecipesList[j];
      const facilityCount = recipeFacilityCounts.get(recipe.id) || 0;
      const output =
        recipe.outputs.find((o) => o.itemId === itemId)?.amount || 0;
      const input =
        recipe.inputs.find((inp) => inp.itemId === itemId)?.amount || 0;
      netProduction +=
        (calcRate(output, recipe.craftingTime) -
          calcRate(input, recipe.craftingTime)) *
        facilityCount;
    }

    const externalDemand = externalDemands.get(itemId) || 0;
    const deficit = externalDemand - netProduction;

    if (deficit > 1e-9) {
      itemDemands.set(itemId, Math.max(itemDemands.get(itemId) || 0, deficit));
      console.log(
        `  [SCC_EXTEND] Item ${itemId} has deficit of ${deficit.toFixed(4)}/min — propagated`,
      );
    }
  }

  // Check: did the extension actually resolve the target demand?
  for (let i = 0; i < n; i++) {
    const itemId = extItemsList[i];
    if (!graph.targets.has(itemId)) continue;

    let targetNetProduction = 0;
    for (let j = 0; j < m; j++) {
      const recipe = extRecipesList[j];
      const facilityCount = recipeFacilityCounts.get(recipe.id) || 0;
      const output =
        recipe.outputs.find((o) => o.itemId === itemId)?.amount || 0;
      const input =
        recipe.inputs.find((inp) => inp.itemId === itemId)?.amount || 0;
      targetNetProduction +=
        (calcRate(output, recipe.craftingTime) -
          calcRate(input, recipe.craftingTime)) *
        facilityCount;
    }

    const externalDemand = externalDemands.get(itemId) || 0;
    if (externalDemand - targetNetProduction > 1e-9) {
      console.warn(
        `  [SCC_EXTEND] Target ${itemId} has unresolved deficit of ${(externalDemand - targetNetProduction).toFixed(4)}/min — extension failed`,
      );
      rollback();
      return false;
    }
  }

  // --- Phase 5: Propagate demands to external inputs ---
  scc.externalInputs.forEach((inputItemId) => {
    let totalConsumption = 0;
    scc.recipes.forEach((recipeId) => {
      const recipe = maps.recipeMap.get(recipeId)!;
      const facilityCount = recipeFacilityCounts.get(recipeId) || 0;
      const input = recipe.inputs.find((i) => i.itemId === inputItemId);
      if (input) {
        totalConsumption +=
          calcRate(input.amount, recipe.craftingTime) * facilityCount;
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
