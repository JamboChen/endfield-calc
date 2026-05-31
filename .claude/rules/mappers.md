---
paths:
  - "src/components/mappers/**"
  - "src/components/flow/ProductionDependencyTree.tsx"
  - "src/components/nodes/**"
  - "src/components/production/ProductionTable.tsx"
  - "src/tests/lib/flow-integrity.test.ts"
  - "src/tests/lib/bin-fusion-mapper.test.ts"
---

# Mapper and rendering invariants

`ProductionDependencyTree.tsx` (`src/components/flow/ProductionDependencyTree.tsx:265-285`) selects the mapper. Three modes:

| Visualization | `bf` flag | Mapper |
|---|---|---|
| Facility View (`visualizationMode === "separated"`) | ignored | `mapPlanToFlowBinFusedSeparated` (always bin-fused) |
| Recipe View | `bf=1` (default) | `mapPlanToFlowBinFused` |
| Recipe View | `bf=0` | `mapPlanToFlowMerged` (legacy per-recipe, chain-debugging) |

The `bf` URL hash flag persists in `SavedPlan` JSON alongside `ceilMode`. Toggle hides itself when no plan bin is grouped.

## Bin-fused architecture (verified)

Phase 3 emits `plan.bins: Bin[]` + `plan.recipeBinAllocations: Map<RecipeId, RecipeBinAllocation>`. Even single-formula recipes get a singleton `Bin` so downstream consumers see a uniform shape.

`bin-fused-mapper.ts` has two entry points:
- `mapPlanToFlowBinFused` (line 51) — Recipe View, one node per bin.
- `mapPlanToFlowBinFusedSeparated` (line 573) — Facility View, one node per ceiled building.

Both call `assertFlowIntegrity` (lines 556, 1219) before returning.

## `assertFlowIntegrity` (`flow-assertions.ts:128`)

- Production: no-op.
- Test mode (`import.meta.env.MODE === "test"`): **throws** on any violation.
- Dev mode: warns to console.

Checks: (1) missing edge endpoints, (2) isolated nodes (when graph has >1 node), (3) cross-bin internal edges (`direction: "internal"` whose endpoints live in different bins), (4) production nodes with `binSisterRecipeIds` but no `binId`.

## Pickup-count semantics

`getRawSourceRate(itemId, item)` (`src/lib/utils.ts:57`): returns the per-facility rate. Reads `rawMaterialSources.get(itemId)?.ratePerMinute`, falling back to `getTransportCapacity(item)`.

`getPickupPointCount(demandRate, perFacilityRate)` (`src/lib/utils.ts:78`): returns a **fractional** value. Display sites apply `formatCount(value, ceilMode)` for the ceiled/fractional toggle.

Signature is `(demandRate, perFacilityRate)` — NOT `(demandRate, item)`. The caller must pre-compute `perFacilityRate` via `getRawSourceRate(itemId, item)` so pump-rate overrides (60/min vs pipe's 120/min) are honoured.

## Active-rate bin I/O

Bin external rates scale with per-recipe active slot counts, not `shape.netOutputs × buildingCount`. Partial-load cases require this. The greedy producer→consumer allocator uses `MIN_VISIBLE_RATE_PER_MIN` (`src/lib/flow-thresholds.ts:39`, value `0.001`) as its cutoff — both for skipping sub-visible target/disposal/edge rates and for trimming the producer queue. Drift accepted as deliberate.

## Raw byproducts route as edges

`mapPlanToFlowBinFused` (Recipe View bf=1) and `mapPlanToFlowBinFusedSeparated` (Facility View): the greedy producer→consumer allocator treats raw byproduct producers (e.g. Liquid Purifier's water output) as valid producers. The pickup node absorbs only the LP-computed NET external demand (`node.productionRate`, post-LP netting in `calculateFlows`).

The legacy `mapPlanToFlowMerged` (bf=0) still uses the pickup-only model — pickup card shows NET demand but edges sum to gross consumer demand. Documented limitation; do not "fix" without rewriting the merged-view edge layer.

## Cardinal invariants

- **Singleton-terminal bin detection runs BEFORE producer/consumer map construction**. The bin→sink redirect is baked into map construction; post-hoc remapping leaves phantom state.
- **Target sinks register BEFORE disposal sinks** in `consumersByItem`. The greedy allocator iterates in insertion order; targets must get first claim.
- **`merged-mapper.ts` and `bin-fused-mapper.ts` compute per-recipe rate independently and MUST agree.** Don't modify one without auditing the other.
- **`ProductionTable.totals` is a required prop** — callers thread `tableData.totals` from `useProductionTable` (which routes through `aggregateBinTotals`). No row-derived fallback.
- **React row keys must include recipe id** when rendering merged item nodes: `${item.id}-${recipeId}`. Bare `item.id` collides under `mergeItemNodes`' row-per-producer model.

## DO NOT

- DO NOT modify per-recipe rate computation in only one mapper. `merged-mapper.ts` and `bin-fused-mapper.ts` must agree.
- DO NOT detect singleton-terminal bins after building producer/consumer maps. Bake the bin→sink redirect into map construction.
- DO NOT register disposal-bin consumers before target sinks in `consumersByItem`.
- DO NOT wrap `getPickupPointCount`'s return in `Math.ceil` at the call site — that breaks `ceilMode=false` rendering. Always go through `formatCount(value, ceilMode)`.
- DO NOT pass `item` to `getPickupPointCount`. The signature is `(demandRate, perFacilityRate)` — get `perFacilityRate` via `getRawSourceRate(itemId, item)` first.
- DO NOT use bare `0.001` literals — import `MIN_VISIBLE_RATE_PER_MIN` from `@/lib/flow-thresholds`.
- DO NOT use `line.item.id` alone as a React key. Use `${item.id}-${recipeId}` to disambiguate sister rows under `mergeItemNodes`.
- DO NOT set `elk.layered.priority.direction` to a negative value. Lower bound is 0 (see `layout.ts:268`); values below are silently clamped.
