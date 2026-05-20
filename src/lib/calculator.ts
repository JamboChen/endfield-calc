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
import { forcedDisposalItems } from "@/data";
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
 * **Important**: `rawMaterials` MUST be the plan's runtime raw set
 * (typically `graph.rawMaterials`, the union of `forcedRawMaterials`,
 * user-supplied `manualRawMaterials`, and any LP-extended SCC feeder
 * raws). Passing `forcedRawMaterials` alone misses user-marked manual
 * raws and produces false-positive prefill chips.
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
 * Iterative Tarjan strongly-connected-components algorithm. Generic over
 * the node identifier type — used here over `RecipeId` (per-bin recipe
 * graphs). Returns SCCs in reverse topological order (sinks first).
 *
 * Inline because this is currently the only consumer in the codebase.
 * Extract to `src/lib/scc.ts` if a second caller emerges. Implementation
 * is iterative (not the classic recursive form) to avoid stack overflow
 * on pathological inputs, though in practice the per-bin recipe graphs
 * are tiny (≤ ~5 nodes).
 */
function tarjanScc<T>(
  nodes: readonly T[],
  edges: Map<T, ReadonlyArray<{ to: T }>>,
): T[][] {
  const index = new Map<T, number>();
  const lowlink = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const sccs: T[][] = [];
  let nextIndex = 0;

  // Iterative DFS frame: (node, iterator-position into edges).
  type Frame = { node: T; edgeIdx: number };

  for (const root of nodes) {
    if (index.has(root)) continue;
    const dfsStack: Frame[] = [{ node: root, edgeIdx: 0 }];
    index.set(root, nextIndex);
    lowlink.set(root, nextIndex);
    nextIndex++;
    stack.push(root);
    onStack.add(root);

    while (dfsStack.length > 0) {
      const frame = dfsStack[dfsStack.length - 1];
      const out = edges.get(frame.node) ?? [];
      if (frame.edgeIdx < out.length) {
        const next = out[frame.edgeIdx].to;
        frame.edgeIdx++;
        if (!index.has(next)) {
          index.set(next, nextIndex);
          lowlink.set(next, nextIndex);
          nextIndex++;
          stack.push(next);
          onStack.add(next);
          dfsStack.push({ node: next, edgeIdx: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node)!, index.get(next)!),
          );
        }
      } else {
        // All children processed; pop and propagate lowlink to parent.
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const component: T[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
            if (w === frame.node) break;
          }
          sccs.push(component);
        }
        dfsStack.pop();
        if (dfsStack.length > 0) {
          const parent = dfsStack[dfsStack.length - 1];
          lowlink.set(
            parent.node,
            Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
          );
        }
      }
    }
  }
  return sccs;
}

