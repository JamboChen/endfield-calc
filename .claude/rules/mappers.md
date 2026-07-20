---
paths:
  - "src/components/mappers/**"
  - "src/components/flow/ProductionDependencyTree.tsx"
  - "src/components/nodes/**"
  - "src/components/production/ProductionTable.tsx"
  - "src/components/production/ProductionCards.tsx"
  - "src/tests/lib/flow-integrity.test.ts"
  - "src/tests/lib/bin-fusion-mapper.test.ts"
---

# Mapper and rendering invariants

`ProductionDependencyTree.tsx` (`src/components/flow/ProductionDependencyTree.tsx:329-341`) selects the mapper. Three modes:

| Visualization | `bf` flag | Mapper |
|---|---|---|
| Facility View (`visualizationMode === "separated"`) | ignored | `mapPlanToFlowBinFusedSeparated` (always bin-fused) |
| Recipe View | `bf=1` (default) | `mapPlanToFlowBinFused` |
| Recipe View | `bf=0` | `mapPlanToFlowMerged` (legacy per-recipe, chain-debugging) |

The `bf` URL hash flag persists in `SavedPlan` JSON alongside `ceilMode`. Toggle hides itself when no plan bin is grouped.

## Bin-fused architecture (verified)

Phase 3 emits `plan.bins: Bin[]` + `plan.recipeBinAllocations: Map<RecipeId, RecipeBinAllocation>`. Even single-formula recipes get a singleton `Bin` so downstream consumers see a uniform shape.

`bin-fused-mapper.ts` has two entry points:
- `mapPlanToFlowBinFused` (line 59) — Recipe View, one node per bin.
- `mapPlanToFlowBinFusedSeparated` (line 636) — Facility View, one node per ceiled building. Per-building rates are **front-loaded** via `frontLoadedProfile(E, N)` (exported, unit-tested): `effectiveBuildingCount` recovers the packer's per-variant utilisation scale `u_v` (max per-recipe slot allocation on the bin — `rateDirection` is max-normalised; equivalence-class demand-id splits may under-estimate it, which only softens the front-load — conservation holds for any `E ∈ (0, N]`), the first `⌊E⌋` buildings run at full load, the tail carries the remainder (near-integer `E < N` spreads it over two tails instead of leaving a zero-load instance). A tail whose EVERY IO rate falls under `MIN_VISIBLE_RATE_PER_MIN` **folds into the previous building** — otherwise it emits an edge-less node and trips the isolated-node integrity check (flat catalyst drains keep an instance connected, so those never fold). Grouped bins scale their formula mix **uniformly** per building (never per-formula independent front-loading — internal items balance inside each building's own inner inventory). Full load per building is port-safe: Phase 3 only enumerates variants port-feasible at full utilisation. Catalyst exception: upkeep stays flat `/ N` per PLACED building; only the ingredient portion scales with load.

Both call `assertFlowIntegrity` (lines 619, 1332) before returning.

## `assertFlowIntegrity` (`flow-assertions.ts:128`)

- Production: no-op.
- Test mode (`import.meta.env.MODE === "test"`): **throws** on any violation.
- Dev mode: warns to console.

Checks: (1) missing edge endpoints, (2) isolated nodes (when graph has >1 node), (3) cross-bin internal edges (`direction: "internal"` whose endpoints live in different bins), (4) production nodes with `binSisterRecipeIds` but no `binId`.

## Pickup-count semantics

`getRawSourceRate(itemId, item)` (`src/lib/utils.ts:65`): returns the per-facility rate. Reads `rawMaterialSources.get(itemId)?.ratePerMinute`, falling back to `getTransportCapacity(item)`.

`getPickupPointCount(demandRate, perFacilityRate)` (`src/lib/utils.ts:86`): returns a **fractional** value. Display sites apply `formatCount(value, ceilMode)` for the ceiled/fractional toggle.

