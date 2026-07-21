import type {
  Item,
  Recipe,
  Facility,
  DomainId,
  FacilityId,
  ItemId,
  RecipeId,
  BinId,
  PowerFuel,
  PlanMetastorageImport,
  ProductionNode,
  DetectedCycle,
  InvalidCycleInfo,
  PlanLpStatus,
  PlanWarning,
  CatalystUpkeep,
  ProductionDependencyGraph,
  ProductionGraphNode,
  Bin,
  RecipeBinAllocation,
} from "@/types";
import type { MetastorageRouteConfig } from "@/types/metastorage";
import { producibleRaws } from "@/data";
import { calcRate } from "@/lib/utils";
import { DEFAULT_MACHINES_PER_VAPORIZER } from "@/lib/sustain-constants";
import {
  facilitySustainDrains,
  vaporizerEnvs,
  type SustainDrain,
} from "@/data/gas-sustain";
import {
  aggregateBinTotals,
  computeLimitViolations,
  placedBuildings,
} from "@/lib/plan-helpers";
import { computeRecipeReachability } from "@/lib/recipe-reachability";
import { computeVariantExclusions } from "@/lib/variant-filter";
import { buildBipartiteGraph, detectSCCs } from "./graph-builder";
import { calculateFlows } from "./flow-solver";
import type { LPMetastorageImport } from "./lp-solver";
import { packBins } from "./multi-formula-packing";
import type {
  ProductionMaps,
  BipartiteGraph,
  SCCInfo,
  FlowData,
  FlowSolveMetrics,
  InvalidSCCInfo,
} from "./calculator-types";

/**
 * Compute the set of items reachable from raw materials via the active
 * recipe set (those with a positive slot allocation in the LP solution).
 *
 * Thin wrapper around `computeRecipeReachability` in
 * `src/lib/recipe-reachability.ts`. The underlying fixpoint is shared
 * with the App-layer `availableRecipes` derivation; centralising the
 * algorithm in one place avoids drift between prefill detection and
 * picker filtering.
 *
 * Used by `propagatePrefillCandidates` to filter 2-cycle items: a cycle
 * has an external entry whenever at least one of its items is reachable
 * from raws — the cycle bootstraps from that side without prefill, no
 * matter where the LP routed the actual flow.
 *
 * **Important**: `rawMaterials` MUST be the plan's runtime raw set
 * (typically `graph.rawMaterials`, the union of the per-region raw set,
 * user-supplied `manualRawMaterials`, and any LP-extended SCC feeder
 * raws). Passing the per-region set alone misses user-marked manual
 * raws and produces false-positive prefill chips.
 *
 * **Anti-pattern**: do not iterate over ALL recipes in `recipeMap`;
 * recipes the LP didn't pick aren't actually running and don't contribute
 * to bootability for THIS plan. Use `activeRecipeIds` (drawn from
 * `recipeBinAllocations.keys()`).
 *
 * **Two reachability policies coexist** (see `computeRecipeReachability`'s
 * Usage section for the full framing):
 *   - **Planning layer** (App.tsx): bootstrap-aware. "Can the user
 *     configure this plan?"
 *   - **Runtime layer** (this function): bootstrap-omitted, strict
 *     chain-only. "Does this cycle need a kickstart at startup?"
 * Don't conflate them.
 */