/**
 * Populate per-(bin, recipe) and per-bin prefill-candidate lists for
 * every recipe-level cycle that lacks an external entry point. Run
 * after `packBins` so we can map cycle recipes back to their hosting
 * bins via `recipeBinAllocations`.
 *
 * Two-phase detection, each phase keyed to the natural problem layer:
 *
 *   **Phase 1 — Intra-bin cycles (any size).** For each bin with ≥ 2
 *   recipes, build the intra-bin recipe-flow graph (edges = item flows
 *   between recipes co-located in the bin) and run Tarjan SCC over it.
 *   Each non-trivial SCC (size ≥ 2) is a cycle whose items must bootstrap
 *   somehow. Skip flagging iff ANY cycle item is in `bin.externalInputs`
 *   — a single external port suffices because the cycle bootstraps from
 *   that side. Otherwise flag per recipe (each recipe in the SCC carries
 *   the cycle items it consumes). Tarjan handles 2-recipe, 3-recipe, and
 *   N-recipe intra-bin cycles uniformly.
 *
 *   **Phase 2 — Inter-bin 2-cycles.** For each recipe-graph SCC, iterate
 *   2-cycle pairs (A, B) and consider every (binA hosting A, binB hosting
 *   B) pair where `binA != binB` (intra-bin pairs are skipped — Phase 1
 *   already covered them). Apply the bootability filter: flag iff BOTH
 *   cycle items are non-bootable from raws via the active recipe set.
 *   If either is bootable, the cycle bootstraps from that side without
 *   prefill (e.g. in Xircon-60, Sewage is bootable via Furnace so the
 *   inter-bin (Effluent-Prod, Xircon-Prod) pair stays silent).
 *
 * The two phases reflect different physical realities. Intra-bin cycles
 * are constrained by the bin's port allocation (a hard LP decision — a
 * cycle item without a port literally cannot accept external supply, no
 * matter the routing); the per-bin external-entry check is the precise
 * condition. Inter-bin cycles span belts/pipes that the player can
 * re-route, so the question is whether a raws-reachable producer exists
 * anywhere in the plan; the bootability fixpoint captures this.
 *
 * **Known limitation**: 3+ recipe inter-bin cycles are not currently
 * detected — Phase 2 iterates pairs only. No real-game data exhibits
 * this topology, and adding a bin-flow-graph SCC layer would be a
 * larger refactor. A defensive DEV log fires if a recipe-graph SCC of
 * size ≥ 3 yields no 2-cycle pair, so we'd notice if game data ever
 * triggers it.
 *
 * Mutates `bins` in place (sets `bin.prefillCandidates` as the union
 * over member recipes' per-bin flagged items, filtered to inputs the
 * bin's recipes actually consume). Returns a per-recipe map (UNION
 * across all hosting bins of a given recipe id) so `buildProductionGraph`
 * can copy it onto each recipe's `ProductionGraphNode`, where
 * `merged-mapper` (bf=0) reads it for the per-recipe chip rendering.
 *
 * **Exported for testing** so `T3` (3-recipe intra-bin cycle) and other
 * hand-crafted topology cases can call this directly with synthetic
 * `Bin` / `RecipeBinAllocation` objects, bypassing the packer. Production
 * code calls it through `calculateProductionPlan` only.
 *
 * **`rawMaterials` parameter contract**: production callers pass the
 * plan's `graph.rawMaterials` (built by `graph-builder` as the union of
 * `forcedRawMaterials` + `manualRawMaterials` + any LP-extended feeder
 * raws). This is the single source of truth for "what counts as raw in
 * THIS plan", and the bootability fixpoint reads it directly — no
 * import of `forcedRawMaterials` here. Tests pass whatever raw set
 * matches the synthetic scenario (typically `new Set<ItemId>()` when
 * the fixture's items aren't game-data raws).
 */