Signature is `(demandRate, perFacilityRate)` — NOT `(demandRate, item)`. The caller must pre-compute `perFacilityRate` via `getRawSourceRate(itemId, item)` so pump-rate overrides (60/min vs pipe's 120/min) are honoured.

## Producer→consumer allocation (`computeTransportAllocation`)

`computeTransportAllocation` (`src/lib/plan-helpers.ts`) is the **single source of truth** for producer→consumer edge decomposition — merged-mapper, both bin-fused paths, AND the Facility-View raw-pickup edges all route through it (issue #91 + follow-up: a fourth sequential-carving copy in the pickup path daisy-chained 1.2/28.8 fragment edges across whole pickup rows).

**Phase 0 — exact-component peeling**, gated on balance (`Σ supply ≥ Σ demand − ε`; under-supplied items skip it so registration-order starvation priority is untouched): (0a) a consumer matching one producer's supply takes it whole — order-INDEPENDENT, so a late-registered exact consumer keeps its virgin producer even when earlier consumers would tier-3-split it (the Facility View 24+4+2 fragment cascade); (0b) a consumer matching the SUM of two producers takes both whole. Peeling never exceeds the spanning-tree edge bound.

**Phase 1 — greedy tiers** per remaining consumer, in registration order: exact-fit → whole-fit (skipping producers whose supply matches a still-PENDING consumer demand — reserved as that consumer's future exact-fit) → best-fit split (preferring splits whose remainder matches a pending demand) → reserved whole-fit as last resort. The pending-demand reservation is what prevents fragment daisy-chains; tests pin it in `plan-helpers.test.ts` ("pump pickups" / "whole-fit skips fragments" / "phase 0a/0b peel") and `flow-integrity.test.ts` ("exactly one pump").

## Active-rate bin I/O

Bin external rates scale with per-recipe active slot counts, not `shape.netOutputs × buildingCount`. Partial-load cases require this. The greedy producer→consumer allocator uses `MIN_VISIBLE_RATE_PER_MIN` (`src/lib/flow-thresholds.ts:39`, value `0.001`) as its cutoff — both for skipping sub-visible target/disposal/edge rates and for trimming the producer queue. Drift accepted as deliberate.

## Raw byproducts route as edges

`mapPlanToFlowBinFused` (Recipe View bf=1) and `mapPlanToFlowBinFusedSeparated` (Facility View): the greedy producer→consumer allocator treats raw byproduct producers (e.g. Liquid Purifier's water output) as valid producers. The pickup node absorbs only the LP-computed NET external demand (`rawDraw(node)` = `node.rawSupplyRate ?? node.productionRate` — post-LP netting in `calculateFlows`; the `rawSupplyRate` branch is the producible-raw vent draw, see below).

The legacy `mapPlanToFlowMerged` (bf=0) still uses the pickup-only model for ORDINARY raws — pickup card shows NET demand but edges sum to gross consumer demand. Documented limitation; do not "fix" without rewriting the merged-view edge layer. (Producible raws are the exception — they route through `producersOf` there too, see below.)

## Producible-raw targets + intermediates (vent + craft)

A **producible raw** (Xiragen et al. — item node carries `rawSupplyRate`) is dual-sourced: a capped vent pickup PLUS its transmuter recipe. All three mappers render it through the SAME multi-producer allocation as Metastorage imports, so vent and craft split correctly at every consumer/sink. The signal everywhere is `node.rawSupplyRate !== undefined`.

- **`rawDraw(node)`** (module helper in both mapper files) = `rawSupplyRate ?? productionRate`. Every raw-pickup sizing/emission site uses it so the vent pickup covers only the MINED portion; the crafted portion flows from the transmuter.
- **Bin-fused (both paths)**: the transmuter is already a producer (`bin.externalOutputs`). Producible-raw targets are NOT skipped in consumer-registration or sink-emission (`node.isRawMaterial && rawSupplyRate === undefined` is the pure-raw skip), so the sink is a normal consumer — transmuter allocates craft, the pickup-residual loop feeds the vent portion (`emittedNodeIds` includes `targetSinkNodes`, which is what lets the residual reach the sink).
- **Merged (bf=0)**: `producersOf` returns the recipe producers (scanned directly, bypassing `getItemProducers`' raw-guard) PLUS a vent pseudo-producer `{ id: createRawMaterialId(itemId), rate: rawSupplyRate }`; `ensureProducerNode` materialises that pickup node on demand. Terminal producible-raw targets force their sink edges (`isProducibleRawTarget` in the sink-edge condition) since the vent has no flow node yet.
- **Singleton-terminal folding is DISABLED for producible-raw targets** in all three paths (`isFoldedTerminalRecipe` in merged; the `rawSupplyRate !== undefined` bail in both bin-fused detection loops) — an embed can only represent ONE supply, but a producible raw has two.
- Pins/guards: never emit a pickup for a zero-vent producible raw (`rawDraw ≤ MIN`), else a 0-rate orphan pickup trips `assertFlowIntegrity`. Conservation is pinned per-mapper in `producible-raws.test.ts` (vent-mined / over-cap / zero-vent / crafted-intermediate).

## Metastorage import sources

`plan.metastorageImports` (one entry per active route; rates per-minute) renders as ONE source node per **(source region, item)** across all three mappers — id `createMetastorageSourceId(sourceDomain, itemId)` (`node-keys.ts`), `recipe`/`facility` null, `isRawMaterial` false, payload on `ProductionNode.metastorageImport`. The id keys on the source domain (not just item) because a region can receive the same item from multiple sources — a by-item collapse would silently drop one source's supply. Facility View deliberately does NOT emit per-instance variants (the delivery lands in the regional depot, not in buildings).

- All three mappers register the import as a **producer** (`producersByItem` / `producersOf`) so `computeTransportAllocation` splits consumer demand between local production and the import. The node is emitted lazily/conditionally — only when ≥1 visible allocated edge references it (prevents isolated-node violations).
- **Singleton-terminal folding is disabled for imported targets** in all three paths (bf=1 + separated bail in detection; bf=0 routes both the recipe-emission skip AND the input-edge redirect through `isFoldedTerminalRecipe`). The sink needs two real inbound edges (local + import); an embed can only represent one supply.
- `layout.ts:isRawMaterialNode` includes import sources (left-column alignment + `FIRST_SEPARATE` ELK constraint + compact card dimensions).
- Table: `mergeItemNodes` emits one import row per imported item (replacing the empty no-producer row for import-only items); `ProductionTable` keys it `import-${item.id}` and shows TTV per delivery in the Count column + a per-route TTV footer chip.
- Graph search (`GraphSearchPanel`) indexes the import node's sublabel as `"<tree.metastorage> · <source region>"` (facility is null on import nodes) so "metastorage"/region queries find it and result rows disambiguate import vs local producer.

## Power sinks (Thermal Bank burn recipes)

- Burn recipes (self-sustaining power, `powerSustain` option) are zero-output consumer bins that share the **entire disposal flow**: same `isDisposalBin` classification, same `disposal-<recipeId>` sink ids, same consumer registration + allocation. Only the EMISSION branches — a plan recipe node carrying `powerGeneration` gets `createPowerSinkNode` (type `powerSink`, amber `CustomPowerNode`) instead of `createDisposalSinkNode`. Check `powerGeneration` BEFORE `isDisposal` in any new consumer.
- Burn recipes are NOT in `availableRecipes` (they ride the options bag), so both bin-fused mappers seed `recipeById` from `plan.nodes` recipe entries as fallback. Do not remove that seeding — without it power bins misclassify as production bins and produce isolated-node integrity failures.
- Displayed generation is `powerGeneration × facilityCount` with the FRACTIONAL count in both ceil modes (fuel-limited; matches `aggregateBinTotals.totalPowerGeneration`). `useProductionStats` excludes power nodes from the Byproducts list.

## Gas-environment sinks (1.4 Gas Dispersing Units / vaporizers)

- Vaporize recipes (`gasSustain`) are zero-output consumer bins that share the disposal flow, like power sinks. The calculator stamps `ProductionNode.envSupport` (the env id) on vaporize recipe nodes; the EMISSION branches check `envSupport` FIRST (before `powerGeneration`, before disposal) → `createEnvSinkNode` (type `envSink`, teal `CustomEnvNode`). `useProductionStats` excludes vaporize nodes from Byproducts (planned env upkeep, not surplus).
- **Buffed machines are keyed on FORMULA, not facility.** `envBuffedMachines(plan, env, facilityById, recipeById)` (`flow-utils.ts`) returns one `EnvCoverageEntry { facility, recipe, buildings: ceil(fc) }` per ACTIVE recipe with `recipe.gasEnv === env`. The same facility can run non-env formulas that are NOT in the aura (a Forge running plain Xiranite Powder vs. env-gated Xiranite Powder β) — the card lists the recipe name so the user knows which buildings go in the zone.
- **Recipe View + merged (bf=0): ONE aggregate env node** per env, id `disposal-<recipeId>` (same as disposal — existing id-based assertions hold), `facilityCount` = all vaporizers, `covered` = the full per-formula list.
- **Facility View: ONE node PER vaporizer building.** Consumers register as `env-<recipeId>-bldg{i}` (V = `ceil(bin.buildingCount)`, gas intake split evenly so the allocator feeds each); emission mirrors with `facilityCount: 1`. Each unit carries `coveredBuildings: EnvCoveredBuilding[]` (NOT the aggregate `covered`) — the individual buffed BUILDINGS named `<facility> index/total` exactly like the production building nodes (`CustomProductionNode`), each with the `${bin.id}-bldg{index}` `nodeId` so the card row is click-to-jump (centers + selects → spotlight, mirroring the search panel). Enumerated by `buffedBuildingsForEnv` from `plan.bins` (env recipes are single-formula) so singleton-terminal env producers (folded into a target sink, no building node) still appear with `nodeId: undefined`, rendered `1/1`. `partitionBuffedBuildings` does a BALANCED split (first `n % V` units get one extra) — never strands an empty unit. The SET is exact from `gasEnv`; only the which-unit-covers-which grouping is representative (no spatial model). Non-env disposal/power sinks stay aggregate in Facility View.
- Env sinks consume RAW gas (Inergen), so the merged mapper's raw-pickup→sink edge fallback (the `consumedItemNode.isRawMaterial` branch) is what keeps them from being isolated — do not remove it.
- Search (`GraphSearchPanel`): env/power/disposal sinks all headline the consumed item and index the FACILITY name in the sublabel (`"Gas Environment · Gas Dispersing Unit"`), so the units are findable by facility name (`filterSearchCandidates` ranks sublabel hits).

## Cardinal invariants

- **Singleton-terminal bin detection runs BEFORE producer/consumer map construction**. The bin→sink redirect is baked into map construction; post-hoc remapping leaves phantom state.
- **Target sinks register BEFORE disposal sinks** in `consumersByItem`. The greedy allocator iterates in insertion order; targets must get first claim.
- **`merged-mapper.ts` and `bin-fused-mapper.ts` compute per-recipe rate independently and MUST agree.** Don't modify one without auditing the other.
- **`ProductionTable.totals` is a required prop** — callers thread `tableData.totals` from `useProductionTable` (which routes through `aggregateBinTotals`). No row-derived fallback.
- **`ProductionCards` (portrait) and `ProductionTable` (landscape) consume identical `tableData.rows`/`totals`/handlers** — they are view twins swapped by `usePortrait()` in `ProductionViewTabs`. Don't change a number source in one without the other.
- **React row keys must include recipe id** when rendering merged item nodes: `${item.id}-${recipeId}`. Bare `item.id` collides under `mergeItemNodes`' row-per-producer model.

## DO NOT

- DO NOT modify per-recipe rate computation in only one mapper. `merged-mapper.ts` and `bin-fused-mapper.ts` must agree.
- DO NOT detect singleton-terminal bins after building producer/consumer maps. Bake the bin→sink redirect into map construction.
- DO NOT register disposal-bin consumers before target sinks in `consumersByItem`.
- DO NOT wrap `getPickupPointCount`'s return in `Math.ceil` at the call site — that breaks `ceilMode=false` rendering. Always go through `formatCount(value, ceilMode)`.
- DO NOT pass `item` to `getPickupPointCount`. The signature is `(demandRate, perFacilityRate)` — get `perFacilityRate` via `getRawSourceRate(itemId, item)` first.
- DO NOT use bare `0.001` literals — import `MIN_VISIBLE_RATE_PER_MIN` from `@/lib/flow-thresholds`.
- DO NOT use `line.item.id` alone as a React key. Use `${item.id}-${recipeId}` to disambiguate sister rows under `mergeItemNodes`.
- DO NOT set `elk.layered.priority.direction` to a negative value. Lower bound is 0 (see `src/lib/layout.ts:326-341`); values below are silently clamped.
- DO NOT allocate producer→consumer edges with bespoke loops (sequential carving, proportional splits). Route through `computeTransportAllocation` — every bespoke copy has produced fragment daisy-chains (#91).
- DO NOT style the pinned-node indicator on the React Flow wrapper. The ring lives on the node CARDS via `nodeRingClasses` (`flow-utils.ts`) — wrapper-level outlines slice through port handles and mismatch the card radius.
