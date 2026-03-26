import type {
  Item,
  Recipe,
  Facility,
  ItemId,
  RecipeId,
  FacilityId,
  ProductionNode,
  DetectedCycle,
  InvalidCycleInfo,
  ProductionDependencyGraph,
  ProductionGraphNode,
} from "@/types";
import { solveLinearSystem } from "./linear-solver";
import { forcedRawMaterials, forcedDisposalItems } from "@/data";
import { calcRate } from "@/lib/utils";

const selectRecipe = (recipes: Recipe[], visitedPath: Set<ItemId>): Recipe => {
  // Priority 1: Recipes with single output (no byproducts)
  const singleOutput = recipes.filter((r) => r.outputs.length === 1);

  if (singleOutput.length > 0) {
    // Priority 2: Among single-output recipes, prefer non-circular ones
    if (visitedPath.size > 0) {
      const nonCircular = singleOutput.filter(
        (r) => !r.inputs.some((input) => visitedPath.has(input.itemId)),
      );

      if (nonCircular.length > 0) {
        return nonCircular[0];
      }
    }

    // Priority 3: Return first single-output recipe
    return singleOutput[0];
  }

  // Priority 4: If no single-output recipes, prefer non-circular
  if (visitedPath.size > 0) {
    const nonCircular = recipes.filter(
      (r) => !r.inputs.some((input) => visitedPath.has(input.itemId)),
    );

    if (nonCircular.length > 0) {
      return nonCircular[0];
    }
  }

  // Priority 5: Default to first available recipe
  return recipes[0];
};

type ProductionMaps = {
  itemMap: Map<ItemId, Item>;
  recipeMap: Map<RecipeId, Recipe>;
  facilityMap: Map<FacilityId, Facility>;
};

type ItemNode = {
  itemId: ItemId;
  item: Item;
  isRawMaterial: boolean;
};

type RecipeNodeData = {
  recipeId: RecipeId;
  recipe: Recipe;
  facility: Facility;
};

type BipartiteGraph = {
  itemNodes: Map<ItemId, ItemNode>;
  recipeNodes: Map<RecipeId, RecipeNodeData>;

  itemConsumedBy: Map<ItemId, Set<RecipeId>>;

  recipeInputs: Map<RecipeId, Set<ItemId>>;
  recipeOutputs: Map<RecipeId, Set<ItemId>>;

  targets: Set<ItemId>;
  rawMaterials: Set<ItemId>;
};
type SCCInfo = {
  id: string;
  items: Set<ItemId>;
  recipes: Set<RecipeId>;
  externalInputs: Set<ItemId>;
};

type CondensedNode =
  | { type: "item"; itemId: ItemId }
  | { type: "recipe"; recipeId: RecipeId }
  | { type: "scc"; scc: SCCInfo };

type FlowData = {
  itemDemands: Map<ItemId, number>;
  recipeFacilityCounts: Map<RecipeId, number>;
  /** SCC IDs that were resolved by feeder extension (no longer true cycles) */
  resolvedSCCIds: Set<string>;
};

type RecipeChoice = {
  itemId: ItemId;
  availableRecipes: RecipeId[];
  currentIndex: number;
};

type BuildGraphResult = {
  graph: BipartiteGraph;
  recipeChoices: Map<ItemId, RecipeChoice>;
};

type InvalidSCCInfo = {
  sccId: string;
  involvedItems: Set<ItemId>;
  reason: "no_solution" | "no_external_demand";
};

const getOrThrow = <K, V>(map: Map<K, V>, key: K, type: string): V => {
  const value = map.get(key);
  if (!value) throw new Error(`${type} not found: ${key}`);
  return value;
};