export function propagatePrefillCandidates(
  bins: Bin[],
  sccs: SCCInfo[],
  recipeBinAllocations: Map<RecipeId, RecipeBinAllocation>,
  recipeMap: Map<RecipeId, Recipe>,
  rawMaterials: ReadonlySet<ItemId>,
): Map<RecipeId, ItemId[]> {
  const binsById = new Map<string, Bin>();
  for (const bin of bins) binsById.set(bin.id, bin);

  const bootable = computeBootableItems(
    recipeBinAllocations.keys(),
    recipeMap,
    rawMaterials,
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

  // Per-(bin, recipe) accumulator: outer key = binId (plain string),
  // inner key = RecipeId. Nested map keeps `RecipeId` properly typed
  // throughout — no string-parsing cast on extraction. The bin-level
  // union and per-recipe union (across hosting bins) are derived below.
  const perBinRecipe = new Map<string, Map<RecipeId, Set<ItemId>>>();
  const addToBinRecipe = (
    binId: string,
    recipeId: RecipeId,
    items: ItemId[],
    label: string,
  ) => {
    if (items.length === 0) return;
    let inner = perBinRecipe.get(binId);
    if (!inner) {
      inner = new Map<RecipeId, Set<ItemId>>();
      perBinRecipe.set(binId, inner);
    }
    let bucket = inner.get(recipeId);
    if (!bucket) {
      bucket = new Set<ItemId>();
      inner.set(recipeId, bucket);
    }
    for (const id of items) bucket.add(id);
    if (import.meta.env?.DEV) {
      console.log(
        `[PREFILL]   ${label} bin ${binId} <- recipe ${recipeId}: +[${items.join(", ")}]`,
      );
    }
  };

  // ============================================================
  // Phase 1: Intra-bin cycles via per-bin Tarjan SCC.
  // ============================================================
  // For each bin with ≥ 2 recipes, build the intra-bin recipe-flow
  // graph and run Tarjan. Each non-trivial SCC (size ≥ 2) is a true
  // intra-bin cycle that must bootstrap from some external port or
  // a player seed. Tarjan handles 2-recipe, 3-recipe, and N-recipe
  // cycles uniformly — no pair iteration needed at this layer.
  for (const bin of bins) {
    if (bin.recipeIds.length < 2) continue;

    // Build the intra-bin recipe-flow graph: edge r1 -> r2 labeled with
    // each item that r1 produces and r2 consumes (both co-located in
    // this bin). Self-loops (r1 === r2) are INTENTIONALLY included —
    // a recipe consuming its own output is a degenerate intra-bin cycle
    // of size 1 that the cycle-items loop downstream picks up correctly.
    type IntraEdge = { to: RecipeId; item: ItemId };
    const intraEdges = new Map<RecipeId, IntraEdge[]>();
    for (const r1 of bin.recipeIds) {
      const recipe1 = recipeMap.get(r1);
      if (!recipe1) continue;
      const outs = recipe1.outputs.map((o) => o.itemId);
      const bucket: IntraEdge[] = [];
      for (const r2 of bin.recipeIds) {
        const recipe2 = recipeMap.get(r2);
        if (!recipe2) continue;
        const r2Inputs = new Set(recipe2.inputs.map((i) => i.itemId));
        for (const itemId of outs) {
          if (r2Inputs.has(itemId)) bucket.push({ to: r2, item: itemId });
        }
      }
      intraEdges.set(r1, bucket);
    }

    const intraSccs = tarjanScc(bin.recipeIds, intraEdges);
    const externalSet = new Set<ItemId>(
      bin.externalInputs.map((io) => io.itemId),
    );

    for (const scc of intraSccs) {
      // Size-1 SCC is only a cycle if it has a self-loop edge (recipe
      // consumes its own output). Tarjan emits the singleton either way;
      // the cycle-items collection below distinguishes the two cases:
      // a non-self-looped singleton has no edges back to itself, so
      // `cycleItems` ends up empty and we skip. A self-looped singleton
      // — rare in real data but defensively handled — produces cycle
      // items and is treated as an intra-bin cycle of size 1.
      const sccMembers = new Set(scc);
      const cycleItems = new Set<ItemId>();
      for (const r of scc) {
        for (const e of intraEdges.get(r) ?? []) {
          if (sccMembers.has(e.to)) cycleItems.add(e.item);
        }
      }
      if (cycleItems.size === 0) continue;

      const supplied = [...cycleItems].filter((id) => externalSet.has(id));
      if (supplied.length > 0) {
        // Cycle has external entry via the bin's port allocation; the
        // LP-routed supply bootstraps the cycle from that side without
        // needing a seed. (Per-CYCLE, not per-item — a single external
        // port is sufficient because flow from that port lets one
        // recipe in the SCC run, which produces the other cycle items
        // internally on the next cycle.)
        if (import.meta.env?.DEV) {
          console.log(
            `[PREFILL]   intra-bin ${bin.id} SCC=[${scc.join(", ")}] cycle=[${[...cycleItems].join(", ")}]: external entry via [${supplied.join(", ")}]; skip`,
          );
        }
        continue;
      }

      // No external entry — true intra-bin deadlock. Flag per recipe
      // (each recipe in the SCC carries the cycle items it consumes).
      if (import.meta.env?.DEV) {
        console.log(
          `[PREFILL]   intra-bin ${bin.id} SCC=[${scc.join(", ")}] cycle=[${[...cycleItems].join(", ")}]: no external entry; flagging`,
        );
      }
      for (const r of scc) {
        const recipe = recipeMap.get(r);
        if (!recipe) continue;
        const flagged = recipe.inputs
          .map((i) => i.itemId)
          .filter((id) => cycleItems.has(id));
        addToBinRecipe(bin.id, r, flagged, "intra-bin-scc");
      }
    }
  }

  // ============================================================
  // Phase 2: Inter-bin 2-cycles via recipe-graph SCC pair iteration.
  // ============================================================
  // The recipe-graph SCCs already exist (Tarjan run by graph-builder).
  // Iterate pairs (A, B) and check for a tight 2-cycle. For each
  // (binA hosting A, binB hosting B) where binA != binB, apply the
  // bootability filter (BOTH cycle items non-bootable → flag).
  // Same-bin pairs are skipped — Phase 1 covered them.
  //
  // 3+ recipe inter-bin cycles (T4) are NOT detected here. A defensive
  // log fires if a recipe-graph SCC of size ≥ 3 yields no 2-cycle pair
  // — we'd see it in DEV if game data ever triggers this topology.
  for (const scc of sccs) {
    const sccItemSet = new Set(scc.items);

    // Singleton SCC with a self-loop is a degenerate 1-recipe cycle:
    // the recipe consumes its own output. Flag only if the looped item
    // is non-bootable (no external producer reachable from raws).
    // Special-cased here because Phase 1 needs ≥ 2 recipes per bin.
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

    let twoCycleFound = false;
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
        twoCycleFound = true;

        if (import.meta.env?.DEV) {
          console.log(
            `[PREFILL]   2-cycle (${recipeIds[i]}, ${recipeIds[j]}): A->B=[${aToB.join(", ")}], B->A=[${bToA.join(", ")}]`,
          );
        }

        const allocA = recipeBinAllocations.get(recipeIds[i]);
        const allocB = recipeBinAllocations.get(recipeIds[j]);
        if (!allocA || !allocB) continue;

        // Inter-bin pairs only — intra-bin pairs are handled by Phase 1.
        for (const entryA of allocA.perBin) {
          for (const entryB of allocB.perBin) {
            if (entryA.binId === entryB.binId) continue;
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

    // Defensive T4 detector: SCC of size ≥ 3 with no 2-cycle. Currently
    // a documented limitation; no real-game data exhibits this. Log so
    // we'd notice in DEV if future game data ever triggers it. Phase 1
    // catches it IF the recipes happen to co-locate in one bin; if they
    // span multiple bins, the cycle goes undetected.
    if (
      import.meta.env?.DEV &&
      scc.recipes.size >= 3 &&
      !twoCycleFound
    ) {
      console.log(
        `[PREFILL] SCC ${scc.id} has ${scc.recipes.size} recipes but no 2-cycle pair; ` +
          `T4 (3+ recipe inter-bin cycle) limitation — chip not emitted. ` +
          `If real-data plan, revisit propagatePrefillCandidates.`,
      );
    }
  }

  // Derive per-bin union from the per-(bin, recipe) accumulator. Each
  // bin's prefillCandidates = sorted union over its member recipes'
  // per-bin prefill items, filtered to inputs that some recipe in the
  // bin actually consumes (defensive — both phases only flag consumed
  // items, but the filter keeps the contract honest if a future caller
  // passes mixed data).
  for (const bin of bins) {
    const merged = new Set<ItemId>();
    const inner = perBinRecipe.get(bin.id);
    if (inner) {
      const consumedInBin = new Set<ItemId>();
      for (const rid of bin.recipeIds) {
        const recipe = recipeMap.get(rid);
        if (!recipe) continue;
        for (const inp of recipe.inputs) consumedInBin.add(inp.itemId);
      }
      for (const rid of bin.recipeIds) {
        const set = inner.get(rid);
        if (!set) continue;
        for (const id of set) {
          if (consumedInBin.has(id)) merged.add(id);
        }
      }
    }
    bin.prefillCandidates = Array.from(merged).sort();
  }

  // Derive per-recipe union (across ALL hosting bins of the same
  // recipe id) for the merged-mapper (bf=0) chip. A recipe rendered
  // as a single per-recipe node in bf=0 should warn if ANY hosting
  // bin needs prefill (conservative). RecipeId stays branded throughout
  // — no string-parsing cast.
  const recipePrefill = new Map<RecipeId, Set<ItemId>>();
  for (const inner of perBinRecipe.values()) {
    for (const [recipeId, set] of inner.entries()) {
      let bucket = recipePrefill.get(recipeId);
      if (!bucket) {
        bucket = new Set<ItemId>();
        recipePrefill.set(recipeId, bucket);
      }
      for (const id of set) bucket.add(id);
    }
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
        graph.rawMaterials,
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
        graph.rawMaterials,
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
