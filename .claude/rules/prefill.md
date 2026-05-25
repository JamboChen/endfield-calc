---
paths:
  - "src/lib/calculator.ts"
  - "src/tests/lib/calculator.test.ts"
  - "src/components/mappers/bin-fused-mapper.ts"
  - "src/components/mappers/merged-mapper.ts"
---

# Cycle prefill (bin bootstrap requirement)

When a plan contains a recipe-level cycle whose tight back-and-forth has no external entry, the player must seed one of the cycle items into the hosting building's inner inventory at startup; the loop self-sustains afterwards.

**Canonical algorithm doc**: `propagatePrefillCandidates` JSDoc in `src/lib/calculator.ts:253-315` is authoritative — read it before changing detection logic.

**Canonical scenarios**: `src/tests/lib/calculator.test.ts:1385-2200+` covers Xircon-60, planter↔seedcollector, T1/T3 synthetic topologies, manual-raws regression, and the singleton self-loop case. Every behavioural change must keep these tests green.

## Two-phase detection (verified summary)

- **Phase 1 — Intra-bin (`calculator.ts:372-460`)**: for every bin with ≥ 2 recipes, build the intra-bin recipe-flow graph (edges = item flows between co-located recipes, self-loops included), run iterative Tarjan SCC. For each SCC with non-empty cycle items: skip iff ANY cycle item is in `bin.externalInputs` (per-CYCLE, not per-item — single external port suffices). Otherwise flag each recipe with the cycle items it consumes. Handles 2-recipe, 3-recipe, N-recipe intra-bin cycles, and multi-recipe-bin singleton self-loops uniformly.
- **Phase 2 — Inter-bin 2-cycles (`calculator.ts:462+`)**: for each recipe-graph SCC, iterate pairs (A, B). For each (binA hosting A, binB hosting B) where `binA != binB` (intra-bin pairs are skipped), apply the bootability filter: flag iff BOTH cycle items are non-bootable from raws via the active recipe set.
- **Singleton SCC with self-loop (`calculator.ts:481-503`)**: 1-recipe degenerate case, flagged via bootability filter only.

## `computeBootableItems` (`calculator.ts:155`)

Fixpoint over the active recipe set: start with `rawMaterials`, repeatedly add outputs of recipes whose inputs are all bootable. The `rawMaterials` parameter is the plan's `graph.rawMaterials` — union of `forcedRawMaterials` + user-supplied `manualRawMaterials` (URL `m=`) + items chain-terminated by AIC/override constraints. **NOT** `forcedRawMaterials` alone.

## Result storage (two levels)

- **Per-bin**: `bin.prefillCandidates: ItemId[]` = sorted union over member recipes' per-bin lists, filtered to inputs the bin's recipes actually consume. Read by `bin-fused-mapper` and `bin-fused-separated-mapper` (Recipe View bf=1 default + Facility View).
- **Per-recipe (UNION across hosting bins)**: `ProductionGraphNode.prefillCandidates: ItemId[]`. Read by `merged-mapper` (Recipe View bf=0). Conservative: a recipe carries the chip if ANY hosting bin needs prefill.

`(node.prefillCandidates?.length ?? 0) > 0` gates the amber Prefill zone in `CustomProductionNode`.

## Known limitation (T4)

3+ recipe inter-bin cycles (e.g. A in bin X, B in Y, C in Z forming a triangle with no 2-cycle sub-pair) are not detected — Phase 2 iterates pairs only. No real-game data currently exhibits this topology. A defensive DEV log fires (`[PREFILL] SCC … has N recipes but no 2-cycle pair`) if a future game patch triggers it.

## Testing

`propagatePrefillCandidates` is exported (`calculator.ts:316`) so synthetic T1/T3 topology tests can call it directly with hand-crafted Bin/RecipeBinAllocation/Recipe arguments. Production code reaches it only through `calculateProductionPlan` (single call site at `calculator.ts:961`).

## DO NOT

- DO NOT propagate the full `scc.items` set to every bin hosting an SCC recipe. Phase 1 runs Tarjan on the bin's intra-recipe graph and flags only items in genuine intra-bin SCCs. Intermediate items in larger recipe-graph cycles must not appear as prefill chips.
- DO NOT filter intra-bin cycle items per-item against `bin.externalInputs`. The cycle bootstraps from EITHER side — a single externally-supplied half is sufficient. Phase 1's per-CYCLE external-entry check (skip iff ANY cycle item is in `externalInputs`) is the right granularity.
- DO NOT detect intra-bin cycles via pair iteration over the recipe-graph SCC. Intra-bin cycle structure is a property of the bin's local recipe graph; a 3-recipe intra-bin cycle has no 2-cycle sub-pair and would be missed. Use Phase 1's per-bin Tarjan.
- DO NOT emit an inter-bin prefill chip for a 2-cycle when EITHER of its items is reachable from raws via the active recipe set. The "both non-bootable" guard in Phase 2 is the contract.
- DO NOT pass `forcedRawMaterials` directly to `propagatePrefillCandidates`. The plan's `graph.rawMaterials` (built by `graph-builder` as the union of `forcedRawMaterials` + `manualRawMaterials` + chain-terminated items) is the authoritative raw set. Passing the wrong one silently drops manual `m=` URL flags and emits false-positive chips.
- DO NOT iterate `scc.recipes` without filtering to `activeRecipeIds`. Inactive alternatives sit in the SCC's recipe set but don't run; walking them trips `[resolveBinInfo]` warnings.