function buildBipartiteGraph(
  targets: Array<{ itemId: ItemId; rate: number }>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  manualRawMaterials?: Set<ItemId>,
  recipeConstraints?: Map<ItemId, Set<RecipeId>>, // New parameter: excluded recipes per item
): BuildGraphResult {
  const graph: BipartiteGraph = {
    itemNodes: new Map(),
    recipeNodes: new Map(),
    itemConsumedBy: new Map(),
    recipeInputs: new Map(),
    recipeOutputs: new Map(),
    targets: new Set(targets.map((t) => t.itemId)),
    rawMaterials: new Set(),
  };

  const recipeChoices = new Map<ItemId, RecipeChoice>();
  const visitedItems = new Set<ItemId>();

  function traverse(itemId: ItemId, visitedPath: Set<ItemId>) {
    if (visitedItems.has(itemId)) return;
    visitedItems.add(itemId);

    const item = getOrThrow(maps.itemMap, itemId, "Item");

    const isRaw =
      forcedRawMaterials.has(itemId) ||
      (manualRawMaterials?.has(itemId) ?? false);

    graph.itemNodes.set(itemId, {
      itemId,
      item,
      isRawMaterial: isRaw,
    });

    if (isRaw) {
      graph.rawMaterials.add(itemId);
      return;
    }

    let availableRecipes = Array.from(maps.recipeMap.values()).filter((r) =>
      r.outputs.some((o) => o.itemId === itemId),
    );

    // Filter out excluded recipes
    const excludedRecipes = recipeConstraints?.get(itemId);
    if (excludedRecipes && excludedRecipes.size > 0) {
      availableRecipes = availableRecipes.filter(
        (r) => !excludedRecipes.has(r.id),
      );
    }

    if (availableRecipes.length === 0) {
      graph.itemNodes.get(itemId)!.isRawMaterial = true;
      graph.rawMaterials.add(itemId);
      return;
    }

    // Record recipe choices for this item
    const recipeIds = availableRecipes.map((r) => r.id);
    let currentIndex = 0;

    // Determine which recipe to use
    let selectedRecipe: Recipe;
    if (recipeOverrides?.has(itemId)) {
      selectedRecipe = getOrThrow(
        maps.recipeMap,
        recipeOverrides.get(itemId)!,
        "Override recipe",
      );
      currentIndex = recipeIds.indexOf(selectedRecipe.id);
      if (currentIndex === -1) currentIndex = 0;
    } else {
      selectedRecipe = selectRecipe(availableRecipes, visitedPath);
      currentIndex = recipeIds.indexOf(selectedRecipe.id);
    }

    // Store choice information only if there are multiple options
    if (availableRecipes.length > 1) {
      recipeChoices.set(itemId, {
        itemId,
        availableRecipes: recipeIds,
        currentIndex,
      });
    }

    const facility = getOrThrow(
      maps.facilityMap,
      selectedRecipe.facilityId,
      "Facility",
    );

    if (!graph.recipeNodes.has(selectedRecipe.id)) {
      graph.recipeNodes.set(selectedRecipe.id, {
        recipeId: selectedRecipe.id,
        recipe: selectedRecipe,
        facility,
      });

      graph.recipeInputs.set(selectedRecipe.id, new Set());
      graph.recipeOutputs.set(selectedRecipe.id, new Set());
    }

    selectedRecipe.outputs.forEach((out) => {
      graph.recipeOutputs.get(selectedRecipe.id)!.add(out.itemId);

      // Ensure byproduct items exist in the graph as produced (non-raw) nodes.
      // Byproducts are NOT marked as visited so that if they are later consumed
      // by another recipe, the traverse can discover an external production recipe
      // for them. This is essential for cycles with net deficits (e.g., liquid_sewage
      // in the Xircon chain needs an external source via furnace).
      if (!graph.itemNodes.has(out.itemId)) {
        const outItem = maps.itemMap.get(out.itemId);
        if (outItem) {
          graph.itemNodes.set(out.itemId, {
            itemId: out.itemId,
            item: outItem,
            isRawMaterial: false,
          });
        }
      }
    });

    const newVisitedPath = new Set(visitedPath);
    newVisitedPath.add(itemId);

    selectedRecipe.inputs.forEach((input) => {
      graph.recipeInputs.get(selectedRecipe.id)!.add(input.itemId);

      if (!graph.itemConsumedBy.has(input.itemId)) {
        graph.itemConsumedBy.set(input.itemId, new Set());
      }
      graph.itemConsumedBy.get(input.itemId)!.add(selectedRecipe.id);

      traverse(input.itemId, newVisitedPath);
    });
  }

  targets.forEach(({ itemId }) => traverse(itemId, new Set()));

  return { graph, recipeChoices };
}

function detectSCCs(graph: BipartiteGraph): SCCInfo[] {
  const sccs: SCCInfo[] = [];
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let index = 0;

  function strongConnect(nodeId: string, nodeType: "item" | "recipe") {
    indices.set(nodeId, index);
    lowlinks.set(nodeId, index);
    index++;
    stack.push(nodeId);
    onStack.add(nodeId);

    const successors: Array<[string, "item" | "recipe"]> = [];

    if (nodeType === "item") {
      const consumerRecipes = graph.itemConsumedBy.get(nodeId as ItemId);
      if (consumerRecipes) {
        consumerRecipes.forEach((recipeId) => {
          successors.push([recipeId, "recipe"]);
        });
      }
    } else {
      const outputs = graph.recipeOutputs.get(nodeId as RecipeId);
      if (outputs) {
        outputs.forEach((itemId) => {
          successors.push([itemId, "item"]);
        });
      }
    }

    successors.forEach(([succId, succType]) => {
      if (!indices.has(succId)) {
        strongConnect(succId, succType);
        lowlinks.set(
          nodeId,
          Math.min(lowlinks.get(nodeId)!, lowlinks.get(succId)!),
        );
      } else if (onStack.has(succId)) {
        lowlinks.set(
          nodeId,
          Math.min(lowlinks.get(nodeId)!, indices.get(succId)!),
        );
      }
    });

    if (lowlinks.get(nodeId) === indices.get(nodeId)) {
      const sccItems = new Set<ItemId>();
      const sccRecipes = new Set<RecipeId>();

      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);

        if (graph.itemNodes.has(w as ItemId)) {
          sccItems.add(w as ItemId);
        } else {
          sccRecipes.add(w as RecipeId);
        }
      } while (w !== nodeId);

      if (sccItems.size + sccRecipes.size > 1) {
        const externalInputs = new Set<ItemId>();

        sccRecipes.forEach((recipeId) => {
          const inputs = graph.recipeInputs.get(recipeId) || new Set();
          inputs.forEach((inputItemId) => {
            if (!sccItems.has(inputItemId)) {
              externalInputs.add(inputItemId);
            }
          });
        });

        const sccInfo: SCCInfo = {
          id: `scc-${Array.from(sccItems).sort().join("-")}`,
          items: sccItems,
          recipes: sccRecipes,
          externalInputs,
        };

        // LOG: SCC detected
        console.log(`[SCC] Detected cycle: ${sccInfo.id}`);
        console.log(`  Items (${sccItems.size}):`, Array.from(sccItems));
        console.log(`  Recipes (${sccRecipes.size}):`, Array.from(sccRecipes));
        console.log(
          `  External inputs (${externalInputs.size}):`,
          Array.from(externalInputs),
        );

        sccs.push(sccInfo);
      }
    }
  }

  graph.itemNodes.forEach((_, itemId) => {
    if (!indices.has(itemId)) {
      strongConnect(itemId, "item");
    }
  });

  console.log(`[SCC] Total SCCs detected: ${sccs.length}`);
  return sccs;
}

