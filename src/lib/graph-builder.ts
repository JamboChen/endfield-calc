import type { Recipe, ItemId, RecipeId } from "@/types";
import { forcedRawMaterials } from "@/data";
import type {
  ProductionMaps,
  BipartiteGraph,
  SCCInfo,
  CondensedNode,
  RecipeChoice,
  BuildGraphResult,
} from "./calculator-types";

const isDismantleRecipe = (r: Recipe): boolean =>
  r.inputs.some((i) => i.itemId.startsWith("item_fbottle_"));

const selectRecipe = (recipes: Recipe[], visitedPath: Set<ItemId>): Recipe => {
  const nonDismantle = recipes.filter((r) => !isDismantleRecipe(r));
  const pool = nonDismantle.length > 0 ? nonDismantle : recipes;

  const singleOutput = pool.filter((r) => r.outputs.length === 1);

  if (singleOutput.length > 0) {
    if (visitedPath.size > 0) {
      const nonCircular = singleOutput.filter(
        (r) => !r.inputs.some((input) => visitedPath.has(input.itemId)),
      );
      if (nonCircular.length > 0) return nonCircular[0];
    }
    return singleOutput[0];
  }

  if (visitedPath.size > 0) {
    const nonCircular = pool.filter(
      (r) => !r.inputs.some((input) => visitedPath.has(input.itemId)),
    );
    if (nonCircular.length > 0) return nonCircular[0];
  }

  return pool[0];
};

export { selectRecipe };

const getOrThrow = <K, V>(map: Map<K, V>, key: K, type: string): V => {
  const value = map.get(key);
  if (!value) throw new Error(`${type} not found: ${key}`);
  return value;
};

export function buildBipartiteGraph(
  targets: Array<{ itemId: ItemId; rate: number }>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  manualRawMaterials?: Set<ItemId>,
  recipeConstraints?: Map<ItemId, Set<RecipeId>>,
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

    graph.itemNodes.set(itemId, { itemId, item, isRawMaterial: isRaw });

    if (isRaw) {
      graph.rawMaterials.add(itemId);
      return;
    }

    let availableRecipes = Array.from(maps.recipeMap.values()).filter((r) =>
      r.outputs.some((o) => o.itemId === itemId),
    );

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

    const recipeIds = availableRecipes.map((r) => r.id);
    let currentIndex: number;

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

export function detectSCCs(graph: BipartiteGraph): SCCInfo[] {
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

export function buildCondensedDAGAndSort(
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