function computeBootableItems(
  activeRecipeIds: Iterable<RecipeId>,
  recipeMap: Map<RecipeId, Recipe>,
  rawMaterials: ReadonlySet<ItemId>,
): Set<ItemId> {
  const activeRecipes: Recipe[] = [];
  for (const rid of activeRecipeIds) {
    const recipe = recipeMap.get(rid);
    if (recipe) activeRecipes.push(recipe);
  }
  const { reachableItems } = computeRecipeReachability(
    activeRecipes,
    rawMaterials,
  );
  // Materialise into a mutable Set for downstream consumers that may
  // augment it (the existing API contract).
  return new Set(reachableItems);
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
 * the per-region raw set + `manualRawMaterials` + any LP-extended
 * feeder raws). This is the single source of truth for "what counts as
 * raw in THIS plan", and the bootability fixpoint reads it directly —
 * no global raw-set import. Tests pass whatever raw set matches the
 * synthetic scenario (typically `new Set<ItemId>()` when the fixture's
 * items aren't game-data raws).
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
  warnings: PlanWarning[] = [],
  recipePrefill: Map<RecipeId, ItemId[]> = new Map(),
  metastorageImports: PlanMetastorageImport[] = [],
  lpStatus: PlanLpStatus = "ok",
  powerGenerationByRecipe?: ReadonlyMap<RecipeId, number>,
  envByVaporizeRecipe?: ReadonlyMap<RecipeId, number>,
  catalystByRecipe?: ReadonlyMap<RecipeId, CatalystUpkeep>,
): ProductionDependencyGraph {
  const nodes = new Map<string, ProductionGraphNode>();
  const edges: Array<{ from: string; to: string }> = [];

  // Compute the **active subgraph**: recipes the LP picked + items those
  // recipes touch + targets + raws. The multi-recipe graph contains every
  // alternative producer for each reachable item; the LP picks one (or a
  // mix), giving inactive alternatives facility count = 0. Rendering must
  // only include the active subset, else isolated zero-throughput recipe
  // nodes appear in mappers (and trip `assertFlowIntegrity` in tests).
  const activeRecipeIds = new Set<RecipeId>();
  for (const [recipeId, fc] of flowData.recipeFacilityCounts.entries()) {
    if (fc > 0) activeRecipeIds.add(recipeId);
  }
  const activeItemIds = new Set<ItemId>();
  graph.targets.forEach((id) => activeItemIds.add(id));
  graph.rawMaterials.forEach((id) => activeItemIds.add(id));
  activeRecipeIds.forEach((recipeId) => {
    graph.recipeInputs.get(recipeId)?.forEach((id) => activeItemIds.add(id));
    graph.recipeOutputs.get(recipeId)?.forEach((id) => activeItemIds.add(id));
  });

  // Recipe-produced rate of an item = Σ (output rate × fc) over active
  // producers. Used by non-raw items and by producible raws (which also
  // have producers). For a producible raw's self-feeding producer (the
  // catalyst-folded transmuter that outputs Xiragen AND consumes it as a
  // catalyst) this is the GROSS output — the catalyst draw is a separate
  // consumption edge, netted on the LP balance row, not here.
  const recipeProductionOf = (itemId: ItemId): number => {
    let sum = 0;
    graph.recipeOutputs.forEach((outputItems, recipeId) => {
      if (!activeRecipeIds.has(recipeId)) return;
      if (!outputItems.has(itemId)) return;
      const recipe = maps.recipeMap.get(recipeId)!;
      const facilityCount = flowData.recipeFacilityCounts.get(recipeId) || 0;
      const output = recipe.outputs.find((o) => o.itemId === itemId);
      if (output) {
        sum += calcRate(output.amount, recipe.craftingTime) * facilityCount;
      }
    });
    return sum;
  };

  graph.itemNodes.forEach((itemNode, itemId) => {
    if (!activeItemIds.has(itemId)) return;

    const isProducibleRaw =
      itemNode.isRawMaterial && graph.producibleRaws.has(itemId);

    let productionRate: number;
    let rawSupplyRate: number | undefined;

    if (isProducibleRaw) {
      // Hybrid supply: the capped vent/mine draw (LP `rawsupply_*` value)
      // PLUS the crafted portion. `productionRate` is the TOTAL supply so
      // the display shows all of it; `rawSupplyRate` isolates the vent
      // draw so pickup-pump sizing + `raw-over-cap` judge only the mined
      // portion (see `plan-helpers.ts`).
      rawSupplyRate = flowData.rawSupplyRates.get(itemId) ?? 0;
      productionRate = rawSupplyRate + recipeProductionOf(itemId);
    } else if (itemNode.isRawMaterial) {
      productionRate = flowData.itemDemands.get(itemId) || 0;
    } else {
      productionRate = recipeProductionOf(itemId);
    }

    nodes.set(itemId, {
      type: "item",
      itemId,
      item: itemNode.item,
      productionRate,
      isRawMaterial: itemNode.isRawMaterial,
      isTarget: graph.targets.has(itemId),
      ...(rawSupplyRate !== undefined ? { rawSupplyRate } : {}),
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
    // `activeRecipeIds` already includes disposal recipes: they're now
    // injected pre-LP by `buildBipartiteGraph` and sized by the LP
    // itself, so any disposal recipe with positive surplus has
    // `fc > 0` here. Inactive non-disposal alternatives (e.g. tier-2
    // pool variants the LP didn't pick) are filtered out by the
    // `fc > 0` gate above.
    if (!activeRecipeIds.has(recipeId)) return;

    const isDisposal = recipeData.recipe.outputs.length === 0;
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
      isDisposal,
      // Thermal Bank burn recipes: watts provided per facility.
      // Undefined for every other recipe. Power sinks are also
      // `isDisposal` (zero outputs) — consumers check this first.
      powerGeneration: powerGenerationByRecipe?.get(recipeId),
      // Vaporizer env recipes (1.4): the env id they supply. Undefined
      // for every other recipe. Env sinks are also `isDisposal` (zero
      // outputs) — consumers check this BEFORE powerGeneration.
      envSupport: envByVaporizeRecipe?.get(recipeId),
      // Catalyst contract (1.4 transmuters): the authoritative
      // ingredient/upkeep decomposition of the folded catalyst intake.
      // Undefined for every non-drain recipe.
      catalyst: catalystByRecipe?.get(recipeId),
      binId,
      binSisterRecipeIds: sisters,
      prefillCandidates: recipePrefill.get(recipeId) ?? [],
    });
  });

  graph.itemConsumedBy.forEach((recipeIds, itemId) => {
    if (!activeItemIds.has(itemId)) return;
    recipeIds.forEach((recipeId) => {
      if (!nodes.has(recipeId)) return;
      edges.push({ from: itemId, to: recipeId });
    });
  });

  graph.recipeOutputs.forEach((itemIds, recipeId) => {
    if (!nodes.has(recipeId)) return;
    itemIds.forEach((itemId) => {
      if (!activeItemIds.has(itemId)) return;
      edges.push({ from: recipeId, to: itemId });
    });
  });

  // Every detected SCC stays cyclic in graph structure (no DAG-linearisation
  // step exists), so all SCCs render as cycles with backward-edge styling.
  //
  // Filter cycle members to **active** recipes only: an SCC's recipe set
  // includes every alternative producer added by the multi-recipe
  // traversal (e.g. both plant_moss and plant_grass producers when only
  // grass was picked by the LP). Inactive alternatives don't run, so
  // they shouldn't appear in cycleNodes. Iterating them would also call
  // resolveBinInfo on recipes the packer correctly didn't allocate,
  // firing spurious `[resolveBinInfo] ... has no bin allocation`
  // warnings.
  const detectedCycles: DetectedCycle[] = sccs.map((scc) => {
    const cycleNodes: ProductionNode[] = Array.from(scc.recipes)
      .filter((recipeId) => activeRecipeIds.has(recipeId))
      .flatMap((recipeId) => {
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
    lpStatus,
    bins,
    recipeBinAllocations,
    warnings,
    metastorageImports,
  };
}



// ── Metastorage auto-selection ──────────────────────────────────────────────

/**
 * Comparison tolerances for ranking Metastorage candidate solves.
 * Mirror the LP's own `LEX_TOLERANCE` scale: differences at or below
 * the tolerance are ties (move to the next key), keeping the winner
 * deterministic against HiGHS float jitter across separate solves.
 */
const METASTORAGE_METRIC_TOLERANCE = {
  slackMagnitude: 1e-6,
  // Building-scale: 0.5 (half a placement) — the value is an integer
  // count of over-cap physical buildings, so 0.5 cleanly separates 0
  // from 1 while absorbing float noise.
  facilityPlacementOveruse: 0.5,
  // Watt-scale: 0.5 W (the warning-threshold family) — a sub-watt
  // residual shortfall must never outbid a real cost difference.
  powerShortfall: 0.5,
  totalRawCost: 1e-6,
  totalBuildingCount: 1e-3,
  totalPower: 1e-3,
  totalTtvUsedPerMinute: 1e-6,
} as const;

/**
 * Lexicographic comparison of two candidate solves. Negative ⇒ `a` is
 * strictly better. Order: feasibility → total slack (soft-constraint
 * violations) → facility placement over-cap (unbuildable hard limit) →
 * power-sustain shortfall → the LP's own lex objectives → TTV used
 * (prefer the cheaper-TTV candidate among otherwise-equal plans).
 *
 * `facilityPlacementOveruse` ranks right after `slackMagnitude` because a
 * building over a facility cap is UNBUILDABLE — the selection must never
 * pick an import that fragments a capped single-formula facility over its
 * cap (a cheaper-raw candidate that ceils a 0.42-building sliver into a
 * 13th Forge) when a fitting choice exists. Enabling Metastorage can then
 * only ever add supply options, never worsen the plan's cap verdict.
 *
 * `powerShortfall` is a SEPARATE key, not part of `slackMagnitude`:
 * watts and items/min are incommensurable, and folding them once let
 * a candidate trade a 50 ore/min cap violation for a token 367 W of
 * generation (user-reported: toggling power flipped the Valley IV
 * route from originium powder to battery_3 and pushed a maxed ore cap
 * from 540 to 590). The key order re-states the LP's own penalty
 * lattice across solves: cap violations (`slackMagnitude`, tier 1e6)
 * strictly dominate power coverage (tier 1e2), which strictly
 * dominates real costs — so the selection layer can never disagree
 * with the solve layer about a candidate.
 */
function compareSolveMetrics(
  a: FlowSolveMetrics,
  b: FlowSolveMetrics,
): number {
  if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
  const keys = [
    "slackMagnitude",
    // A facility placement over-cap is an UNBUILDABLE hard limit — it
    // outranks everything below (an import that tips a capped
    // single-formula facility over its cap via fragmentation must lose
    // to any fitting choice, including no-import).
    "facilityPlacementOveruse",
    "powerShortfall",
    "totalRawCost",
    "totalBuildingCount",
    "totalPower",
    "totalTtvUsedPerMinute",
  ] as const;
  for (const key of keys) {
    const diff = a[key] - b[key];
    if (Math.abs(diff) > METASTORAGE_METRIC_TOLERANCE[key]) return diff;
  }
  return 0;
}

/**
 * Candidate items for one route: eligible exports that exist in the
 * graph as **balanced** items (not raws / manual raws) and are either
 * targeted or consumed by at least one recipe in the graph — importing
 * anything else can't improve the plan. Sorted by item id so the
 * enumeration (and tie-breaking, which keeps the first winner) is
 * deterministic.
 */
function metastorageCandidates(
  route: MetastorageRouteConfig,
  graph: BipartiteGraph,
  targetRates: Map<ItemId, number>,
  manualRawMaterials?: Set<ItemId>,
): ItemId[] {
  const out: ItemId[] = [];
  for (const itemId of route.itemCosts.keys()) {
    const node = graph.itemNodes.get(itemId);
    if (!node || node.isRawMaterial) continue;
    if (manualRawMaterials?.has(itemId)) continue;
    const consumed = (graph.itemConsumedBy.get(itemId)?.size ?? 0) > 0;
    if (!consumed && !targetRates.has(itemId)) continue;
    out.push(itemId);
  }
  return out.sort();
}

/**
 * Items that can ONLY arrive via Metastorage and are **necessarily**
 * demanded by the plan: no surviving producer recipe, not a raw, but
 * import-eligible on ≥1 route, AND provably required (not avoidable via
 * an alternative recipe).
 *
 * Necessity is a fixpoint from the targets: a target with rate > 0 is
 * necessary; an item is necessary if it is consumed by **every**
 * surviving producer of some already-necessary item (the intersection
 * of producer inputs — if even one producer avoids it, the LP can too).
 * This is a sound under-approximation: every item returned is genuinely
 * unavoidable, so there are no false-positive conflicts. Covers both
 * import-only targets AND import-only intermediates (which the old
 * target-only check missed).
 */
function necessaryImportOnlyItems(
  routes: readonly MetastorageRouteConfig[],
  graph: BipartiteGraph,
  targetRates: Map<ItemId, number>,
): ItemId[] {
  // Invert recipeOutputs → producers per item (active graph recipes).
  const producersByItem = new Map<ItemId, RecipeId[]>();
  for (const [recipeId, outputs] of graph.recipeOutputs) {
    for (const itemId of outputs) {
      const arr = producersByItem.get(itemId) ?? [];
      arr.push(recipeId);
      producersByItem.set(itemId, arr);
    }
  }

  const necessary = new Set<ItemId>();
  const queue: ItemId[] = [];
  for (const [itemId, rate] of targetRates) {
    if (rate > 0 && graph.itemNodes.has(itemId)) {
      necessary.add(itemId);
      queue.push(itemId);
    }
  }
  while (queue.length > 0) {
    const item = queue.pop()!;
    const producers = producersByItem.get(item) ?? [];
    if (producers.length === 0) continue; // leaf (raw / import-only)
    // Inputs common to ALL producers are unavoidable for this item.
    let common: Set<ItemId> | null = null;
    for (const recipeId of producers) {
      const inputs = graph.recipeInputs.get(recipeId) ?? new Set<ItemId>();
      if (common === null) {
        common = new Set(inputs);
      } else {
        for (const x of [...common]) if (!inputs.has(x)) common.delete(x);
      }
    }
    for (const input of common ?? []) {
      if (!necessary.has(input)) {
        necessary.add(input);
        queue.push(input);
      }
    }
  }

  const eligible = new Set<ItemId>();
  for (const r of routes) for (const it of r.itemCosts.keys()) eligible.add(it);

  const out: ItemId[] = [];
  for (const itemId of necessary) {
    const node = graph.itemNodes.get(itemId);
    if (!node || node.isRawMaterial) continue;
    if ((producersByItem.get(itemId)?.length ?? 0) > 0) continue;
    if (!eligible.has(itemId)) continue;
    out.push(itemId);
  }
  return out.sort();
}

/**
 * Can every item in `items` be assigned to a DISTINCT route that
 * exports it? Each source region carries one item type per delivery
 * (`routeNum: 1`), so this is a bipartite matching: items ↔ routes,
 * edge iff the route's `itemCosts` includes the item. Returns false
 * when no matching covers all items — i.e. the import-only demands
 * structurally can't be satisfied simultaneously. Kuhn's algorithm;
 * sets are tiny (≤ handful of items / routes).
 */
function canRoutesCoverItems(
  items: readonly ItemId[],
  routes: readonly MetastorageRouteConfig[],
): boolean {
  const adj = items.map((itemId) =>
    routes.flatMap((r, ri) => (r.itemCosts.has(itemId) ? [ri] : [])),
  );
  const routeToItem = new Array<number>(routes.length).fill(-1);
  const augment = (u: number, seen: boolean[]): boolean => {
    for (const v of adj[u]) {
      if (seen[v]) continue;
      seen[v] = true;
      if (routeToItem[v] === -1 || augment(routeToItem[v], seen)) {
        routeToItem[v] = u;
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (let u = 0; u < items.length; u++) {
    if (augment(u, new Array<boolean>(routes.length).fill(false))) matched++;
  }
  return matched === items.length;
}

type FlowSolveResult = Awaited<ReturnType<typeof calculateFlows>>;

/**
 * Ceil-floor loop bounds (self-sustaining power + 1.4 gas sustain). The
 * loop converges interleaved whole-building figures — the power
 * generation floor and the vaporizer min-runs (both monotone-growing;
 * the tightened facility caps only ever shrink) — so iterations beyond
 * the first two are rare; the cap is a hard stop for pathological
 * ceiling cascades. `POWER_FLOOR_TOLERANCE` absorbs LP/aggregation
 * float noise well below the smallest real power draw in the data
 * (5 W).
 */
const MAX_POWER_FLOOR_ITERATIONS = 8;
const POWER_FLOOR_TOLERANCE = 0.25;

/**
 * A candidate the enumeration rejected because its solve needed more
 * TTV than the route's budget. Thanks to the `TTV_SLACK_PENALTY`
 * ordering in the LP this only happens when NO within-budget solution
 * exists for that demand (import-only demand above budget), so the
 * diagnostic carries exactly the figures the user needs: which item,
 * how much it would need, and the route's cap.
 */
type MetastorageBudgetDiagnostic = {
  sourceDomain: DomainId;
  itemId: ItemId;
  /** TTV/min the demand actually requires (budget + overage). */
  ttvNeededPerMinute: number;
  ttvBudgetPerMinute: number;
  cycleSeconds: number;
};

/**
 * Auto-select the single transferred item per Metastorage route.
 *
 * Sequential greedy over routes (current data has exactly one
 * exporting region): for each route, solve the global LP once per
 * candidate item — plus the implicit "route unused" baseline carried
 * over from the previous step — and keep the lex-best result
 * (`compareSolveMetrics`). Strict improvement is required to displace
 * the baseline, so a route whose best candidate ties the no-import
 * solve stays unused (the LP's final `ttvCost` pass already zeroes
 * useless imports within a solve; this mirrors it across solves).
 *
 * **Viability gate**: candidates whose solve carries any TTV-budget
 * overage are never selected — an over-budget plan is physically
 * unrealizable (the budget is a game constant), so "feasible with
 * overage" must not outrank "infeasible". Rejected candidates are kept
 * as `diagnostics` (lowest overage per route) so the caller can emit a
 * `metastorage-budget-insufficient` warning explaining exactly why no
 * plan was produced.
 *
 * Candidate sets are small in practice (eligible ∩ graph-relevant,
 * typically well under a dozen), and each solve is a small LP, so the
 * enumeration stays interactive.
 */
async function selectMetastorageImports(
  routes: readonly MetastorageRouteConfig[],
  graph: BipartiteGraph,
  sccs: SCCInfo[],
  targetRates: Map<ItemId, number>,
  maps: ProductionMaps,
  manualRawMaterials?: Set<ItemId>,
  rawCaps?: ReadonlyMap<ItemId, number>,
  facilityCaps?: ReadonlyMap<FacilityId, number>,
  powerGenerationByRecipe?: ReadonlyMap<RecipeId, number>,
  sustainLP?: Parameters<typeof calculateFlows>[9],
): Promise<{
  selected: LPMetastorageImport[];
  result: FlowSolveResult;
  diagnostics: MetastorageBudgetDiagnostic[];
}> {
  const solve = (imports: readonly LPMetastorageImport[]) =>
    calculateFlows(
      graph,
      sccs,
      targetRates,
      maps,
      manualRawMaterials,
      rawCaps,
      facilityCaps,
      imports,
      powerGenerationByRecipe
        ? { generationByRecipe: powerGenerationByRecipe }
        : undefined,
      sustainLP,
    );

  let selected: LPMetastorageImport[] = [];
  let best = await solve(selected);
  const diagnostics: MetastorageBudgetDiagnostic[] = [];

  // DEV-only enumeration cost telemetry. Each candidate triggers one
  // full lexicographic solve; measured overhead is ~130ms on a heavy
  // 5-target / 17-candidate plan (HiGHS solves ≈2ms each on these
  // graphs), comfortably under the hook's 300ms loading-overlay
  // debounce — so no screening/short-circuit is warranted at current
  // scale. This log surfaces the cost if a future multi-route or wider
  // candidate set pushes it past that budget.
  const enumStart = import.meta.env?.DEV ? performance.now() : 0;
  let candidatesEvaluated = 0;

  for (const route of routes) {
    const candidates = metastorageCandidates(
      route,
      graph,
      targetRates,
      manualRawMaterials,
    );
    if (candidates.length === 0) continue;
    candidatesEvaluated += candidates.length;
    if (import.meta.env?.DEV) {
      console.log(
        `[METASTORAGE] route ${route.sourceDomain}: evaluating ${candidates.length} candidate item(s)`,
      );
    }
    let bestImport: LPMetastorageImport | null = null;
    let routeDiagnostic: MetastorageBudgetDiagnostic | null = null;
    for (const itemId of candidates) {
      const candidate: LPMetastorageImport = {
        sourceDomain: route.sourceDomain,
        itemId,
        ttvCostPerItem: route.itemCosts.get(itemId)!,
        ttvBudgetPerMinute: route.ttvBudgetPerMinute,
      };
      const result = await solve([...selected, candidate]);
      // Viability gate: any TTV-budget overage disqualifies the
      // candidate outright (physically unrealizable). Keep the
      // closest-to-possible rejection per route as the diagnostic.
      if (
        result.metrics.ttvOverusePerMinute >
        METASTORAGE_METRIC_TOLERANCE.totalTtvUsedPerMinute
      ) {
        const needed =
          route.ttvBudgetPerMinute + result.metrics.ttvOverusePerMinute;
        if (
          result.metrics.feasible &&
          (!routeDiagnostic || needed < routeDiagnostic.ttvNeededPerMinute)
        ) {
          routeDiagnostic = {
            sourceDomain: route.sourceDomain,
            itemId,
            ttvNeededPerMinute: needed,
            ttvBudgetPerMinute: route.ttvBudgetPerMinute,
            cycleSeconds: route.cycleSeconds,
          };
        }
        continue;
      }
      if (compareSolveMetrics(result.metrics, best.metrics) < 0) {
        best = result;
        bestImport = candidate;
      }
    }
    if (bestImport) {
      selected = [...selected, bestImport];
      if (import.meta.env?.DEV) {
        console.log(
          `[METASTORAGE] route ${bestImport.sourceDomain}: selected ${bestImport.itemId}`,
        );
      }
    } else if (routeDiagnostic) {
      diagnostics.push(routeDiagnostic);
      if (import.meta.env?.DEV) {
        console.warn(
          `[METASTORAGE] route ${routeDiagnostic.sourceDomain}: no within-budget candidate; ${routeDiagnostic.itemId} would need ${routeDiagnostic.ttvNeededPerMinute.toFixed(2)} TTV/min vs budget ${routeDiagnostic.ttvBudgetPerMinute.toFixed(2)}`,
        );
      }
    }
  }

  if (import.meta.env?.DEV && candidatesEvaluated > 0) {
    console.log(
      `[METASTORAGE] enumeration: ${candidatesEvaluated} candidate solve(s) in ${(
        performance.now() - enumStart
      ).toFixed(0)}ms → ${selected.length} import(s) selected`,
    );
  }

  return { selected, result: best, diagnostics };
}

/**
 * Options bag for `calculateProductionPlan`. Keeps the function signature
 * stable as new optional concerns are added (e.g. `facilityCaps` in
 * Step 2 of the AIC Plan feature).
 *
 * - `rawMaterials`: items the calc treats as having no producer
 *   (infinite supply for LP). REQUIRED. App.tsx passes the per-
 *   `currentDomain` set from `rawAvailabilityByDomain`; tests pass
 *   whatever raw set matches their synthetic recipe shape.
 * - `rawCaps`: per-(raw item) upper bound on aggregate consumption rate
 *   in items/min. Optional. **Absence of a key = no limit** for that
 *   item (LP treats it as infinite-supply, the existing rawMaterials
 *   behaviour). When provided per-key, the LP adds a soft constraint
 *   `Σ consumption ≤ cap + slack` with slack penalized by
 *   `SLACK_PENALTY`. The LP biases toward recipes that conserve the
 *   capped raw; when no combination respects the cap, slack absorbs
 *   the overage. Residual overage is surfaced post-pack via
 *   `computeRawOverCapWarnings` (mirrors `facility-over-cap`).
 * - `recipeOverrides`: user's per-item recipe choice (e.g. picking
 *   `pool_xiranite_poly_2` over `pool_xiranite_poly_1`). Item id → recipe id.
 * - `manualRawMaterials`: items the user explicitly pinned as raw
 *   (short-circuits a producer chain).
 * - `facilityCaps`: aggregated per-facility placement caps across active
 *   domains (cap = Σ active-domains × per-(facility, domain) cap).
 *   When provided, the Phase 5 MIP gets `Σ x_v ≤ N_F` constraints; when
 *   the cap is infeasible the packer retries without it and emits a
 *   warning into `plan.warnings` rather than failing.
 * - `metastorageRoutes`: resolved Metastorage import routes feeding the
 *   planned region (App bridge: source has capability, is active, and
 *   its route mode is `auto` or locked to this region). The calculator
 *   auto-selects each route's single transferred item via candidate
 *   enumeration (`selectMetastorageImports`); the winning imports land
 *   on `plan.metastorageImports`; routes whose demand cannot fit the
 *   budget select nothing and emit `metastorage-budget-insufficient`
 *   warnings instead (the budget is a hard game constant); items whose
 *   only supply is an import stay balance-constrained instead of
 *   degrading to raws.
 * - `powerSustain`: self-sustaining-power mode (Thermal Bank battery
 *   burning). Each fuel's zero-output burn recipe is injected into the
 *   graph (with the fuel's production chain pulled in via backward
 *   traversal) and the LP gains a HARD power-balance row: generation
 *   must cover consumption incl. pump power — solving the circular
 *   "batteries need buildings that need power" fixed point in one
 *   solve. A post-pack ceil-floor loop then raises generation to the
 *   WHOLE-BUILDING consumption (`aggregateBinTotals` ceilMode figure)
 *   via `LPPowerBalance.minGeneration`, iterating to the discrete
 *   fixed point — players build whole buildings, so batteries are
 *   sized for what the build actually draws. Targeted batteries are
 *   never consumed for power (target constraints are `min: rate` on
 *   NET production). Fuels that aren't producible / raw / importable
 *   are skipped; if none survive, the plan carries a
 *   `power-sustain-unavailable` warning and no balance row is added.
 *   App callers pass `powerFuels` from `@/data`; tests may pass
 *   synthetic fuels.
 */
/** One vaporizer env entry (shape of `vaporizerEnvs` values). */
export interface VaporizerEnvConfig {
  gasItemId: ItemId;
  /** Gas burned per minute per always-on vaporizer. */
  ratePerMinute: number;
  /** Synthetic zero-output `vaporize_*` recipe (craftingTime 60 s). */
  recipe: Recipe;
}

/**
 * Book-keeping for one catalyst-folded recipe clone (1.4 transmuters).
 *
 * The transmuter catalyst (`facilitySustainDrains`) is a fuel: one
 * unit buys `60 / ratePerMinute` seconds of working time, so a
 * facility running at 100% duty consumes exactly `ratePerMinute`
 * (verified in-game 1.4 — an under-supplied transmuter duty-cycles
 * instead of deactivating). The calculator charges it proportionally
 * to load as an extra input on every recipe of the facility:
 *
 *   catalystPerCraft = ratePerMinute × craftingTime / 60
 *
 * so recipe `r` consumes `ratePerMinute × fc_r` (fc_r = the recipe's
 * fractional LP facility count). The activation port itself consumes
 * eagerly (whatever arrives, wasted while idle); the proportional
 * charge assumes the intake is throttled to the duty rate with a Pipe
 * Control Port — the same optimal-play assumption as the unmodeled
 * `consumeRateUpperLimit` over-supply clamp.
 */
interface FoldedCatalystRecipe {
  /** The cloned recipe object registered in the plan's recipeMap. */
  recipe: Recipe;
  catalystItemId: ItemId;
  /** Catalyst units folded per craft (`rate × craftingTime / 60`). */
  basePerCraft: number;
  /** Original (game-data) amount of the catalyst on this input, if any. */
  originalInputAmount: number;
}

/**
 * Clone every recipe whose facility carries a sustain drain, folding the
 * catalyst in as an extra input proportional to load. Non-drain recipes
 * pass through unchanged. Gross semantics on purpose: a transmuter recipe that also
 * OUTPUTS the catalyst item (e.g. gas→liquid xiranite on transmuter_1)
 * keeps its full output and gains the input — physically truthful (the
 * catalyst enters via dedicated intake ports) and it surfaces the real
 * self-feed cycle to SCC/prefill detection.
 */
function applyCatalystFolding(
  recipes: readonly Recipe[],
  drains: ReadonlyMap<FacilityId, SustainDrain>,
): { recipes: Recipe[]; folded: FoldedCatalystRecipe[] } {
  if (drains.size === 0) return { recipes: [...recipes], folded: [] };
  const out: Recipe[] = [];
  const folded: FoldedCatalystRecipe[] = [];
  for (const recipe of recipes) {
    const drain = drains.get(recipe.facilityId);
    if (!drain || !(drain.ratePerMinute > 0) || !(recipe.craftingTime > 0)) {
      out.push(recipe);
      continue;
    }
    const basePerCraft = (drain.ratePerMinute * recipe.craftingTime) / 60;
    const inputs = recipe.inputs.map((i) => ({ ...i }));
    const catalystInput = inputs.find((i) => i.itemId === drain.itemId);
    const originalInputAmount = catalystInput?.amount ?? 0;
    if (catalystInput) {
      catalystInput.amount = originalInputAmount + basePerCraft;
    } else {
      inputs.push({ itemId: drain.itemId, amount: basePerCraft });
    }
    const clone: Recipe = {
      ...recipe,
      inputs,
      outputs: recipe.outputs.map((o) => ({ ...o })),
    };
    out.push(clone);
    folded.push({
      recipe: clone,
      catalystItemId: drain.itemId,
      basePerCraft,
      originalInputAmount,
    });
  }
  return { recipes: out, folded };
}

export interface CalculateProductionPlanOptions {
  rawMaterials: ReadonlySet<ItemId>;
  rawCaps?: ReadonlyMap<ItemId, number>;
  recipeOverrides?: Map<ItemId, RecipeId>;
  manualRawMaterials?: Set<ItemId>;
  facilityCaps?: ReadonlyMap<FacilityId, number>;
  metastorageRoutes?: readonly MetastorageRouteConfig[];
  powerSustain?: { fuels: readonly PowerFuel[] };
  /**
   * 1.4 gas-sustain overrides. ALWAYS ACTIVE by default (unlike
   * `powerSustain`, these are hard game facts, not an opt-in mode):
   * `drains` defaults to `facilitySustainDrains` and `vaporizerEnvs` to
   * the generated data module. Tests may inject synthetic tables or
   * empty maps to disable. `machinesPerVaporizer` tunes the env
   * coverage ratio (default `DEFAULT_MACHINES_PER_VAPORIZER`).
   *
   * Two mechanics (see `.claude/rules/solver.md` + `gas-sustain.ts`):
   * - **Transmuter catalyst**: a fuel (1 unit = `60 / rate` seconds of
   *   working time) folded into every transmuter recipe as an extra
   *   input proportional to load — recipe `r` consumes `rate × fc_r`,
   *   assuming the eager activation port is throttled to the duty rate
   *   (see `FoldedCatalystRecipe`).
   * - **Vaporizer envs**: env-gated recipes (`Recipe.gasEnv`) pull the
   *   env's `vaporize_*` recipe into the graph; the sustain loop forces
   *   its facility count to `ceil(env machines / machinesPerVaporizer)`
   *   via `LPInput.recipeMinRates` (always-on 6 gas/min per vaporizer).
   */
  gasSustain?: {
    drains?: ReadonlyMap<FacilityId, SustainDrain>;
    vaporizerEnvs?: ReadonlyMap<number, VaporizerEnvConfig>;
    machinesPerVaporizer?: number;
  };
  /**
   * Raws that may ALSO be crafted by a recipe (Xiragen et al.). Defaults
   * to `@/data`'s `producibleRaws` (every non-costless raw). Such a raw,
   * where it has an active producer, gets a balance row + a capped
   * vent/mine-supply LP variable instead of infinite-leaf treatment, so
   * the LP mines the vent up to its cap and crafts only the overflow (see
   * `.claude/rules/solver.md`). Tests may pass an empty set to restore
   * the pre-1.4 "every raw is an infinite leaf" behaviour — e.g. to keep
   * a deliberately-deadlocked pinned cycle from gaining a craft escape.
   */
  producibleRaws?: ReadonlySet<ItemId>;
}

export async function calculateProductionPlan(
  targets: Array<{ itemId: ItemId; rate: number }>,
  items: readonly Item[],
  recipes: readonly Recipe[],
  facilities: readonly Facility[],
  options: CalculateProductionPlanOptions,
): Promise<ProductionDependencyGraph> {
  if (targets.length === 0) throw new Error("No targets specified");

  const rawMaterials = options.rawMaterials;
  const rawCaps = options.rawCaps;
  const recipeOverrides = options.recipeOverrides;
  const manualRawMaterials = options.manualRawMaterials;
  const facilityCaps = options.facilityCaps;
  const metastorageRoutes = options.metastorageRoutes ?? [];
  const powerFuels = options.powerSustain?.fuels ?? [];
  // Gas sustain (1.4) — active by default; see the option's JSDoc.
  const sustainDrains = options.gasSustain?.drains ?? facilitySustainDrains;
  const envConfigs = options.gasSustain?.vaporizerEnvs ?? vaporizerEnvs;
  const machinesPerVaporizer = Math.max(
    1,
    options.gasSustain?.machinesPerVaporizer ?? DEFAULT_MACHINES_PER_VAPORIZER,
  );

  // Drop opt-in variant recipes whose facility has no positive cap.
  // Variant recipes (today: `LIQUID_CLEAN_GATE_1_{DISPOSAL,BYPRODUCT}`)
  // are gated by the Settings "Structures" tab: enabling a structure
  // sets `facilityCaps[facilityId] = N > 0`. Without an explicit cap,
  // the variants must be invisible to the LP so they can't sneak in
  // through target-rooted traversal (Sewage Inlet's BYPRODUCT variant
  // produces `xiranite_poly`, which is reachable from many targets).
  //
  // `cap-zero-only` is the defensive backstop for direct callers
  // (tests, future programmatic entry points). The App layer
  // (`src/App.tsx`) applies the full `structure-aware` rule with the
  // user's resolved Settings state before the calculator runs; by the
  // time we get here through the App flow, the inactive variant is
  // already absent from `recipes`. When both variants survive (e.g.
  // a test that passes the full recipe set with `facilityCaps.LCG1 >
  // 0`), the LP's lex objective (rawCost → buildingCount → power)
  // selects the cheaper variant on its own. See
  // `src/lib/variant-filter.ts` for the rule.
  const optInVariantRecipeIds = computeVariantExclusions({
    mode: "cap-zero-only",
    facilityCaps,
  });
  const filteredRecipes =
    optInVariantRecipeIds.size === 0
      ? recipes
      : recipes.filter((r) => !optInVariantRecipeIds.has(r.id));

  // Catalyst folding (1.4 transmuters): clone drain-facility recipes
  // with the catalyst fuel as an extra load-proportional input. See
  // `FoldedCatalystRecipe`.
  const { recipes: sustainRecipes, folded: foldedCatalysts } =
    applyCatalystFolding(filteredRecipes, sustainDrains);

  const maps: ProductionMaps = {
    itemMap: new Map(items.map((i) => [i.id, i])),
    recipeMap: new Map(sustainRecipes.map((r) => [r.id, r])),
    facilityMap: new Map(facilities.map((f) => [f.id, f])),
  };
  // Burn recipes ride the options bag (NOT the `recipes` roster — they
  // bypass the App-layer availability filters) but downstream consumers
  // (flow-solver itemDemands, packer, buildProductionGraph) resolve
  // recipes through `maps.recipeMap`, so register them here. Consumer-
  // only recipes never match `availableProducersFor`, so this cannot
  // leak them into target-rooted traversal.
  for (const fuel of powerFuels) {
    maps.recipeMap.set(fuel.recipe.id, fuel.recipe);
  }
  // Vaporize recipes ride the same channel as burn recipes: consumer-
  // only, so they can never match `availableProducersFor` and leak into
  // target-rooted traversal; they enter the graph exclusively through
  // `buildBipartiteGraph`'s env-scan injection.
  const vaporizeRecipesByEnv = new Map<number, Recipe>();
  // Inverse (vaporize recipe id → env) for stamping `envSupport` onto
  // the plan's vaporize nodes so mappers can render env sinks.
  const envByVaporizeRecipe = new Map<RecipeId, number>();
  for (const [env, cfg] of envConfigs) {
    if (!cfg.recipe.inputs.length) continue;
    vaporizeRecipesByEnv.set(env, cfg.recipe);
    envByVaporizeRecipe.set(cfg.recipe.id, env);
    maps.recipeMap.set(cfg.recipe.id, cfg.recipe);
  }

  // No backtracking: the global LP includes every alternative producer as
  // a variable, so any feasible recipe combination is already in the
  // LP's convex hull. If the LP is infeasible (pinned overrides clash,
  // genuine bootstrap problem, etc.) we surface it via invalidSCCs and
  // return a best-effort empty plan with cycles flagged.
  if (import.meta.env?.DEV) {
    console.log(`\n=== PLAN SOLVE ===`);
  }

  // Union of every active route's eligible items. Producer-less items
  // in this set stay BALANCED in the graph (no raw auto-promotion) so
  // the LP's import variable is their only — budget-bounded — supply.
  let importableItems: ReadonlySet<ItemId> | undefined;
  if (metastorageRoutes.length > 0) {
    const set = new Set<ItemId>();
    for (const route of metastorageRoutes) {
      for (const itemId of route.itemCosts.keys()) set.add(itemId);
    }
    importableItems = set;
  }

  const graph = buildBipartiteGraph(
    targets,
    maps,
    rawMaterials,
    recipeOverrides,
    manualRawMaterials,
    undefined,
    importableItems,
    powerFuels,
    vaporizeRecipesByEnv,
    options.producibleRaws ?? producibleRaws,
  );

  // Power sustain: generation map for the LP row + the warning for the
  // "no fuel survived the availability guard" case (the LP then runs
  // WITHOUT a power-balance row — see `injectPowerBurnRecipes`).
  const powerGenerationByRecipe: ReadonlyMap<RecipeId, number> | undefined =
    powerFuels.length > 0
      ? new Map(powerFuels.map((f) => [f.recipe.id, f.powerGeneration]))
      : undefined;
  const powerWarnings: PlanWarning[] = [];
  if (
    powerFuels.length > 0 &&
    !powerFuels.some((f) => graph.recipeNodes.has(f.recipe.id))
  ) {
    powerWarnings.push({ kind: "power-sustain-unavailable" });
  }

  const sccs = detectSCCs(graph);
  // SCC detection is kept because `propagatePrefillCandidates` and the
  // mapper layer's backward-edge styling both consume `sccs`. The global
  // LP itself doesn't need a topological order — it solves over the
  // whole recipe set in one shot.
  const targetRatesMap = new Map(targets.map((t) => [t.itemId, t.rate]));

  // Gas-env coverage ties (see `LPInput.envCoverage`): every machine
  // running an env-gated recipe forces its fractional share of a
  // vaporizer — env routes carry their gas cost from the FIRST solve.
  // Without this, the first solve prices env recipes at zero gas and
  // the loop's min-run rows then make the vaporizer gas a sunk cost
  // every re-solve ignores when choosing routes (env routes end up
  // permanently underpriced — user-reported Forge-of-the-Sky over-cap
  // regression).
  const envCoverage = (() => {
    const out: {
      vaporizeRecipeId: RecipeId;
      envRecipeIds: RecipeId[];
      machinesPerVaporizer: number;
    }[] = [];
    for (const [env, vaporize] of vaporizeRecipesByEnv) {
      if (!graph.recipeNodes.has(vaporize.id)) continue;
      const envRecipeIds: RecipeId[] = [];
      for (const node of graph.recipeNodes.values()) {
        if (node.recipe.gasEnv === env) envRecipeIds.push(node.recipeId);
      }
      if (envRecipeIds.length > 0) {
        out.push({
          vaporizeRecipeId: vaporize.id,
          envRecipeIds,
          machinesPerVaporizer,
        });
      }
    }
    return out.length > 0 ? out : undefined;
  })();
  const baseSustainLP = envCoverage ? { envCoverage } : undefined;

  // Metastorage auto-selection: enumerate candidate items per route and
  // keep the lex-best solve. Without routes this is the plain single
  // solve (`selected` stays empty and the baseline result is used).
  const { selected: selectedImports, result: flowResult, diagnostics } =
    metastorageRoutes.length > 0
      ? await selectMetastorageImports(
          metastorageRoutes,
          graph,
          sccs,
          targetRatesMap,
          maps,
          manualRawMaterials,
          rawCaps,
          facilityCaps,
          powerGenerationByRecipe,
          baseSustainLP,
        )
      : {
          selected: [],
          result: await calculateFlows(
            graph,
            sccs,
            targetRatesMap,
            maps,
            manualRawMaterials,
            rawCaps,
            facilityCaps,
            undefined,
            powerGenerationByRecipe
              ? { generationByRecipe: powerGenerationByRecipe }
              : undefined,
            baseSustainLP,
          ),
          diagnostics: [] as MetastorageBudgetDiagnostic[],
        };
  // Metastorage warning surfacing (selection-level — computed once,
  // reused by every assembly pass below). The viability gate in
  // `selectMetastorageImports` guarantees the winning solve carries no
  // budget overage; routes whose demand CANNOT fit (import-only demand
  // above budget) selected nothing and surface via `diagnostics`.
  const routeBySource = new Map(
    metastorageRoutes.map((r) => [r.sourceDomain, r]),
  );
  const metastorageWarnings: PlanWarning[] = diagnostics.map((d) => {
    const cycleMinutes = d.cycleSeconds / 60;
    return {
      kind: "metastorage-budget-insufficient",
      sourceDomain: d.sourceDomain,
      itemId: d.itemId,
      neededPerCycle: d.ttvNeededPerMinute * cycleMinutes,
      capPerCycle: d.ttvBudgetPerMinute * cycleMinutes,
    };
  });
  if (metastorageRoutes.length > 0) {
    // Import-only items the plan provably needs (targets + unavoidable
    // intermediates). If they can't all be matched to distinct routes
    // (one item type per source delivery), the plan is structurally
    // unsatisfiable — surface the competing items.
    const conflictItems = necessaryImportOnlyItems(
      metastorageRoutes,
      graph,
      targetRatesMap,
    );
    if (
      conflictItems.length > 0 &&
      !canRoutesCoverItems(conflictItems, metastorageRoutes)
    ) {
      metastorageWarnings.push({
        kind: "metastorage-route-conflict",
        itemIds: conflictItems,
      });
    }
  }
  if (import.meta.env?.DEV && selectedImports.length > 0) {
    console.log(
      `[METASTORAGE] final selection:`,
      selectedImports.map((s) => `${s.sourceDomain}→${s.itemId}`).join(", "),
    );
  }

  // Assemble one packed, render-ready plan from a flow solve. Called
  // once for the baseline solve and once per ceil-floor iteration (the
  // packing + prefill + render stages all depend on the LP's facility
  // counts, so each re-solve needs a full re-assembly).
  //
  // Disposal recipes (Liquid Cleaner + Sewage Inlet variants) are
  // injected pre-LP by `buildBipartiteGraph` and sized by the LP itself
  // — no post-LP disposal injection step is needed. The LP's lex
  // objective (`rawCost → buildingCount → power`) automatically picks
  // the cheapest disposer first (e.g. 0-power Sewage Inlet up to its
  // cap, falling back to powered Liquid Cleaner). The facility cap is
  // a SOFT upper bound (slack-based, mirrors `rawCaps`): the LP
  // biases toward cap-respecting solutions but engages slack rather
  // than returning infeasible when no alternative exists; the
  // over-cap signal surfaces post-pack via
  // `aggregateBinTotals` + `computeOverCapWarnings`. See
  // `graph-builder.ts`'s `injectDisposalRecipesIntoGraph` for the
  // injection rule, and `lp-solver.ts`'s `LPInput.facilityCaps`
  // JSDoc for the slack mechanism.
  const assemblePlan = async (
    fr: FlowSolveResult,
  ): Promise<ProductionDependencyGraph> => {
    const { flowData, invalidSCCs } = fr;

    // Honest LP outcome for the returned plan. A failed solve produces
    // a best-effort EMPTY shell (no recipe nodes, no bins) that is
    // otherwise indistinguishable from "nothing produced" — callers
    // that judge plans (the target optimizer's feasibility predicate,
    // the hook's warning surface) need this marker. See `PlanLpStatus`.
    const lpStatus: PlanLpStatus = fr.metrics.feasible
      ? "ok"
      : (fr.metrics.failureReason ?? "infeasible");

    // Metastorage plan surfacing (flow-dependent — import rates shift
    // between ceil-floor iterations as battery chains grow).
    const metastorageImports: PlanMetastorageImport[] =
      flowData.metastorageFlows.map((flow) => ({
        sourceDomain: flow.sourceDomain,
        itemId: flow.itemId,
        ratePerMinute: flow.ratePerMinute,
        ttvCostPerItem: flow.ttvCostPerItem,
        ttvUsedPerMinute: flow.ttvUsedPerMinute,
        ttvBudgetPerMinute: flow.ttvBudgetPerMinute,
        cycleSeconds:
          routeBySource.get(flow.sourceDomain)?.cycleSeconds ?? 3600,
      }));

    if (invalidSCCs.length === 0 && import.meta.env?.DEV) {
      console.log(`[SUCCESS] Valid production plan found`);
    } else if (invalidSCCs.length > 0 && import.meta.env?.DEV) {
      console.warn(
        `[FAILED] Global LP infeasible. Returning best-effort result with ${invalidSCCs.length} invalid cycle(s).`,
      );
    }

    // Power-sustain shortfall (flow-dependent — shrinks between
    // ceil-floor iterations if a re-solve finds more headroom): watts
    // of power demand the LP could not fund from headroom under the
    // user's raw/facility caps. Battery production is a suggestion —
    // it never violates caps — so the uncovered remainder surfaces as
    // an explicit warning instead of silent cap overuse.
    const shortfallWarnings: PlanWarning[] =
      fr.metrics.powerShortfall > POWER_FLOOR_TOLERANCE
        ? [
            {
              kind: "power-sustain-insufficient",
              shortfallWatts: fr.metrics.powerShortfall,
            },
          ]
        : [];

    // Gas-env coverage check (1.4): an ACTIVE env-gated recipe whose
    // env has no vaporize recipe in the graph (injection guard skipped
    // it — gas unsuppliable) means the plan understates the real gas
    // cost. One warning per affected env. See `gas-env-unavailable`.
    const gasEnvWarnings: PlanWarning[] = [];
    const uncoveredEnvs = new Set<number>();
    for (const [recipeId, fc] of fr.flowData.recipeFacilityCounts) {
      if (!(fc > 0)) continue;
      const env = maps.recipeMap.get(recipeId)?.gasEnv;
      if (env === undefined || env <= 0 || uncoveredEnvs.has(env)) continue;
      const vaporize = vaporizeRecipesByEnv.get(env);
      if (vaporize && graph.recipeNodes.has(vaporize.id)) continue;
      uncoveredEnvs.add(env);
      const envCfg = envConfigs.get(env);
      if (!envCfg) {
        // Env id with no vaporizer entry at all — upstream data drift
        // (a recipe references an env the vaporizer can't produce).
        if (import.meta.env?.DEV) {
          console.warn(
            `[GAS-ENV] recipe ${recipeId} requires unknown env ${env}; no warning emitted`,
          );
        }
        continue;
      }
      gasEnvWarnings.push({
        kind: "gas-env-unavailable",
        env,
        gasItemId: envCfg.gasItemId,
      });
    }

    const packing = await packBins({
      recipeSlotDemands: flowData.recipeFacilityCounts,
      recipeMap: maps.recipeMap,
      itemMap: maps.itemMap,
      facilityMap: maps.facilityMap,
      recipeOverrides,
      facilityCaps,
    });
    const recipePrefill = propagatePrefillCandidates(
      packing.bins,
      sccs,
      packing.allocations,
      maps.recipeMap,
      graph.rawMaterials,
    );
    // Catalyst contract (the plan-level channel display code consumes,
    // mirroring `powerGeneration` / `envSupport`): decompose each active
    // folded clone's catalyst intake into genuine ingredient vs charged
    // upkeep. The folded amounts are static (load-proportional fuel, no
    // post-solve rescaling), so the decomposition is exact by
    // construction for synthetic recipes and region recipes alike.
    const catalystByRecipe = new Map<RecipeId, CatalystUpkeep>();
    for (const f of foldedCatalysts) {
      const fc = flowData.recipeFacilityCounts.get(f.recipe.id) ?? 0;
      if (!(fc > 0)) continue;
      catalystByRecipe.set(f.recipe.id, {
        itemId: f.catalystItemId,
        ratePerMinute: calcRate(f.basePerCraft, f.recipe.craftingTime),
        upkeepPerMin: calcRate(f.basePerCraft, f.recipe.craftingTime) * fc,
        ingredientPerMin:
          calcRate(f.originalInputAmount, f.recipe.craftingTime) * fc,
      });
    }

    const builtPlan = buildProductionGraph(
      graph,
      flowData,
      sccs,
      maps,
      invalidSCCs,
      recipeOverrides,
      packing.bins,
      packing.allocations,
      [
        ...packing.warnings,
        ...metastorageWarnings,
        ...powerWarnings,
        ...shortfallWarnings,
        ...gasEnvWarnings,
      ],
      recipePrefill,
      metastorageImports,
      lpStatus,
      powerGenerationByRecipe,
      envByVaporizeRecipe.size > 0 ? envByVaporizeRecipe : undefined,
      catalystByRecipe.size > 0 ? catalystByRecipe : undefined,
    );
    // Limit-violation verdict (facility caps + raw caps) — emitted by
    // the calculator so EVERY consumer (optimizer probes, the hook's
    // Fit pill / badges) reads the same judgment off `plan.warnings`.
    // Probe/badge parity is structural: there is exactly one judge and
    // it runs inside the pipeline. See `OVER_LIMIT_WARNING_KINDS`.
    builtPlan.warnings.push(
      ...computeLimitViolations(builtPlan, facilities, items, {
        facilityCaps,
        rawCaps,
        manualRawMaterials,
      }),
    );
    return builtPlan;
  };

  let plan = await assemblePlan(flowResult);

  // ── Ceil-floor loop (self-sustaining power × whole buildings) ──────
  //
  // The LP's power-balance row covers FRACTIONAL consumption, but
  // players build whole buildings: in the physical view each ceiled
  // building pays its full rating, so a deep chain with many
  // partially-loaded buildings can out-draw the fuel-limited generation
  // by hundreds of watts (user-reported: 513 W on a 28-partial-bin
  // Wuling plan). Iterate to the discrete fixed point: measure the
  // packed plan's ceiled consumption via `aggregateBinTotals` (the
  // single source of truth — never re-sum), re-solve with that figure
  // as the generation floor (`LPPowerBalance.minGeneration` — soft one
  // tier below the user caps, so batteries only ever spend cap
  // HEADROOM), and repeat until generation covers it or the remainder
  // is proven unaffordable (`powerShortfall` → the
  // `power-sustain-insufficient` warning + affordability stop below).
  // The floor is monotone increasing, so the loop terminates; typical
  // convergence is one extra pass (the top-up's own ceiling bump is
  // just the battery maker + banks). Also covers consumption the LP
  // can't see structurally (raw-only targets' pickup pumps).
  //
  // Always on when power sustain is active — deliberately NOT gated on
  // the display-layer `ceilMode` flag, so the plan never depends on
  // display state (toggling "Round up facilities" must not re-solve or
  // invalidate Max marks). In the fractional view the extra generation
  // simply shows as headroom.
  //
  // On iteration-cap exhaustion or a failed re-solve the last good
  // plan is returned; the hook-level power-deficit warning remains the
  // honest safety net for that residual case.
  const hasGenerators =
    powerGenerationByRecipe !== undefined &&
    powerFuels.some((f) => graph.recipeNodes.has(f.recipe.id));
  // Gas sustain (1.4): the loop also converges the vaporizer
  // whole-building min-runs (ceil(env machines / machinesPerVaporizer)
  // always-on vaporizers). The transmuter catalyst needs no loop pass:
  // its load-proportional fuel charge is already folded into the recipe
  // inputs the LP solved with.
  const hasEnvSupport = Array.from(vaporizeRecipesByEnv.values()).some((r) =>
    graph.recipeNodes.has(r.id),
  );
  // Fragmentation-aware cap tightening: the LP's soft cap row bounds
  // the FRACTIONAL facility count, but the game (and the over-limit
  // judge, `computeLimitViolations`) count PLACEMENTS — Σ ceil(x_r)
  // over the facility's single-formula recipes. A plan can satisfy the
  // row (11.83 ≤ 12) while needing 13 placements (10 + 3). When that
  // happens the loop tightens the LP row to `cap − (activeRecipes − 1)`
  // (sufficient: Σ ceil(x_r) < Σ x_r + R, so Σ x_r ≤ cap − (R − 1) ⟹
  // placements ≤ cap) and re-solves — giving the LP a chance to find a
  // genuinely placeable mix (e.g. offload marginal production to an
  // alternative facility) before the over-cap warning fires.
  const hasCapTightening = facilityCaps !== undefined && facilityCaps.size > 0;
  if (
    (hasGenerators || hasEnvSupport || hasCapTightening) &&
    plan.lpStatus === "ok"
  ) {
    let minGeneration = 0;
    // Monotone state (termination): vaporizer min-runs and the power
    // floor only ever grow; the tightened caps only ever shrink — so
    // the loop provably reaches a fixed point well inside the
    // iteration cap.
    const vaporizerMinRuns = new Map<RecipeId, number>();
    const tightenedCaps = new Map<FacilityId, number>();
    for (let iter = 0; iter < MAX_POWER_FLOOR_ITERATIONS; iter++) {
      const agg = aggregateBinTotals(plan, facilities, items, {
        ceilMode: true,
      });
      let changed = false;

      // 1. Power generation floor (whole-building consumption).
      if (hasGenerators) {
        const deficit = agg.totalPower - agg.totalPowerGeneration;
        // No-progress guard: the ceiled consumption must strictly grow
        // past the floor we already solved for (defensive — a plateau
        // with residual deficit would otherwise loop until the cap).
        if (
          deficit > POWER_FLOOR_TOLERANCE &&
          agg.totalPower > minGeneration + POWER_FLOOR_TOLERANCE
        ) {
          minGeneration = agg.totalPower;
          changed = true;
          if (import.meta.env?.DEV) {
            console.log(
              `[POWER] ceil-floor iteration ${iter + 1}: deficit ${deficit.toFixed(1)}, raising generation floor to ${minGeneration.toFixed(1)}`,
            );
          }
        }
      }

      // 2. Vaporizer min-runs: whole always-on vaporizers per env.
      if (hasEnvSupport) {
        const envBuildings = new Map<number, number>();
        for (const node of plan.nodes.values()) {
          if (node.type !== "recipe") continue;
          const env = node.recipe.gasEnv;
          if (env === undefined || env <= 0 || !(node.facilityCount > 0)) {
            continue;
          }
          envBuildings.set(
            env,
            (envBuildings.get(env) ?? 0) + placedBuildings(node.facilityCount),
          );
        }
        for (const [env, buildings] of envBuildings) {
          const vaporize = vaporizeRecipesByEnv.get(env);
          if (!vaporize || !graph.recipeNodes.has(vaporize.id)) continue;
          const needed = Math.ceil(buildings / machinesPerVaporizer);
          const prev = vaporizerMinRuns.get(vaporize.id) ?? 0;
          if (needed > prev) {
            vaporizerMinRuns.set(vaporize.id, needed);
            changed = true;
            if (import.meta.env?.DEV) {
              console.log(
                `[GAS-SUSTAIN] iteration ${iter + 1}: env ${env} needs ${needed} vaporizer(s) for ${buildings} machine(s)`,
              );
            }
          }
        }
      }

      // 3. Fragmentation-aware cap tightening (single-formula
      //    facilities only — mix pools consolidate recipes per bin, so
      //    the Σ ceil(x_r) placement model doesn't apply to them).
      if (hasCapTightening) {
        const fractionalByFacility = new Map<FacilityId, number>();
        const activeRecipesByFacility = new Map<FacilityId, number>();
        for (const node of plan.nodes.values()) {
          if (node.type !== "recipe" || !(node.facilityCount > 0)) continue;
          const facId = node.recipe.facilityId;
          if (!facilityCaps!.has(facId)) continue;
          if (maps.facilityMap.get(facId)?.cacheSlots !== undefined) continue;
          fractionalByFacility.set(
            facId,
            (fractionalByFacility.get(facId) ?? 0) + node.facilityCount,
          );
          activeRecipesByFacility.set(
            facId,
            (activeRecipesByFacility.get(facId) ?? 0) + 1,
          );
        }
        for (const [facId, frac] of fractionalByFacility) {
          const cap = facilityCaps!.get(facId)!;
          const physical = agg.physicalPerFacility.get(facId) ?? 0;
          const activeRecipes = activeRecipesByFacility.get(facId) ?? 1;
          // Only the fragmentation case: fractional fits the cap but
          // placements exceed it. A fractionally-over cap is real
          // demand pressure — the soft cap row + slack already own it.
          if (!(frac <= cap + 1e-6) || physical <= cap) continue;
          const candidate = Math.max(0, cap - (activeRecipes - 1));
          const prev = tightenedCaps.get(facId) ?? cap;
          if (candidate < prev) {
            tightenedCaps.set(facId, candidate);
            changed = true;
            if (import.meta.env?.DEV) {
              console.log(
                `[GAS-SUSTAIN] iteration ${iter + 1}: ${facId} placements ${physical} > cap ${cap} at fractional ${frac.toFixed(3)} — tightening LP cap to ${candidate}`,
              );
            }
          }
        }
      }

      if (!changed) break;

      const effectiveCaps =
        tightenedCaps.size > 0
          ? new Map([...facilityCaps!, ...tightenedCaps])
          : facilityCaps;

      const fr = await calculateFlows(
        graph,
        sccs,
        targetRatesMap,
        maps,
        manualRawMaterials,
        rawCaps,
        effectiveCaps,
        selectedImports.length > 0 ? selectedImports : undefined,
        powerGenerationByRecipe
          ? {
              generationByRecipe: powerGenerationByRecipe,
              minGeneration: minGeneration > 0 ? minGeneration : undefined,
            }
          : undefined,
        {
          ...(baseSustainLP ?? {}),
          recipeMinRates:
            vaporizerMinRuns.size > 0 ? vaporizerMinRuns : undefined,
        },
      );
      if (!fr.metrics.feasible) {
        // Floor made the solve fail (raw/facility caps are soft, so
        // this is practically a solver error) — keep the last good
        // plan.
        if (import.meta.env?.DEV) {
          console.warn(
            `[GAS-SUSTAIN] ceil-floor re-solve failed (${fr.metrics.failureReason}); keeping previous plan`,
          );
        }
        break;
      }
      plan = await assemblePlan(fr);
      // Affordability stop: the power slack engaged — every remaining
      // watt would need cap headroom that doesn't exist, so raising
      // the floor further cannot help. The assembled plan already
      // carries the `power-sustain-insufficient` warning.
      if (
        hasGenerators &&
        fr.metrics.powerShortfall > POWER_FLOOR_TOLERANCE
      ) {
        if (import.meta.env?.DEV) {
          console.warn(
            `[POWER] ceil-floor stopped: ${fr.metrics.powerShortfall.toFixed(1)} W not fundable within caps`,
          );
        }
        break;
      }
    }

  // Re-anchor the shortfall figure on the FINAL plan's aggregates:
  // the LP slack was measured against the PREVIOUS iteration's floor,
  // but the re-solve's recipe mix can shift the ceiled consumption by
  // a few whole-building quanta — the displayed warning must match
  // the displayed power stat, not a stale floor. Kind-scoped on
  // purpose (findIndex/splice by `power-sustain-insufficient` only):
  // `assemblePlan` appends the cap-violation warnings
  // (`computeLimitViolations`) to the same array, and this re-anchor
  // must never disturb them regardless of emission order.
    const shortfallIdx = plan.warnings.findIndex(
      (w) => w.kind === "power-sustain-insufficient",
    );
    if (shortfallIdx >= 0) {
      const agg = aggregateBinTotals(plan, facilities, items, {
        ceilMode: true,
      });
      const gap = agg.totalPower - agg.totalPowerGeneration;
      if (gap > POWER_FLOOR_TOLERANCE) {
        plan.warnings[shortfallIdx] = {
          kind: "power-sustain-insufficient",
          shortfallWatts: gap,
        };
      } else {
        // Defensive: the final mix closed the gap after all.
        plan.warnings.splice(shortfallIdx, 1);
      }
    }
  }

  return plan;
}
