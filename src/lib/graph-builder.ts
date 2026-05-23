import type { Recipe, ItemId, RecipeId } from "@/types";
import { forcedRawMaterials } from "@/data";
import type {
  ProductionMaps,
  BipartiteGraph,
  SCCInfo,
} from "./calculator-types";

/**
 * Dismantle recipes recover raw resources from bottled byproducts.
 * Their inputs all start with `item_fbottle_*`. Detected via the input
 * prefix because the dismantle facility itself (`DISMANTLER_1`) can in
 * principle host other recipes; the prefix is a more stable signal.
 */
const isDismantleRecipe = (r: Recipe): boolean =>
  r.inputs.some((i) => i.itemId.startsWith("item_fbottle_"));

/**
 * Resolve the producer-recipe set for a single item under the current
 * plan's constraints.
 *
 * Order of operations matters:
 *
 *   1. **Filter to recipes that actually output `itemId`** — every recipe
 *      in `recipes` whose `outputs` includes the item.
 *   2. **Honour user pin (recipeOverrides)** — if the user has explicitly
 *      pinned a recipe for this item via the dropdown / URL `r=` flag,
 *      narrow the set to just that one recipe and return. The override
 *      is final; dismantler fallback and AIC-level exclusion don't apply
 *      *to the pin itself* because the user has overridden them.
 *   3. **Apply AIC / per-plan exclusions (recipeConstraints)** — drop any
 *      recipe the active research / domain settings have forbidden.
 *   4. **Per-item dismantler fallback** — if at least one *non-dismantle*
 *      producer survives, drop dismantle producers (they're rare-case
 *      bottled-resource recovery, not the canonical production path).
 *      If only dismantle producers remain, keep them so the item is
 *      still producible somehow.
 *
 * Returns an empty array iff no recipe can satisfy the item; callers
 * then mark the item as raw (chain-terminator) or surface infeasibility.
 */
function availableProducersFor(
  itemId: ItemId,
  recipes: Iterable<Recipe>,
  recipeOverrides: Map<ItemId, RecipeId> | undefined,
  recipeConstraints: Map<ItemId, Set<RecipeId>> | undefined,
): Recipe[] {
  const allProducers: Recipe[] = [];
  for (const r of recipes) {
    if (r.outputs.some((o) => o.itemId === itemId)) {
      allProducers.push(r);
    }
  }

  // User pin wins outright. If the pinned recipe still exists in the
  // available set, we narrow to just it; if it's been removed by AIC
  // research locks upstream, fall through to the standard pipeline and
  // let the LP / cleanup layers surface the discrepancy.
  if (recipeOverrides?.has(itemId)) {
    const pinnedId = recipeOverrides.get(itemId)!;
    const pinned = allProducers.find((r) => r.id === pinnedId);
    if (pinned) return [pinned];
    // Pinned recipe gone (AIC lock?); fall through to normal selection.
  }

  // Per-plan exclusions (AIC research, etc.).
  let pool = allProducers;
  const excluded = recipeConstraints?.get(itemId);
  if (excluded && excluded.size > 0) {
    pool = pool.filter((r) => !excluded.has(r.id));
  }

  // Per-item dismantler fallback: dismantlers only fire when they're
  // the sole producer.
  const nonDismantle = pool.filter((r) => !isDismantleRecipe(r));
  return nonDismantle.length > 0 ? nonDismantle : pool;
}

const getOrThrow = <K, V>(map: Map<K, V>, key: K, type: string): V => {
  const value = map.get(key);
  if (!value) throw new Error(`${type} not found: ${key}`);
  return value;
};

