# CLAUDE.md

Instructions for Claude Code when working in this repository.

## Project

Endfield Calc is a production-chain calculator for *Arknights: Endfield* — single-page React + TypeScript, deployed to GitHub Pages at `/endfield-calc/`. Computes resource requirements, production ratios, and facility counts for potentially circular production loops.

## Commands

```bash
bun install                  # Install dependencies
bun dev                      # Dev server
bun run build                # tsc -b then Vite build
bun run lint                 # ESLint
bun vitest run               # Run all Vitest tests (NOT `bun test` — that invokes Bun's native runner, which doesn't understand Vitest)
bun run knip                 # Detect unused code/exports
bun run extract:recipes      # Refresh public/locales/{lang}/recipe.json from game data
bun run extract:aic          # Refresh src/data/aic-plans.ts + public/locales/{lang}/aic.json from game data
bun vitest run <path>        # Single test file
```

To refresh game-data-sourced files from a new dump, set `ENDFIELD_DATA_DIR` to the directory containing `TableCfg/` (defaults to `D:\Projects\EndfieldData`). Both `extract:recipes` and `extract:aic` read from the same root.

When adding packages, also regenerate the pnpm lockfile for CI:
```bash
bun add <package>
pnpm i --lockfile-only
```

## Where critical logic lives

- `src/lib/multi-formula-packing.ts` — Phase 3 ILP bin packer (Reactor / Expanded Crucible). Per-facility, enumerates **variants** — every legal combination of co-locatable recipes within `cacheSlots` — then a MIP picks integer building counts `x_v` per variant and continuous slot usages `u_v` per recipe to minimise lex `(buildings → power → over-provisioning)`. Strict-equality demand constraints (`{ equal: demand_r }`) ensure variants don't over-produce one recipe to "fill" a bin (which would break Phase 2's flow balance). Singleton bins emitted via `emitSingletonBins` for any active recipe the MIP didn't host (non-multi-formula facilities, or recipes that fell outside the MIP's variant set). Algorithm internals (variant signature, mapPhysicalToDemandIds, equivalence classes) documented in the source.
- `src/lib/lp-solver.ts` — generic LP wrapper around HiGHS (WASM). Implements N-pass lexicographic objective: `rawCost → buildingCount → power`. Each pass adds an upper-bound constraint from prior optima so the final solution is lex-optimal under that ranking. Liquid raws (`item_liquid_water`, `item_liquid_acid`) contribute 0 to `rawCost` (see `src/data/index.ts:costlessRaws`); slack vars carry `SLACK_PENALTY` on every objective so disposal slack is only used when no recipe combination can satisfy demand. `FACILITY_COUNT_EPSILON = 1e-6` clamps tiny LP outputs to 0 in `extractSolution` (defends against HiGHS degenerate-vertex artefacts).
- `src/lib/flow-solver.ts` — `calculateFlows` builds and solves **one global LP** over every recipe in the multi-recipe graph. Per-item constraints: targets → `min: targetRate`, forced-disposal → `disposal-slack: 0`, raws → excluded, other intermediates → `min: 0` (LP-optimal still drives surplus to 0 because cost minimisation; `min` is robust against multi-output recipes whose byproducts have no consumer). Post-solve, `itemDemands` is derived from `recipeFacilityCounts` and raw byproduct production is netted out (`Math.max(0, gross - byproduct)`) so the pickup-count layer sees NET external demand.
- `src/lib/graph-builder.ts` — `buildBipartiteGraph` traverses every reachable item and adds **all** alternative producers (no single-pick heuristic). `availableProducersFor` applies in order: (1) recipe pin narrowing, (2) AIC exclusions, (3) per-item dismantler fallback (drop dismantle recipes iff at least one non-dismantle producer exists). `detectSCCs` runs Tarjan for downstream rendering (backward-edge styling, prefill detection); the LP solves cycles natively via balance constraints, no condensed-DAG ordering needed.
- `src/lib/calculator.ts` — orchestrates `calculateProductionPlan`. Single-shot solve: build graph → detect SCCs → solve global LP → inject disposal recipes → bin-pack → propagate prefill candidates → build the rendering graph. **No backtracking, no feeder extension, no iteration loop** — the global LP considers every alternative producer in one shot. User-pinned recipes that make the LP infeasible fail loudly via `invalidCycles` (recovery: drop the pin, or also mark an upstream item as a manual raw). `buildProductionGraph` filters rendering to the **active subgraph**: only recipes with `facilityCount > 0` + items they touch + targets + raws. Inactive alternative producers stay in `graph.recipeNodes` but are dropped from `plan.nodes` so isolated zero-throughput nodes don't appear in mappers.
- `src/lib/plan-helpers.ts:aggregateBinTotals` — single source of truth for building / power / per-facility totals.
- `src/components/mappers/bin-fused-mapper.ts` — default rendering path (Recipe + Facility view).
- `src/components/mappers/merged-mapper.ts` — legacy per-recipe Recipe View (bf=0 toggle).
- `src/components/mappers/flow-assertions.ts` — `assertFlowIntegrity` (throws in test mode).
- `src/hooks/useDomainSettings.ts` + `src/lib/aic-research-helpers.ts` + `src/lib/aic-cascade.ts` — per-domain settings state. The hook owns the user's domain-activation set + AIC research set + custom cap overrides; the helpers are pure derivation functions (unlocked facilities / modes / effective caps / per-plan at-defaults) and pure DAG-cascade primitives (activate / deactivate / dependent search). UI in `src/components/settings/`.
  - **Generic vs category**: `useDomainSettings` returns `{ domains, activeDomains, toggleDomain, aic: {...} }` — domain-level concerns at the top, per-category sub-states (today: `aic`; later: `regionLimits`, `powerBudget`, …) nested under their own keys. Each new category adds a peer sub-object alongside `aic` without disturbing existing call sites.
  - **Persistence**: localStorage key `endfield-calc:aic-v1` is the sole version signal (no `v` field inside the JSON). Loader detects shape: nested `{ domains, aic }` is current; flat `{ unresearched, capOverrides, inactiveDomains? }` is migrated in-place to nested on first read. Writer always emits nested. AIC sub-state uses a **deny-list** for research (`aic.unresearched`); domains use a deny-list for activation (`domains.inactive`).
  - **First-run state**: every non-pinned domain (i.e., `sortId !== 1`) starts inactive. Pinned domain (`domain_1`, Valley IV) always active. Active-domain nodes start all-researched (Step 1 default); inactive-domain nodes start at game defaults (`alreadyUnlocked: true` only).
  - **Soft deactivation**: `toggleDomain` only mutates `inactiveDomains`. `researched` is preserved across activation flips — re-activating a previously-active domain restores prior research state automatically. Pinned domains refuse deactivation.
  - **Per-plan Reset**: `aic.resetGroupToDefaults(groupId)` resets only that group's nodes; other groups untouched. `aic.isAtDefaultsByGroup.get(groupId)` drives the Reset button visibility in `AicPlanCard`.