function buildCondensedDAGAndSort(
  graph: BipartiteGraph,
  sccs: SCCInfo[],
): CondensedNode[] {
  const nodeToSCC = new Map<string, string>();

  sccs.forEach((scc) => {
    scc.items.forEach((itemId) => nodeToSCC.set(itemId, scc.id));
    scc.recipes.forEach((recipeId) => nodeToSCC.set(recipeId, scc.id));
  });

  const condensedNodes = new Map<string, CondensedNode>();
  const condensedEdges = new Map<string, Set<string>>();

  sccs.forEach((scc) => {
    condensedNodes.set(scc.id, { type: "scc", scc });
    condensedEdges.set(scc.id, new Set());
  });

  graph.itemNodes.forEach((_, itemId) => {
    if (!nodeToSCC.has(itemId)) {
      condensedNodes.set(itemId, { type: "item", itemId });
      condensedEdges.set(itemId, new Set());
    }
  });

  graph.recipeNodes.forEach((_, recipeId) => {
    if (!nodeToSCC.has(recipeId)) {
      condensedNodes.set(recipeId, { type: "recipe", recipeId });
      condensedEdges.set(recipeId, new Set());
    }
  });

  const addEdge = (fromId: string, toId: string) => {
    const fromCondensed = nodeToSCC.get(fromId) || fromId;
    const toCondensed = nodeToSCC.get(toId) || toId;

    if (fromCondensed !== toCondensed) {
      condensedEdges.get(fromCondensed)!.add(toCondensed);
    }
  };

  graph.itemConsumedBy.forEach((recipeIds, itemId) => {
    recipeIds.forEach((recipeId) => {
      addEdge(itemId, recipeId);
    });
  });

  graph.recipeOutputs.forEach((itemIds, recipeId) => {
    itemIds.forEach((itemId) => {
      addEdge(recipeId, itemId);
    });
  });

  const inDegree = new Map<string, number>();
  condensedNodes.forEach((_, nodeId) => {
    inDegree.set(nodeId, 0);
  });

  condensedEdges.forEach((targets) => {
    targets.forEach((target) => {
      inDegree.set(target, (inDegree.get(target) || 0) + 1);
    });
  });

  const queue: string[] = [];
  inDegree.forEach((degree, nodeId) => {
    if (degree === 0) queue.push(nodeId);
  });

  const topoOrder: CondensedNode[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    topoOrder.push(condensedNodes.get(nodeId)!);

    condensedEdges.get(nodeId)!.forEach((target) => {
      const newDegree = inDegree.get(target)! - 1;
      inDegree.set(target, newDegree);
      if (newDegree === 0) {
        queue.push(target);
      }
    });
  }

  return topoOrder;
}

function calculateFlows(
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
        maps,
        recipeOverrides,
        resolvedSCCIds,
        manualRawMaterials,
      );

      if (!solved) {
        // Record invalid SCC
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

  return { flowData: { itemDemands, recipeFacilityCounts, resolvedSCCIds }, invalidSCCs };
}