/**
 * Build a bipartite item↔recipe graph rooted at the user's targets.
 *
 * **Multi-recipe traversal**: every reachable item gets edges to **all**
 * of its surviving producers (per `availableProducersFor`), not just one
 * heuristic pick. The LP downstream (`solveGlobalFlow` in
 * `flow-solver.ts`) picks which producers actually run and at what rate
 * by minimising the lex objective `rawCost → buildingCount → power`.
 *
 * Items become `isRawMaterial = true` when they are forced raws,
 * user-marked manual raws, or have no surviving producers (terminal
 * leaves of the chain).
 *
 * Cycles are allowed: the LP handles them natively via balance
 * constraints (production − consumption ≥ 0). The downstream
 * `detectSCCs` / `buildCondensedDAGAndSort` are kept for rendering
 * (backward-edge styling, prefill detection), not for solving.
 */
export function buildBipartiteGraph(
  targets: Array<{ itemId: ItemId; rate: number }>,
  maps: ProductionMaps,
  recipeOverrides?: Map<ItemId, RecipeId>,
  manualRawMaterials?: Set<ItemId>,
  recipeConstraints?: Map<ItemId, Set<RecipeId>>,
): BipartiteGraph {
  const graph: BipartiteGraph = {
    itemNodes: new Map(),
    recipeNodes: new Map(),
    itemConsumedBy: new Map(),
    recipeInputs: new Map(),
    recipeOutputs: new Map(),
    targets: new Set(targets.map((t) => t.itemId)),
    rawMaterials: new Set(),
  };

  const visitedItems = new Set<ItemId>();

  function traverse(itemId: ItemId) {
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

    const producers = availableProducersFor(
      itemId,
      maps.recipeMap.values(),
      recipeOverrides,
      recipeConstraints,
    );

    if (producers.length === 0) {
      // No way to produce this item under current constraints — treat as
      // a chain-terminating raw. Downstream LP sees infinite supply for
      // it (raws are excluded from balance constraints).
      graph.itemNodes.get(itemId)!.isRawMaterial = true;
      graph.rawMaterials.add(itemId);
      return;
    }

    // Add ALL surviving producers as recipe nodes and recurse on the
    // union of their inputs. Cycles are detected post-hoc by Tarjan SCC.
    for (const producer of producers) {
      const facility = getOrThrow(
        maps.facilityMap,
        producer.facilityId,
        "Facility",
      );

      if (!graph.recipeNodes.has(producer.id)) {
        graph.recipeNodes.set(producer.id, {
          recipeId: producer.id,
          recipe: producer,
          facility,
        });
        graph.recipeInputs.set(producer.id, new Set());
        graph.recipeOutputs.set(producer.id, new Set());
      }

      // Stage all outputs (primary + byproducts) as item nodes so the
      // LP sees their balance constraints. Byproducts that have no
      // demand downstream simply have `min: 0` constraints (LP-optimal
      // drives them to 0).
      producer.outputs.forEach((out) => {
        graph.recipeOutputs.get(producer.id)!.add(out.itemId);
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

      producer.inputs.forEach((input) => {
        graph.recipeInputs.get(producer.id)!.add(input.itemId);
        if (!graph.itemConsumedBy.has(input.itemId)) {
          graph.itemConsumedBy.set(input.itemId, new Set());
        }
        graph.itemConsumedBy.get(input.itemId)!.add(producer.id);

        traverse(input.itemId);
      });
    }
  }

  targets.forEach(({ itemId }) => traverse(itemId));

  return graph;
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

        if (import.meta.env?.DEV) {
          console.log(`[SCC] Detected cycle: ${sccInfo.id}`);
          console.log(`  Items (${sccItems.size}):`, Array.from(sccItems));
          console.log(
            `  Recipes (${sccRecipes.size}):`,
            Array.from(sccRecipes),
          );
          console.log(
            `  External inputs (${externalInputs.size}):`,
            Array.from(externalInputs),
          );
        }

        sccs.push(sccInfo);
      }
    }
  }

  graph.itemNodes.forEach((_, itemId) => {
    if (!indices.has(itemId)) {
      strongConnect(itemId, "item");
    }
  });

  if (import.meta.env?.DEV) {
    console.log(`[SCC] Total SCCs detected: ${sccs.length}`);
  }
  return sccs;
}