- `scripts/extract-aic-plans.ts` — `bun run extract:aic` regenerates `src/data/aic-plans.ts` + `public/locales/{lang}/aic.json` + `public/locales/{lang}/domain.json` from the upstream FacSTT + Domain tables.
  - **Hybrid cap-raise detection**: techs whose `action.actionType !== 5123` but whose `unlockReward` includes an `item_factech_*_amount_*` milestone item get a synthesised `capRaise` action — the delta is parsed from the tech's English `desc.id` (`+N` regex) and self-checked against the explicit-5123 deltas. The current data has one such case: `tech_jinlong_3_xiranite_enr_formula` ("Forge Expansion III", +4). Display label is overridden to the milestone item's name (not the tech's own "Expansion and Heavy Xiranite").
  - **Layer name normalisation**: Title-Case applied at extraction (`"WULING AIC I"` → `"Wuling AIC I"`), preserving ≤3-char upper-case tokens (catches "AIC") and roman numerals.
  - **Domain registry**: emits `export const domains: readonly Domain[]` from `DomainDataTable.json`. `isPinned` derived from `sortId === 1`. Color sourced from `domainColor`. Each domain's `name` lives in `domain.json` per locale.
- `src/types/domain.ts` + `src/types/aic.ts` — types split by concern. `domain.ts` holds the generic `DomainId` brand + `Domain` registry shape; `aic.ts` holds AIC-specific types (`AicGroupId`, `AicNode`, etc.) and imports `DomainId` from `domain.ts`. Future per-domain categories add their own type files alongside.
- `src/components/settings/DomainSection.tsx` — generic outer wrapper per domain. Hosts the activation `Switch` (hidden if `domain.isPinned`), accent stripe (`domain.color`), and arbitrary child cards. When inactive, the body is `opacity-50 pointer-events-none` (soft preservation — DOM kept intact).
- `src/components/settings/AicPlanCard.tsx` — one category card hosted inside a `DomainSection`. AIC-specific. Future cards (e.g. `RegionLimitsCard`) follow the same sibling-within-DomainSection pattern.

Everything else is discoverable via `ls` / `grep`. Game data: `src/data/{items,recipes,facilities}.ts`; types: `src/types/`; UI: `src/components/`; hooks: `src/hooks/`; tests: `src/tests/lib/`.

## Type system

Two nominal-typing patterns coexist in `src/types/constants.ts`:

**Closed-enum literal-string unions** for IDs sourced from the game-data dump (the value set is finite and enumerable):

```typescript
const ItemId = { ITEM_X: "item_x", ... } as const;
type ItemId = (typeof ItemId)[keyof typeof ItemId];
// ItemId = "item_x" | "item_y" | ...
```

`ItemId`, `RecipeId`, and `FacilityId` follow this pattern. A plain `string` cannot satisfy them (it isn't in the union), so the type system prevents mixing without needing brand intersections.

**Brand intersection** for dynamic identifiers (the value set is open):

```typescript
type BinId = string & { readonly __brand: "BinId" };
```

`BinId` follows this pattern because bin IDs are constructed at runtime by `makeBinId` in `multi-formula-packing.ts` (format `bin-<facilityId>-<recipeId...>-<emitIdx>`) — there's no closed enum to express as a union.

Domain types in `src/types/core.ts`, `src/types/production.ts` (including `Bin`, `RecipeBinAllocation`, `ProductionDependencyGraph.warnings`), `src/types/flow.ts`.

**IMPORTANT: Always thread brands through; never cast with `as ItemId` / `as RecipeId` / `as FacilityId` / `as BinId` in production code. Use `getItemById` or accept the branded type. The only permitted `as BinId` cast is inside `makeBinId` at the construction site.**

## Bin-fused architecture

Phase 3 packs multi-formula recipes (facilities with `cacheSlots`) into shared buildings. Output: `plan.bins: Bin[]` + `plan.recipeBinAllocations: Map<RecipeId, RecipeBinAllocation>`. Even single-formula recipes get a singleton `Bin` so downstream consumers see a uniform shape.

`ProductionDependencyTree.tsx` selects the mapper:

| View | bf flag | Mapper |
|---|---|---|
| Facility View | (ignored) | `mapPlanToFlowBinFusedSeparated` (always bin-fused) |
| Recipe View | bf=1 (default) | `mapPlanToFlowBinFused` |
| Recipe View | bf=0 | `mapPlanToFlowMerged` (legacy per-recipe) |

The `bf` URL hash flag persists in `SavedPlan` JSON files alongside `ceilMode`. Toggle hides itself when no plan bin is grouped.

### Cycle prefill (bin bootstrap requirement)

When a plan contains a recipe-level cycle whose tight back-and-forth has no external entry point, the player must seed one of the cycle items into the hosting building's inner inventory at startup; the loop self-sustains afterwards. Computed by `propagatePrefillCandidates` in `calculator.ts` after `packBins`.

The result is stored at TWO levels so both views render it:

- **Per-bin**: `bin.prefillCandidates: ItemId[]` = union of member recipes' per-(bin, recipe) lists, filtered to inputs the bin's recipes actually consume. Read by `bin-fused-mapper` (bf=1, default Recipe View) and `mapPlanToFlowBinFusedSeparated` (Facility View) — one chip per bin card / per building.
- **Per-recipe (UNION across hosting bins)**: `ProductionGraphNode (recipe).prefillCandidates: ItemId[]`. Read by `merged-mapper` (bf=0) — one chip per recipe node. Conservative: a recipe carries the chip if ANY hosting bin needs prefill.

Both mappers thread `prefillCandidates` onto the React Flow node data (`data.productionNode.prefillCandidates`) so `CustomProductionNode` reads it uniformly: `(node.prefillCandidates?.length ?? 0) > 0` gates the amber Prefill zone.

**Two-phase detection**, each phase keyed to the natural problem layer:

#### Phase 1: Intra-bin cycles via per-bin Tarjan SCC

For every bin with ≥ 2 recipes, build the intra-bin recipe-flow graph (edges = item flows between co-located recipes, including self-loops where a recipe consumes its own output) and run iterative Tarjan SCC over it.

For each SCC the cycle-items loop collects edge labels where both endpoints are in the SCC. A size-1 SCC produces cycle items only when its node has a self-loop edge; non-self-looped singletons fall out naturally with an empty cycle-items set. Size ≥ 2 SCCs (the common case: 2-recipe and 3-recipe cycles) collect labels across all intra-SCC edges.

For each SCC with non-empty cycle items:
- If ANY cycle item is in `bin.externalInputs` → **skip**. The cycle has external entry via the LP-assigned port; flow into a single port lets one recipe in the SCC run, which produces the other cycle items internally on the next cycle. (`bin.externalInputs` is the LP's authoritative port allocation — see the `Bin` JSDoc in `src/types/production.ts` for its precise semantics: net per-(slot allocation) deficit items that the bin imports across pipes/belts. If an item isn't in `externalInputs`, the bin has *no port* for it; no amount of belt re-routing in the game can change that.)
- Otherwise → **flag per recipe** (each recipe in the SCC carries the cycle items it consumes).

This handles 2-recipe, 3-recipe, N-recipe intra-bin cycles, AND singleton self-loops within multi-recipe bins (degenerate size-1 cycle) uniformly via the same Tarjan + cycle-items pipeline. The per-CYCLE external-entry check (not per-item) is critical: with the recipes Effluent-Prod (consumes Sewage, produces Effluent) + Xircon-Prod (consumes Effluent, produces Sewage), a single external Effluent port is enough — Xircon-Prod runs first, produces Sewage, and Effluent-Prod runs second.

#### Phase 2: Inter-bin 2-cycles via recipe-graph SCC pair iteration

For each recipe-graph SCC (already detected by `graph-builder` for flow solving), iterate pairs (A, B) and check for a tight 2-cycle. For each (binA hosting A, binB hosting B) pair where `binA != binB` (intra-bin pairs are skipped — Phase 1 covered them), apply the bootability filter: flag iff BOTH cycle items are non-bootable from raws via the active recipe set.

`computeBootableItems` is a fixpoint: start with `forcedRawMaterials`, repeatedly add the outputs of any active recipe whose inputs are all bootable. If either I or J is bootable, the cycle bootstraps from that side without prefill.

**Known limitation (T4)**: 3+ recipe inter-bin cycles (e.g. recipes A in bin X, B in bin Y, C in bin Z forming a triangle with no 2-cycle sub-pair) are not detected — Phase 2 iterates pairs only. No real-game data currently exhibits this topology. A defensive DEV log fires (`[PREFILL] SCC … has N recipes but no 2-cycle pair; T4 limitation`) if a future game patch ever triggers it; revisit by extending Phase 2 to a recipe-graph-SCC-bootability scheme.

#### Worked examples

**Xircon-60 (real plan, both phases)** — the LP packs the three pool recipes into TWO Crucible bins:

- **Bin 0** (3-formula): LX-Prod + Effluent-Prod + Xircon-Prod. Phase 1 Tarjan on the bin's intra-flow graph finds SCC `{Effluent-Prod, Xircon-Prod}` (LX-Prod is a trivial SCC, upstream of the cycle). Cycle items = {Sewage, Xircon Effluent}. **Xircon Effluent IS in `bin.externalInputs`** (LP routes 60/min from Bin 1 + Purifier) → external entry → **skip. Bin 0 prefillCandidates = [].** Reason: at t=0+, external Effluent flows into Bin 0; Xircon-Prod runs first (Effluent + iron_powder both available externally), produces Sewage internally; Effluent-Prod runs next (LX from in-bin LX-Prod + Sewage from Xircon-Prod). Steady state without any seed.
- **Bin 1** (2-formula): LX-Prod + Effluent-Prod. Phase 1: no intra-bin cycle (linear LX-Prod → Effluent-Prod). Phase 2's (Effluent-Prod, Xircon-Prod) pair is inter-bin here; bootability filter checks: Sewage bootable via Furnace, Effluent non-bootable until planter cascade — but `EITHER` bootable suffices → skip. **Bin 1 prefillCandidates = [].**

Per-recipe (bf=0): all three pool recipes carry empty `prefillCandidates`. Furnace, Purifier, Xiranite Oven also clean. The chips that fire in this plan are entirely on the planter/seedcollector pairs.

**Planter ↔ Seedcollector (moss cycle)** — each lives in its own singleton bin. Phase 1 doesn't fire (single recipe per bin). Phase 2 sees the inter-bin 2-cycle (planter, seedcollector) via plant + seed. Neither has a producer outside the cycle → both non-bootable → flag. Planter consumes seed → `prefillCandidates = [seed]`; seedcollector consumes plant → `prefillCandidates = [plant]`.

**Hypothetical 3-recipe intra-bin cycle (T3, synthetic)** — bin hosts {A, B, C} with A→I→B, B→K→C, C→J→A. The old 2-cycle pair iteration would have missed this (no two of (A,B), (B,C), (A,C) form a tight 2-cycle). Phase 1 Tarjan picks up the size-3 SCC, collects cycle items {I, J, K}, applies the external-entry check. If none of {I, J, K} is in `bin.externalInputs` → flag each recipe with the cycle items it consumes (A→[J], B→[I], C→[K]). Pinned by synthetic tests in `calculator.test.ts`.

#### Singleton self-loops

Singleton SCCs with a self-loop (a single recipe consuming its own output — rare/non-existent in current data) are handled in Phase 2's `scc.recipes.size === 1` branch with the bootability filter. The self-looped item is flagged only if it's non-bootable. Phase 1 doesn't fire for these (its `bin.recipeIds.length < 2` early exit).

#### Operational notes

- `propagatePrefillCandidates` is exported from `calculator.ts` so synthetic T1/T3 topology tests can call it directly with hand-crafted Bin / RecipeBinAllocation / Recipe arguments, bypassing the packer. Production code reaches it only through `calculateProductionPlan`.
- The `rawMaterials` parameter receives the plan's **`graph.rawMaterials`** — the union of `forcedRawMaterials` (game-data raws), user-supplied `manualRawMaterials` (URL `m=` param), and any items that have no surviving producer under the current AIC / override constraints (chain-terminated and marked raw by `buildBipartiteGraph`). This is the single source of truth for "what counts as raw in THIS plan" and the bootability fixpoint reads it directly. Passing `forcedRawMaterials` alone misses manual raws and emits false-positive chips (e.g. Sewage flagged on a Crucible bin even when the user explicitly marked Sewage raw and the LP pumps it from a pickup).
- The pre-existing `useProductionPlan.ts` warning filter (which hides game-data cycle warnings as "not actionable") is unchanged — the per-bin / per-recipe chip is the actionable signal.
- DEV-mode logging (`import.meta.env?.DEV`) prints the bootable set, each phase's progress (`[PREFILL]   intra-bin … external entry via [...]; skip` for Phase 1 rescues, `[PREFILL]   inter-bin … bootable-bypassed` for Phase 2 rescues, `[PREFILL]   intra-bin-scc bin … <- recipe … +[...]` for flags), and the T4 defensive log. Look for `[PREFILL]` prefix.

## Algorithm invariants

**IMPORTANT — these are non-obvious decisions that have caused real bugs when violated:**

- **`bin.recipeIds` holds demand recipe ids (Phase 2's pick), not physical twin ids the ILP picked.** Downstream consumers compare against `node.recipeId` with plain equality. `bin.facilityId` separately tracks the physical facility.
- **Active-rate bin I/O.** Bin externals scale with per-recipe active slot counts, not `shape.netOutputs × buildingCount`. Partial-load cases (e.g. Xircon target=57) surface correctly.
- **`aggregateBinTotals` is the single source of truth** for buildings / power / per-facility counts. Per-recipe-ceiled aggregation triple-counts shared multi-formula bins.
- **Per-pin restricted + class-wide total constraints** in `solvePacking`. Pinned demand-recipes get a restricted constraint; the class also gets a total. Pinned demand allocates first in `allocateSlotsToBins`.
- **Two distinct lexicographic objectives** — don't confuse them:
  - **`flow-solver` / `lp-solver` LP** (recipe selection): `rawCost (liquid raws free) → buildingCount → power`. Picks which recipes run and at what fractional facility count. Three passes; each adds an upper-bound constraint from the prior optimum (`LEX_TOLERANCE` per objective).
  - **`multi-formula-packing` ILP** (bin packing): `buildings (1e-6 tol) → power (1e-3 tol) → over-provisioning`. Picks how to pack the LP-chosen recipes into shared multi-formula buildings.
- **Liquid raws are free in the LP `rawCost` objective** (`costlessRaws` set in `src/data/index.ts`, derived from `items.filter(isLiquid) ∩ forcedRawMaterials`; currently `{item_liquid_water, item_liquid_acid}`). Pumps have unbounded throughput in-game so the LP should not bias selection against recipes that consume them. Auto-extends if game data adds new liquid raws.
- **`FACILITY_COUNT_EPSILON = 1e-6` clamp** in `lp-solver.ts:extractSolution` zeroes out tiny LP outputs. HiGHS occasionally lands on degenerate-vertex solutions with ~1e-8 facility counts for alternatives; the clamp prevents phantom recipes from leaking into the bin packer.
- **Active-subgraph filter in `buildProductionGraph`** (calculator.ts): `plan.nodes` only contains recipes with `facilityCount > 0` (plus targets, raws, and disposal sinks). The multi-recipe graph contains every alternative producer; rendering must filter to the LP-picked subset or isolated zero-throughput recipe nodes appear and trip `assertFlowIntegrity`.
- **`detectedCycles` iterates active recipes only.** `calculator.ts:detectedCycles` filters each SCC's recipes by `activeRecipeIds` before walking them. Inactive alternatives (e.g. `pool_xiranite_poly_2` when the LP picked tier 1) are in `scc.recipes` but don't run; iterating them would trip the `[resolveBinInfo] ... has no bin allocation` warning for recipes the packer correctly didn't allocate. Pinned by the existing flow-integrity tests; the warning is the canary.
- **Pool capacity is tracked in primary-output units** (recipe's first output). Byproducts derive via ratio `byproductAmount / primaryAmount`.
- **`itemDemands` netting rules in `flow-solver.ts:calculateFlows`** (post-LP): gross consumption and gross production are summed separately across recipes, then `itemDemands[rawItem] = max(0, gross - byproduct)`. Per-recipe interleaved netting would zero out negative intermediates and lose the byproduct credit whenever a producer is processed before its consumers. This is the source of truth for the pickup-count layer in the bin-fused mapper.
- **LP item-constraint selection** (`flow-solver.ts`): user targets → `min: targetRate`; forced-disposal → `disposal-slack: 0` (slack absorbs deficit, reported as `disposalDeficit`); raws → excluded from balance constraints (infinite supply); other intermediates → `min: 0` (LP cost-minimisation drives surplus to 0 in the optimal, but `min` is robust against multi-output recipes whose byproducts have no consumer — `equal: 0` would refuse to run them).
- **User-pinned recipe = hard constraint, fail loud.** `availableProducersFor` narrows the producer pool to just the pinned recipe when `recipeOverrides.has(itemId)`. If the resulting graph has no feasible LP solution, the plan fails with `invalidCycles` populated rather than silently swapping in another recipe. Recovery: drop the pin, or mark an upstream input as a manual raw.
- **Singleton-terminal bin detection runs before producer/consumer map construction** in bin-fused mappers. The bin→sink redirect is baked into map construction; post-hoc remapping leaves phantom state that produces isolated nodes.
- **Target sinks register before disposal sinks** in the bin-fused greedy allocator so targets get first claim on producer output.
- **`assertFlowIntegrity` throws in test mode** (`import.meta.env?.MODE === "test"`), warns in dev, no-ops in production.
- **`assertBinPortCaps` throws in test mode** for any packer-emitted bin (`packed.bins` path, not `singletons.bins` fallback) that exceeds its facility's `buffersIn.pipe` / `buffersOut.pipe` / `buffersOut.belt` caps. The packer's variant-enumeration architecture only enumerates port-feasible variants, so this is an invariant by construction; a violation indicates a packer bug.
- **Solver timeout**: all `solver.Solve` calls in `multi-formula-packing.ts` carry `options: { timeout: 30000 }` (matching vitest's `testTimeout`). On timeout the library returns the best integer solution found so far (or `feasible: false`); the existing try/catch + lex fallback chain catches the latter.
- **`MIN_VISIBLE_RATE_PER_MIN` contract** (`src/lib/flow-thresholds.ts`, value `0.001` items/min): shared visibility threshold between the packer's emission filter and the mappers' edge-allocation cutoffs. Production code must use this constant — bare `0.001` literals are forbidden. The packer's strict-equality demand constraints (`{ equal: demand_r }`) are maintained **modulo sub-visible drift**: `solvePacking`'s emission filter drops variants whose maximum recipe rate falls below `MIN_VISIBLE_RATE_PER_MIN` (necessary because the continuous LP can return ~1e-7 `u` values for vestigial variants). Per-variant drop ≤ 0.001/min; cumulative plan-wide drift ≤ ~0.005/min in practice — below any meaningful production granularity, accepted as deliberate.
- **`ProductionTable.totals` is a required prop**: callers must thread `tableData.totals` from `useProductionTable` (which routes through `aggregateBinTotals`). There is no row-derived fallback — adding one re-introduces the building-count drift between the table footer and the side-panel stats.
- **Bin ID sort contract**: `bin.recipeIds` is always sorted ascending. `useProductionTable.ts` uses `bin.recipeIds[0]` as the "primary row owns the power" key — re-ordering bin ids silently breaks the primary-row attribution. Pinned by `bin.recipeIds is sorted ascending` test.
- **Source-facility power is folded into `aggregateBinTotals`**: pickup-point pumps (`pump_1`, `pump_2`) and depot unloaders (`unloader_1`) appear in `perFacility` and contribute to `totalPower`. Pickup counts respect `ceilMode` the same way bin counts do: ceiled physical pickups when `ceilMode=true`, fractional theoretical pickups when `ceilMode=false`. Do NOT re-sum pickup power at the caller — that would double-count. See `src/lib/plan-helpers.ts:aggregateBinTotals`.
- **Pump throughput is 60/min, pipe capacity is 120/min** — distinct concepts. Pumps cap at one cycle per second (`FactoryFluidPumpInTable.msPerRound: 1000`), so one pipe carries two pumps. `getRawSourceRate(itemId, item)` returns the per-facility rate; `getTransportCapacity(item)` returns the per-belt/per-pipe rate. Pickup count uses `getRawSourceRate`; edge labels keep using `getTransportCapacity`.
- **`getPickupPointCount` returns a fractional value**, not a ceiled integer. Display sites apply `formatCount(value, ceilMode)` (the same utility used for regular facility counts) to render either the ceiled physical count or the fractional theoretical view. DO NOT wrap the result in `Math.ceil` at the call site — that breaks `ceilMode=false` rendering.
- **Raw byproducts are routed as edges** in `mapPlanToFlowBinFused` (default Recipe View, bf=1) and `mapPlanToFlowBinFusedSeparated` (Facility View): the greedy producer→consumer allocator now treats raw byproduct producers (e.g. Liquid Purifier's water output) as valid producers. The pickup node downstream absorbs only the LP-computed NET external demand (`node.productionRate`, post-LP netting in `calculateFlows`), keeping the pickup-card metrics aligned with the side panel. The legacy `mapPlanToFlowMerged` (bf=0) still uses the pickup-only model — its pickup card shows NET demand but edges sum to gross consumer demand; documented as a known limitation in the mapper's source.

## Game data conventions

- `rawMaterialSources` (in `src/data/index.ts`): `Map<ItemId, RawSourceConfig>` binding each raw material to its in-game source facility (`unloader_1` for solids, `pump_1` for most liquids, `pump_2` for acid). Per-facility throughput defaults to transport capacity (30 belt / 120 pipe) unless overridden via `ratePerMinute` (used for liquid pumps which cap at 60/min). Adding a new raw requires picking a source facility — solids → `unloader_1`, liquids → the lowest-tier pump that accepts the liquid.
- `forcedRawMaterials` (derived back-compat `ReadonlySet<ItemId>`): the key set of `rawMaterialSources`. Solver-layer code (`flow-solver.ts`, `graph-builder.ts`, `AddTargetDialogGrid.tsx`) uses `.has()` / `for...of` against this set. To get source-facility info, use `rawMaterialSources` directly — the set carries no source data.
- `forcedDisposalItems`: items that must net to zero in the plan. Other recipes may consume them, but any surplus is routed to disposal sinks via `injectDisposalRecipes`.
- Item IDs: `item_<category>_<subcategory>_<modifier>`. Recipe IDs: `<facility_type>_<output>_<tier>`. Keep enums in `src/types/constants.ts` alphabetised.
- Image assets: `public/images/items/<item_id>.png` and `public/images/facilities/<facility_id>.png`. Source-facility images `unloader_1.png`, `pump_1.png`, `pump_2.png` are placeholders pending real game-asset extracts.

## Test conventions

- Tests live in `src/tests/lib/`. Run a single file with `bun vitest run <path>`.
- For latent-bug regressions, write tests with **inline synthetic items + recipes** passed to `calculateProductionPlan`. Isolates the bug from upstream-data drift.
- For upstream-data-triggered bugs, use the real-data regression style: import real `items` / `recipes` / `facilities`, target specific `ItemId` enum values, assert exact production rates.
- Use `toBeCloseTo(value, 3)` for facility counts and rates (absorbs floating-point noise).
- `flow-integrity.test.ts` is the model for mapper-output assertions (no dangling edges, no isolated nodes). `assertFlowIntegrity` automatically throws on integrity violations in test mode — most mapper bugs surface as test failures before reaching explicit assertions.

## Pre-ship workflow

1. `bun run lint` — ESLint clean of new warnings.
2. `bun vitest run` — all tests pass.
3. If you touched `src/lib/`: also `bun vitest run src/tests/lib/calculator.test.ts`, `bun vitest run src/tests/lib/flow-integrity.test.ts`, `bun vitest run src/tests/lib/bin-fusion-mapper.test.ts`, and `bun vitest run src/tests/lib/multi-formula-packing.test.ts` — these are sensitive to algorithm changes.
4. `bun run build` — TypeScript clean and Vite build succeeds.
5. `bun run knip` — surface any newly-unused exports introduced by the change.

## Anti-patterns

**IMPORTANT — these have caused real bugs:**

- DO NOT modify per-recipe rate computation in only one mapper. `merged-mapper.ts` and `bin-fused-mapper.ts` compute rate independently and MUST agree.
- DO NOT add `as ItemId` / `as RecipeId` / `as FacilityId` / `as BinId` casts in production code. Brands exist to prevent this. Use `getItemById` or thread the type through. (Tests may use `as unknown as ItemIdType[]` style double-casts for synthetic fixtures.)
- DO NOT construct a fresh `BinId` outside `makeBinId` in `multi-formula-packing.ts`. Receive it through the type system. The mapper synthetic IDs (`disposal-<recipeId>`, `<binId>-bldg<idx>`, target-sink IDs) are NOT BinIds — they stay plain `string`.
- DO NOT use bare `0.001` literals in production code. Import `MIN_VISIBLE_RATE_PER_MIN` from `@/lib/flow-thresholds`.
- DO NOT bypass `aggregateBinTotals` for building / power totals. Per-recipe-ceiled aggregation triple-counts shared multi-formula bins.
- DO NOT detect singleton-terminal bins after building producer/consumer maps. Bake the bin→sink redirect into map construction; isolated-node bugs trace back to phantom-state remapping.
- DO NOT register disposal-bin consumers before target sinks in `consumersByItem`. Greedy allocator iterates in insertion order; targets must get priority.
- DO NOT call `solver.Solve` directly from outside `solveLP` / `solvePacking`. The wrappers handle raw-material exclusion, lexicographic passes, slack handling, recipe pinning, tolerance, and the `timeout: 30000` defense-in-depth.
- DO NOT add to `rawMaterialSources` / `forcedRawMaterials` without confirming the item has no in-game production recipe AND picking a real source facility. Wrong additions silently break upstream chains. Solids → `unloader_1`; liquids → `pump_1` (most) or `pump_2` (acid).
- DO NOT iterate `forcedRawMaterials` to compute source-facility info — use `rawMaterialSources.get(itemId)` directly. The Set is back-compat only and carries no source data.
- DO NOT pass `item` to `getPickupPointCount`. The signature is `(demandRate, perFacilityRate)` — get `perFacilityRate` from `getRawSourceRate(itemId, item)` so pump-rate overrides (60/min vs. pipe's 120/min) are honoured.
- DO NOT propagate the full `scc.items` set to every bin hosting an SCC recipe. Phase 1 (`propagatePrefillCandidates` in `src/lib/calculator.ts`) runs Tarjan SCC on each bin's intra-recipe graph and flags only items in genuine intra-bin SCCs. Intermediate items in larger recipe-graph cycles (Carbon Powder, Xiranite Powder, Water, …) bootstrap automatically and must not appear as prefill chips.
- DO NOT filter intra-bin cycle items per-item against `bin.externalInputs`. The cycle bootstraps from EITHER side — a single externally-supplied half is sufficient because flow into that port lets one recipe in the SCC run, producing the other cycle items internally on the next cycle. Phase 1's per-CYCLE external-entry check (skip iff ANY cycle item is in `externalInputs`) is the right granularity. Re-introducing per-item filtering would re-emit false-positive Sewage chips on the Xircon-60 3-formula Crucible bin (where Sewage is internal but Xircon Effluent provides the entry point).
- DO NOT detect intra-bin cycles via pair iteration over the recipe-graph SCC. Intra-bin cycle structure is a property of the bin's local recipe graph, not the global SCC; a 3-recipe intra-bin cycle has no 2-cycle sub-pair and would be missed. Use Phase 1's per-bin Tarjan instead. Inter-bin 2-cycles are still detected via pair iteration in Phase 2; T4 (3+ recipe inter-bin cycle) is a documented limitation with a defensive DEV log.
- DO NOT emit an inter-bin prefill chip for a 2-cycle when EITHER of its items is reachable from raws via the active recipe set. The other half becomes bootable downstream once any genuinely-stuck inner SCC (e.g. planter ↔ seedcollector) is seeded. The "both non-bootable" guard in Phase 2 enforces this — in Xircon-60, Furnace producing Sewage from raws masks the inter-bin (Effluent-Prod, Xircon-Prod) cycle when it spans Bin 1 + Bin 0.
- DO NOT pass `forcedRawMaterials` directly to `propagatePrefillCandidates`. The plan's `graph.rawMaterials` (built by `graph-builder` as the union of `forcedRawMaterials` + `manualRawMaterials` + items chain-terminated by AIC / override constraints) is the authoritative raw set for THIS plan. Using `forcedRawMaterials` alone silently drops the user's `m=` URL flags, causing the bootability fixpoint to miss manual raws and emit false-positive prefill chips (e.g. Sewage flagged on a Crucible bin even when the user explicitly marked Sewage raw and the LP pumps it from a pickup). The function signature requires `rawMaterials` as a positional parameter to force this discipline.
- DO NOT add ad-hoc `console.log` to `src/lib/flow-solver.ts` or `src/lib/graph-builder.ts`. Both carry heavy debug instrumentation already. Gate new logging behind `import.meta.env?.DEV`.
- DO NOT iterate `scc.recipes` in rendering / prefill code without filtering to `activeRecipeIds` first. Inactive alternatives (e.g. `pool_xiranite_poly_2` when the LP picked tier 1, `planter_plant_moss_1_1` when the LP picked grass) sit in the SCC's recipe set because the multi-recipe graph traversal added them, but they don't run and the packer correctly doesn't allocate bins for them. Walking them triggers `[resolveBinInfo] ... has no bin allocation` warnings. The `detectedCycles` loop in `calculator.ts` is the canonical filter pattern.
- DO NOT use `line.item.id` alone as a React `key` for table rows. Under the row-per-producer mixed-strategy model (`mergeItemNodes` in `useProductionTable.ts`), an item may emit multiple rows sharing the same `item.id`; the recipe id must be included in the key (`${item.id}-${recipeId}`) to disambiguate sister rows.
- DO NOT add a graph-side selection heuristic (i.e. re-introduce `selectRecipe`) to bypass an "unwanted" LP pick. The global LP picks recipes by the lex objective; if the result is wrong, fix the objective (`rawCost`, `buildingCount`, `power`, the `costlessRaws` set) — don't paper over it in graph-builder.
- DO NOT set `elk.layered.priority.direction` to a negative value. Lower bound is 0; values below are silently clamped.

## Terminology

- `targetRate` (flow node) — per-recipe per-output rate, `calcRate(output.amount, t) * facilityCount`. **Not** the user's request.
- `userTargetRate` / `targetRates: Map<ItemId, number>` — what the user requested via the UI.
- `Bin` — packed unit. **Singleton** bin: 1 recipe. **Grouped** bin: 2+ recipes co-located in a multi-formula building, sharing inner inventory and port budget.
- **Internal items** — items balanced within a bin (no external port consumption); hidden from edges in bin-fused view.
- **"Backward" edge** — producer and consumer in the same SCC; tagged for distinct visual rendering.

## Internationalization

7 languages via i18next at `public/locales/{lang}/{namespace}.json`. The `recipe` namespace is regenerated by `bun run extract:recipes` from game data — do not hand-edit. Other namespaces are hand-maintained.

## Commit convention

- `Add:` new feature
- `Fix:` bug fix
- `Update:` enhancement to existing feature
- `Refactor:` code restructuring
