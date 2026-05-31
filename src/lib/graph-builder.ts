import type { FacilityId, Recipe, ItemId, RecipeId } from "@/types";
import { facilityRecipeVariants, forcedDisposalItems } from "@/data";
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
 * heuristic pick. The LP downstream (`calculateFlows` in
 * `flow-solver.ts`) picks which producers actually run and at what rate
 * by minimising the lex objective `rawCost → buildingCount → power`.
 *
 * Items become `isRawMaterial = true` when they are in the passed
 * `rawMaterials` set (the plan's per-region raw classification),
 * user-marked manual raws, or have no surviving producers (terminal
 * leaves of the chain).
 *
 * `rawMaterials` is required. The caller (`calculateProductionPlan`)
 * passes the per-region raw set; tests pass whatever matches their
 * synthetic recipe shape (typically `new Set<ItemId>()` when leaf
 * items are recipe-inferred raws).
 *
 * Cycles are allowed: the LP handles them natively via balance
 * constraints (production − consumption ≥ 0). The downstream
 * `detectSCCs` is kept for rendering (backward-edge styling, prefill
 * detection), not for solving.
 */
export function buildBipartiteGraph(
  targets: Array<{ itemId: ItemId; rate: number }>,
  maps: ProductionMaps,
  rawMaterials: ReadonlySet<ItemId>,
  recipeOverrides?: Map<ItemId, RecipeId>,
  manualRawMaterials?: Set<ItemId>,
  recipeConstraints?: Map<ItemId, Set<RecipeId>>,
  facilityCaps?: ReadonlyMap<FacilityId, number>,
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
      rawMaterials.has(itemId) ||
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

  // ── Pre-LP disposal-recipe injection ────────────────────────────────
  //
  // Target-rooted traversal only adds recipes that PRODUCE items needed
  // for a target — zero-output disposal recipes (Liquid Cleaner; Sewage
  // Inlet's DISPOSAL variant) never enter the graph that way. Sewage
  // Inlet's BYPRODUCT variant (which produces xiranite_poly) similarly
  // only enters if xiranite_poly is reachable from a target. The result
  // is that the LP can't reason about disposal at all unless we pull
  // those recipes in here.
  //
  // The injection rule: for every forced-disposal item in the graph
  // (excluding raws), pull in every consumer recipe from
  // `availableProducersFor`-compatible sources whose outputs are either
  // empty OR entirely forced-disposal items. The "outputs are all
  // forced-disposal" gate is what lets BYPRODUCT recipes participate
  // without dragging in arbitrary downstream chains — we trust the LP
  // to handle the new disposal item via the same mechanism, recursing
  // until we hit pure zero-output disposers.
  //
  // Termination: a visited set guards against revisiting an item;
  // cascading from sewage→xiranite_poly→… always lands at a zero-output
  // disposer in finite steps (in current data, `liquid_cleaner_1` is
  // the terminal sink for all three forced-disposal items).
  //
  // Recipe-availability gating: the disposal recipes still pass through
  // `availableProducersFor`-style filters (recipeConstraints) so that
  // the App-layer's structure-variant filter (drop one of the two
  // LIQUID_CLEAN_GATE_1 variants) is honoured. We deliberately bypass the
  // `recipeOverrides` pin check (disposal isn't pin-eligible) and the
  // dismantler fallback (dismantle recipes can't be disposal recipes —
  // their inputs start with `item_fbottle_*`, not a forced-disposal
  // item).
  injectDisposalRecipesIntoGraph(
    graph,
    maps,
    recipeConstraints,
    facilityCaps,
  );

  return graph;
}

/**
 * Add disposal recipes (zero-output OR forced-disposal-only-output)
 * that consume any forced-disposal item present in the graph. Mutates
 * `graph` in place. See `buildBipartiteGraph` for the rationale.
 *
 * Performance: O((D × R) + cascade) where D = number of forced-disposal
 * items in the graph (≤ |forcedDisposalItems|, today 3) and R = total
 * recipes. Trivial at our scale.
 */
function injectDisposalRecipesIntoGraph(
  graph: BipartiteGraph,
  maps: ProductionMaps,
  recipeConstraints: Map<ItemId, Set<RecipeId>> | undefined,
  facilityCaps: ReadonlyMap<FacilityId, number> | undefined,
): void {
  // Recipes belonging to a `facilityRecipeVariants` entry are
  // opt-in via the structures UI: skip them unless the user has
  // explicitly capped the facility to a positive number. This matches
  // the App.tsx-side variant filter and keeps test callers that pass
  // the unfiltered `recipes` array without a `facilityCaps` map from
  // accidentally using LIQUID_CLEAN_GATE_1 variant recipes. The set is keyed by
  // recipe id for an O(1) skip check below.
  const optInVariantRecipeIds = new Set<RecipeId>();
  for (const [facilityId, variants] of facilityRecipeVariants) {
    const cap = facilityCaps?.get(facilityId) ?? 0;
    if (cap > 0) continue;
    optInVariantRecipeIds.add(variants.default);
    optInVariantRecipeIds.add(variants.toggled);
  }

  // Seed the queue with forced-disposal items already in the graph
  // (and not raws — a raw forced-disposal item has infinite supply, no
  // disposal needed).
  const queue: ItemId[] = [];
  const visited = new Set<ItemId>();
  for (const itemId of graph.itemNodes.keys()) {
    if (!forcedDisposalItems.has(itemId)) continue;
    if (graph.itemNodes.get(itemId)!.isRawMaterial) continue;
    queue.push(itemId);
    visited.add(itemId);
  }

  while (queue.length > 0) {
    const itemId = queue.shift()!;

    for (const recipe of maps.recipeMap.values()) {
      // Filter 0: skip opt-in variant recipes when the user hasn't
      // explicitly enabled them via `facilityCaps`. Mirrors App.tsx's
      // `structureVariantExcluded` set so tests that don't enable
      // structures don't accidentally pick up LIQUID_CLEAN_GATE_1 variants.
      if (optInVariantRecipeIds.has(recipe.id)) continue;

      // Filter 1: recipe must consume `itemId`.
      if (!recipe.inputs.some((i) => i.itemId === itemId)) continue;

      // Filter 2: recipe must be "disposal-shaped" — either zero outputs
      // (a pure sink) or every output must itself be a forced-disposal
      // item (we'll cascade-handle them below). This keeps the
      // injection contained: an arbitrary multi-output recipe that
      // happens to consume sewage as a side input (e.g. POOL_LIQUID_
      // XIRANITE_POLY consumes sewage but produces xiranite_poly +
      // xiranite_lowpoly — BOTH forced-disposal, so it qualifies) is
      // included; one consuming sewage to produce something useful
      // would already be in the graph via target-rooted traversal.
      const isDisposalShape =
        recipe.outputs.length === 0 ||
        recipe.outputs.every((o) => forcedDisposalItems.has(o.itemId));
      if (!isDisposalShape) continue;

      // Filter 3: honour recipeConstraints (the App-layer's structure-
      // variant filter lives here). We can't reuse `availableProducersFor`
      // directly because it's keyed on output items, but the per-item
      // exclusion semantics are the same.
      let excluded = false;
      for (const out of recipe.outputs) {
        const ex = recipeConstraints?.get(out.itemId);
        if (ex?.has(recipe.id)) {
          excluded = true;
          break;
        }
      }
      if (excluded) continue;
      // Also honour exclusions keyed under the consumed item itself
      // (covers zero-output recipes — `outputs` loop above yields no
      // iterations to check).
      const exForInput = recipeConstraints?.get(itemId);
      if (exForInput?.has(recipe.id)) continue;

      // Filter 4: skip if already in the graph (target traversal may
      // have added it for non-zero-output cases).
      if (graph.recipeNodes.has(recipe.id)) continue;

      const facility = maps.facilityMap.get(recipe.facilityId);
      if (!facility) continue;

      // Add recipe node + wire up edges.
      graph.recipeNodes.set(recipe.id, {
        recipeId: recipe.id,
        recipe,
        facility,
      });
      graph.recipeInputs.set(recipe.id, new Set(recipe.inputs.map((i) => i.itemId)));
      graph.recipeOutputs.set(recipe.id, new Set(recipe.outputs.map((o) => o.itemId)));
      for (const input of recipe.inputs) {
        if (!graph.itemConsumedBy.has(input.itemId)) {
          graph.itemConsumedBy.set(input.itemId, new Set());
        }
        graph.itemConsumedBy.get(input.itemId)!.add(recipe.id);
        // Make sure the input item has a node — disposal recipes can
        // reference items that target traversal didn't visit (e.g.
        // xiranite_lowpoly when only sewage was target-reachable).
        if (!graph.itemNodes.has(input.itemId)) {
          const inputItem = maps.itemMap.get(input.itemId);
          if (inputItem) {
            graph.itemNodes.set(input.itemId, {
              itemId: input.itemId,
              item: inputItem,
              isRawMaterial: false,
            });
          }
        }
      }
      for (const output of recipe.outputs) {
        if (!graph.itemNodes.has(output.itemId)) {
          const outputItem = maps.itemMap.get(output.itemId);
          if (outputItem) {
            graph.itemNodes.set(output.itemId, {
              itemId: output.itemId,
              item: outputItem,
              isRawMaterial: false,
            });
          }
        }
        // Enqueue newly-introduced forced-disposal items so we cascade
        // until every disposal chain terminates at a pure sink.
        if (
          forcedDisposalItems.has(output.itemId) &&
          !visited.has(output.itemId)
        ) {
          visited.add(output.itemId);
          queue.push(output.itemId);
        }
      }
    }
  }
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