function solveSCCFlow(
  scc: SCCInfo,
  graph: BipartiteGraph,
  itemDemands: Map<ItemId, number>,
  recipeFacilityCounts: Map<RecipeId, number>,
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

    // Demand from recipes outside the SCC
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

    // Demand from target items
    if (graph.targets.has(itemId)) {
      const targetDemand = itemDemands.get(itemId) || 0;
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
  // Items OUTSIDE the SCC that are produced by SCC recipes and have demand.
  // These constrain ("pin") the facility counts for the producing recipes.
  const externalOutputDemands = new Map<
    number,
    { itemId: ItemId; demand: number; rate: number }[]
  >();
  let hasExternalOutputDemand = false;

  for (let j = 0; j < m; j++) {
    const recipe = recipesList[j];
    const demands: { itemId: ItemId; demand: number; rate: number }[] = [];

    for (const out of recipe.outputs) {
      if (scc.items.has(out.itemId)) continue; // Skip SCC-internal items

      const demand = itemDemands.get(out.itemId) || 0;
      if (demand > 0) {
        const rate = calcRate(out.amount, recipe.craftingTime);
        demands.push({ itemId: out.itemId, demand, rate });
        console.log(
          `    Recipe ${recipe.id} produces external item ${out.itemId} with demand: ${demand.toFixed(4)}/min (rate: ${rate.toFixed(4)}/facility)`,
        );
      }
    }

    if (demands.length > 0) {
      externalOutputDemands.set(j, demands);
      hasExternalOutputDemand = true;
    }
  }

  // Early exit if no demand at all (neither internal nor external output)
  if (externalDemands.size === 0 && !hasExternalOutputDemand) {
    console.log(`  [SCC_SOLVE] No external demand, this is an invalid cycle`);
    // Try feeder extension before giving up
    return tryExtendSCCWithFeeders(
      scc, graph, itemDemands, recipeFacilityCounts, maps, recipeOverrides, resolvedSCCIds, manualRawMaterials,
    );
  }

  console.log(
    `  External demands (internal items): ${externalDemands.size}, External output demands: ${externalOutputDemands.size}`,
  );

  // --- Phase 3: Solve with pinned facility counts ---
  // Pin facility counts for recipes that produce external items with demand.
  const pinnedRecipes = new Map<number, number>(); // recipe index → facility count

  externalOutputDemands.forEach((demands, j) => {
    let pinnedCount = 0;
    for (const { demand, rate } of demands) {
      if (rate > 0) {
        pinnedCount = Math.max(pinnedCount, demand / rate);
      }
    }
    pinnedRecipes.set(j, pinnedCount);
    console.log(
      `  Pinning recipe ${recipesList[j].id} (index ${j}) to ${pinnedCount.toFixed(4)} facilities`,
    );
  });

  if (pinnedRecipes.size > 0) {
    // Build reduced system: substitute pinned values, solve for remaining recipes
    const freeIndices = Array.from({ length: m }, (_, i) => i).filter(
      (i) => !pinnedRecipes.has(i),
    );
    const freeM = freeIndices.length;

    console.log(
      `  Building reduced system: ${n} items × ${freeM} free recipes (${pinnedRecipes.size} pinned)`,
    );

    const matrix: number[][] = [];
    const constants: number[] = [];

    for (let i = 0; i < n; i++) {
      const itemId = itemsList[i];
      const row = new Array(freeM).fill(0);

      // Start with external demand
      let rhs = externalDemands.get(itemId) || 0;

      for (let j = 0; j < m; j++) {
        const recipe = recipesList[j];
        const output =
          recipe.outputs.find((o) => o.itemId === itemId)?.amount || 0;
        const input =
          recipe.inputs.find((inp) => inp.itemId === itemId)?.amount || 0;
        const coeff = calcRate(output, recipe.craftingTime) - calcRate(input, recipe.craftingTime);

        if (pinnedRecipes.has(j)) {
          // Move pinned contribution to RHS
          rhs -= coeff * pinnedRecipes.get(j)!;
        } else {
          const freeIdx = freeIndices.indexOf(j);
          row[freeIdx] = coeff;
        }
      }

      matrix.push(row);
      constants.push(rhs);

      console.log(
        `    Equation ${i} (${itemId}):`,
        row.map((v, fi) => `${v.toFixed(2)}*r${freeIndices[fi]}`).join(" + "),
        `= ${rhs.toFixed(4)}`,
      );
    }

    // Solve the reduced system
    let freeSolution: number[] | null;
    if (freeM === 0) {
      // All recipes are pinned — no system to solve
      freeSolution = [];
    } else if (n > freeM) {
      // Overdetermined system (more equations than free variables).
      // The linear solver expects a square matrix, so we solve for the
      // maximum required facility counts to satisfy the tightest constraints.
      // Deficits in other equations are handled by Phase 4 (external supply).
      if (freeM === 1) {
        // Single free variable: take the max of b/a across all equations
        let maxR = 0;
        for (let i = 0; i < n; i++) {
          const a = matrix[i][0];
          const b = constants[i];
          if (Math.abs(a) > 1e-9) {
            const r = b / a;
            if (r > maxR) maxR = r;
          }
        }
        freeSolution = [maxR];
        console.log(
          `  Overdetermined 1-var system: solved r = ${maxR.toFixed(4)}`,
        );
      } else {
        // Multi-variable overdetermined: use first freeM equations as primary
        // and compute residuals for the rest.
        const subMatrix = matrix.slice(0, freeM);
        const subConstants = constants.slice(0, freeM);
        freeSolution = solveLinearSystem(subMatrix, subConstants);
      }
    } else {
      freeSolution = solveLinearSystem(matrix, constants);
    }

    if (!freeSolution) {
      console.warn(
        `  [SCC_SOLVE] Cannot solve reduced SCC ${scc.id} - system has no solution`,
      );
      return tryExtendSCCWithFeeders(
        scc, graph, itemDemands, recipeFacilityCounts, maps, recipeOverrides, resolvedSCCIds, manualRawMaterials,
      );
    }

    // Assemble full facility counts
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
    // No pinned recipes — standard linear system solve (original path)
    console.log(`  Building linear system: ${n} items × ${m} recipes`);

    const matrix: number[][] = [];
    const constants: number[] = [];

    for (let i = 0; i < n; i++) {
      const itemId = itemsList[i];
      const row = new Array(m).fill(0);

      for (let j = 0; j < m; j++) {
        const recipe = recipesList[j];
        const output =
          recipe.outputs.find((o) => o.itemId === itemId)?.amount || 0;
        const input =
          recipe.inputs.find((inp) => inp.itemId === itemId)?.amount || 0;
        row[j] = calcRate(output, recipe.craftingTime) - calcRate(input, recipe.craftingTime);
      }

      matrix.push(row);
      constants.push(externalDemands.get(itemId) || 0);

      console.log(
        `    Equation ${i} (${itemId}):`,
        row.map((v, j) => `${v.toFixed(2)}*r${j}`).join(" + "),
        `= ${constants[i].toFixed(4)}`,
      );
    }

    const solution = solveLinearSystem(matrix, constants);

    if (!solution) {
      console.warn(
        `  [SCC_SOLVE] Cannot solve SCC ${scc.id} - system has no solution`,
      );
      return tryExtendSCCWithFeeders(
        scc, graph, itemDemands, recipeFacilityCounts, maps, recipeOverrides, resolvedSCCIds, manualRawMaterials,
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
  // After solving, some internal items may have a net deficit (consumed more
  // than produced within the SCC). Propagate deficits as demand to external
  // producers (e.g., liquid_sewage deficit filled by furnace outside the SCC).
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
        (calcRate(output, recipe.craftingTime) - calcRate(input, recipe.craftingTime)) *
        facilityCount;
    }

    const externalDemand = externalDemands.get(itemId) || 0;
    const deficit = externalDemand - netProduction;

    if (deficit > 1e-9) {
      // This item needs external supply — set itemDemands so external
      // producers (processed later in the condensed DAG walk) can satisfy it.
      // Use Math.max rather than addition: the deficit already accounts for
      // all external demand (including target rates from Phase 1), so adding
      // would double-count any pre-existing demand in itemDemands.
      itemDemands.set(
        itemId,
        Math.max(itemDemands.get(itemId) || 0, deficit),
      );
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

/**
 * Attempts to extend an unsolvable SCC by adding "feeder" recipes — alternative
 * recipes for overridden items that provide an external supply path.
 *
 * When a recipe override creates a closed cycle with zero net output (e.g.,
 * Iron Powder → Iron Nugget while Iron Nugget → Iron Powder), the linear system
 * is inconsistent. By adding the default recipe (e.g., Iron Ore → Iron Nugget)
 * into the SCC, the system becomes underdetermined and solvable, allowing the
 * override recipe to be used with an external supply chain feeding it.
 *
 * Returns true if the SCC was extended and successfully re-solved.
 */
function tryExtendSCCWithFeeders(
  scc: SCCInfo,
  graph: BipartiteGraph,
  itemDemands: Map<ItemId, number>,
  recipeFacilityCounts: Map<RecipeId, number>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  resolvedSCCIds?: Set<string>,
  manualRawMaterials?: Set<ItemId>,
): boolean {
  if (!recipeOverrides || recipeOverrides.size === 0) return false;

  // Find SCC items that have a user recipe override AND have alternative
  // recipes not already in the SCC.
  const feedersAdded: {
    feederRecipe: Recipe;
    overrideRecipeId: RecipeId;
    overrideDemand: number;
  }[] = [];

  for (const itemId of scc.items) {
    if (!recipeOverrides.has(itemId)) continue;

    const overrideRecipeId = recipeOverrides.get(itemId)!;
    if (!scc.recipes.has(overrideRecipeId)) continue;

    // Find alternative recipes that produce this item and are NOT in the SCC
    const alternatives = Array.from(maps.recipeMap.values()).filter(
      (r) =>
        r.id !== overrideRecipeId &&
        !scc.recipes.has(r.id) &&
        r.outputs.some((o) => o.itemId === itemId) &&
        // Must have at least one input that is NOT internal to the SCC
        // (otherwise it doesn't provide external supply)
        r.inputs.some((inp) => !scc.items.has(inp.itemId)),
    );

    if (alternatives.length === 0) continue;

    // Pick the best alternative using selectRecipe heuristic (avoids cycles)
    const feeder = selectRecipe(alternatives, scc.items);

    // Determine the demand for pinning the override recipe.
    // This is the external demand on the overridden item specifically —
    // it may be 0 if the target is a different SCC item.
    let overrideDemand = 0;
    if (graph.targets.has(itemId)) {
      overrideDemand += itemDemands.get(itemId) || 0;
    }
    // Also include demand from external consumers
    const consumers = graph.itemConsumedBy.get(itemId);
    if (consumers) {
      consumers.forEach((rid) => {
        if (!scc.recipes.has(rid)) {
          const fc = recipeFacilityCounts.get(rid) || 0;
          const recipe = maps.recipeMap.get(rid)!;
          const input = recipe.inputs.find((i) => i.itemId === itemId);
          if (input) {
            overrideDemand +=
              calcRate(input.amount, recipe.craftingTime) * fc;
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

  // --- Snapshot state before mutations so we can roll back on failure ---
  const originalSCCRecipes = new Set(scc.recipes);
  const originalExternalInputs = new Set(scc.externalInputs);
  const addedRecipeIds: RecipeId[] = [];
  const addedItemIds: ItemId[] = [];
  const addedConsumptionEdges: { itemId: ItemId; recipeId: RecipeId }[] = [];

  /**
   * Undo all graph and SCC mutations made by this function. Called before
   * returning false so that a failed extension leaves no orphan nodes or
   * stale SCC entries (which would leak into involvedRecipeIds in the
   * invalid-cycle warning, etc.).
   */
  const rollback = () => {
    // Restore SCC sets
    for (const id of scc.recipes) {
      if (!originalSCCRecipes.has(id)) scc.recipes.delete(id);
    }
    for (const id of scc.externalInputs) {
      if (!originalExternalInputs.has(id)) scc.externalInputs.delete(id);
    }
    // Remove newly added graph entries
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

  // --- Add feeder recipes to the bipartite graph and extend the SCC ---
  for (const { feederRecipe } of feedersAdded) {
    const facility = maps.facilityMap.get(feederRecipe.facilityId);
    if (!facility) continue;

    // Add recipe node to bipartite graph
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

    // Add output edges
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

    // Add input edges and traverse feeder's dependencies
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

      // Ensure input item exists in the graph
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

      // Track as external input to the SCC if not an SCC-internal item
      if (!scc.items.has(inp.itemId)) {
        scc.externalInputs.add(inp.itemId);
      }
    }

    // Add feeder to the SCC's recipe set
    scc.recipes.add(feederRecipe.id);

    console.log(
      `  [SCC_EXTEND] Added feeder recipe ${feederRecipe.id} to SCC ${scc.id}`,
    );
  }

  // --- Rebuild and solve the extended linear system ---
  // Rebuild both lists from the (potentially modified) SCC sets so that any
  // new items or recipes introduced by feeder additions are included.
  const extItemsList = Array.from(scc.items);
  const extRecipesList = Array.from(scc.recipes).map(
    (rid) => maps.recipeMap.get(rid)!,
  );
  const n = extItemsList.length;
  const m = extRecipesList.length;

  // Recompute external demands (same as Phase 1)
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
      demand += itemDemands.get(itemId) || 0;
    }
    if (demand > 0) externalDemands.set(itemId, demand);
  }

  // Pin override recipes to their demand
  const pinnedRecipes = new Map<number, number>();
  for (const { overrideRecipeId, overrideDemand } of feedersAdded) {
    const overrideIdx = extRecipesList.findIndex(
      (r) => r.id === overrideRecipeId,
    );
    if (overrideIdx === -1) continue;

    // Pin the override recipe to satisfy its output demand
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

  // Build reduced system (same approach as Path A in solveSCCFlow)
  const freeIndices = Array.from({ length: m }, (_, i) => i).filter(
    (i) => !pinnedRecipes.has(i),
  );
  const freeM = freeIndices.length;

  console.log(
    `  [SCC_EXTEND] Solving extended system: ${n} items × ${freeM} free recipes (${pinnedRecipes.size} pinned, ${m} total)`,
  );

  const matrix: number[][] = [];
  const constants: number[] = [];

  for (let i = 0; i < n; i++) {
    const itemId = extItemsList[i];
    const row = new Array(freeM).fill(0);
    let rhs = externalDemands.get(itemId) || 0;

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

    matrix.push(row);
    constants.push(rhs);
  }

  // Solve the reduced system
  let freeSolution: number[] | null;
  if (freeM === 0) {
    freeSolution = [];
  } else if (n > freeM) {
    // Overdetermined after pinning
    if (freeM === 1) {
      let maxR = 0;
      for (let i = 0; i < n; i++) {
        const a = matrix[i][0];
        const b = constants[i];
        if (Math.abs(a) > 1e-9) {
          const r = b / a;
          if (r > maxR) maxR = r;
        }
      }
      freeSolution = [maxR];
    } else {
      const subMatrix = matrix.slice(0, freeM);
      const subConstants = constants.slice(0, freeM);
      freeSolution = solveLinearSystem(subMatrix, subConstants);
    }
  } else {
    freeSolution = solveLinearSystem(matrix, constants);
  }

  if (!freeSolution) {
    console.warn(
      `  [SCC_EXTEND] Extended system still has no solution for SCC ${scc.id}`,
    );
    rollback();
    return false;
  }

  // Assemble full facility counts
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

  // --- Phase 4: Compute deficits (same as solveSCCFlow) ---
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
      itemDemands.set(
        itemId,
        Math.max(itemDemands.get(itemId) || 0, deficit),
      );
      console.log(
        `  [SCC_EXTEND] Item ${itemId} has deficit of ${deficit.toFixed(4)}/min — propagated`,
      );
    }
  }

  // --- Check: did the extension actually resolve the target demand? ---
  // If a target item in the SCC still has an unresolved deficit, the extended
  // system couldn't produce the demanded output (e.g., the override recipe
  // works against the target by dismantling the item we're trying to produce).
  // Return false so the SCC is marked invalid and a warning is shown.
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

  // Mark this SCC as resolved by feeder extension so it is excluded from
  // detectedCycles (the cycle has been linearised and should not be rendered
  // with backward edges in the visualization).
  resolvedSCCIds?.add(scc.id);

  return true;
}

/**
 * Injects disposal recipes for forced disposal items that have surplus production.
 * A disposal recipe is injected when a byproduct in `forcedDisposalItems` is produced
 * but not fully consumed by other recipes or target demands.
 */
function injectDisposalRecipes(
  graph: BipartiteGraph,
  flowData: FlowData,
  maps: ProductionMaps,
  targets: Array<{ itemId: ItemId; rate: number }>,
): void {
  for (const itemId of forcedDisposalItems) {
    // Only inject for items that exist in this plan
    if (!graph.itemNodes.has(itemId)) continue;
    const itemNode = graph.itemNodes.get(itemId)!;
    if (itemNode.isRawMaterial) continue;

    // Compute total production of this item across all recipes
    let totalProduction = 0;
    graph.recipeOutputs.forEach((outputItems, recipeId) => {
      if (outputItems.has(itemId)) {
        const recipe = maps.recipeMap.get(recipeId)!;
        const facilityCount =
          flowData.recipeFacilityCounts.get(recipeId) || 0;
        const output = recipe.outputs.find((o) => o.itemId === itemId);
        if (output) {
          totalProduction +=
            calcRate(output.amount, recipe.craftingTime) * facilityCount;
        }
      }
    });

    // Compute total consumption by non-disposal recipes
    let totalConsumption = 0;
    const consumers = graph.itemConsumedBy.get(itemId);
    if (consumers) {
      for (const recipeId of consumers) {
        const recipe = maps.recipeMap.get(recipeId)!;
        // Skip disposal recipes to avoid double-counting
        if (recipe.outputs.length === 0) continue;
        const facilityCount =
          flowData.recipeFacilityCounts.get(recipeId) || 0;
        const input = recipe.inputs.find((i) => i.itemId === itemId);
        if (input) {
          totalConsumption +=
            calcRate(input.amount, recipe.craftingTime) * facilityCount;
        }
      }
    }

    // Subtract target demand (user wants to collect this amount, not dispose)
    const targetDemand =
      targets.find((t) => t.itemId === itemId)?.rate || 0;

    const surplus = totalProduction - totalConsumption - targetDemand;
    if (surplus <= 0) continue;

    // Find the matching disposal recipe
    const disposalRecipe = Array.from(maps.recipeMap.values()).find(
      (r) =>
        r.outputs.length === 0 &&
        r.inputs.some((i) => i.itemId === itemId),
    );
    if (!disposalRecipe) continue;

    // Already injected
    if (graph.recipeNodes.has(disposalRecipe.id)) continue;

    // Compute disposal facility count
    const disposalInput = disposalRecipe.inputs.find(
      (i) => i.itemId === itemId,
    )!;
    const disposalRatePerFacility = calcRate(
      disposalInput.amount,
      disposalRecipe.craftingTime,
    );
    const disposalFacilityCount = surplus / disposalRatePerFacility;

    // Resolve facility
    const facility = maps.facilityMap.get(disposalRecipe.facilityId);
    if (!facility) continue;

    // Inject into graph structures
    graph.recipeNodes.set(disposalRecipe.id, {
      recipeId: disposalRecipe.id,
      recipe: disposalRecipe,
      facility,
    });
    graph.recipeInputs.set(disposalRecipe.id, new Set([itemId]));
    graph.recipeOutputs.set(disposalRecipe.id, new Set());

    // Add consumption edge
    if (!graph.itemConsumedBy.has(itemId)) {
      graph.itemConsumedBy.set(itemId, new Set());
    }
    graph.itemConsumedBy.get(itemId)!.add(disposalRecipe.id);

    // Record facility count in flow data
    flowData.recipeFacilityCounts.set(
      disposalRecipe.id,
      disposalFacilityCount,
    );
  }
}

function buildProductionGraph(
  graph: BipartiteGraph,
  flowData: FlowData,
  sccs: SCCInfo[],
  maps: ProductionMaps,
  invalidSCCs: InvalidSCCInfo[] = [],
  recipeOverrides?: Map<ItemId, RecipeId>,
): ProductionDependencyGraph {
  const nodes = new Map<string, ProductionGraphNode>();
  const edges: Array<{ from: string; to: string }> = [];

  // Add item nodes
  graph.itemNodes.forEach((itemNode, itemId) => {
    let productionRate = 0;

    if (itemNode.isRawMaterial) {
      productionRate = flowData.itemDemands.get(itemId) || 0;
    } else {
      // Sum production from ALL recipes that output this item.
      // An item can be produced by multiple recipes (e.g., as a primary output
      // of one recipe and a byproduct of another).
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
  // Add recipe nodes
  graph.recipeNodes.forEach((recipeData, recipeId) => {
    nodes.set(recipeId, {
      type: "recipe",
      recipeId,
      recipe: recipeData.recipe,
      facility: recipeData.facility,
      facilityCount: flowData.recipeFacilityCounts.get(recipeId) || 0,
      isDisposal: recipeData.recipe.outputs.length === 0,
    });
  });

  // Build edges: Item → Recipe (consume)
  graph.itemConsumedBy.forEach((recipeIds, itemId) => {
    recipeIds.forEach((recipeId) => {
      edges.push({ from: itemId, to: recipeId });
    });
  });

  // Build edges: Recipe → Item (produce)
  graph.recipeOutputs.forEach((itemIds, recipeId) => {
    itemIds.forEach((itemId) => {
      edges.push({ from: recipeId, to: itemId });
    });
  });

  // Build cycle info — exclude SCCs that were resolved by feeder extension
  // since they are now linear chains, not true production cycles.
  const activeSCCs = sccs.filter(
    (scc) => !flowData.resolvedSCCIds.has(scc.id),
  );
  const detectedCycles: DetectedCycle[] = activeSCCs.map((scc) => {
    const cycleNodes: ProductionNode[] = Array.from(scc.recipes).flatMap(
      (recipeId) => {
        const recipeData = graph.recipeNodes.get(recipeId)!;
        const facilityCount = flowData.recipeFacilityCounts.get(recipeId) || 0;
        const outputs = recipeData.recipe.outputs;

        return outputs.map((out) => ({
          item: graph.itemNodes.get(out.itemId)!.item,
          targetRate:
            calcRate(out.amount, recipeData.recipe.craftingTime) *
            facilityCount,
          recipe: recipeData.recipe,
          facility: recipeData.facility,
          facilityCount,
          isRawMaterial: false,
          isTarget: false,
          dependencies: [],
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

  // Build invalid cycle info from unresolved SCCs
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
  };
}

/**
 * Try to backtrack recipe choices to avoid invalid SCCs
 * Returns updated recipe constraints or null if no more options
 */
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

  // Collect all items involved in invalid SCCs
  const problematicItems = new Set<ItemId>();
  invalidSCCs.forEach((scc) => {
    scc.involvedItems.forEach((itemId) => problematicItems.add(itemId));
  });

  console.log(
    `[BACKTRACK] Problematic items: ${Array.from(problematicItems).join(", ")}`,
  );

  // Find items with alternative recipe choices, prioritizing items in invalid SCCs
  const itemsWithChoices = Array.from(recipeChoices.values())
    .filter((choice) => problematicItems.has(choice.itemId))
    .sort((a, b) => b.currentIndex - a.currentIndex); // Start from items that have tried fewer options

  if (itemsWithChoices.length === 0) {
    // No items with multiple choices in the problematic set
    console.log(
      `[BACKTRACK] No alternative recipes available for problematic items`,
    );
    return null;
  }

  // Try to find the next recipe choice
  for (const choice of itemsWithChoices) {
    const nextIndex = choice.currentIndex + 1;

    if (nextIndex < choice.availableRecipes.length) {
      // Found an item with an untried recipe
      console.log(
        `[BACKTRACK] Trying next recipe for item ${choice.itemId}: ` +
          `index ${nextIndex}/${choice.availableRecipes.length}`,
      );

      const newConstraints = new Map(currentConstraints);

      // Exclude all recipes up to and including current index
      const excludedRecipes = new Set(
        currentConstraints.get(choice.itemId) || [],
      );
      for (let i = 0; i <= choice.currentIndex; i++) {
        excludedRecipes.add(choice.availableRecipes[i]);
      }
      newConstraints.set(choice.itemId, excludedRecipes);

      // Update the choice index
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
      // Success! No invalid SCCs found
      console.log(
        `[SUCCESS] Valid production plan found in ${iteration} iteration(s)`,
      );
      injectDisposalRecipes(graph, flowData, maps, targets);
      return buildProductionGraph(
        graph,
        flowData,
        sccs,
        maps,
        [],
        recipeOverrides,
      );
    }

    // Try to backtrack
    console.log(
      `[ITERATION ${iteration}] Found ${invalidSCCs.length} invalid SCC(s), attempting backtrack`,
    );

    const newConstraints = backtrackRecipeChoices(
      recipeChoices,
      invalidSCCs,
      recipeConstraints,
    );

    if (newConstraints === null) {
      // No more recipe combinations to try
      console.warn(
        `[FAILED] Cannot find valid production plan after ${iteration} iterations. ` +
          `Returning best-effort result with ${invalidSCCs.length} invalid cycle(s).`,
      );
      injectDisposalRecipes(graph, flowData, maps, targets);
      return buildProductionGraph(
        graph,
        flowData,
        sccs,
        maps,
        invalidSCCs,
        recipeOverrides,
      );
    }

    recipeConstraints = newConstraints;
  }

  throw new Error(
    `Maximum iterations (${MAX_ITERATIONS}) reached. Cannot find valid production plan.`,
  );
}
