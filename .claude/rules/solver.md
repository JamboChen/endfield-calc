---
paths:
  - "src/lib/lp-solver.ts"
  - "src/lib/flow-solver.ts"
  - "src/lib/calculator.ts"
  - "src/lib/graph-builder.ts"
  - "src/lib/recipe-reachability.ts"
  - "src/tests/lib/lp-solver.test.ts"
  - "src/tests/lib/calculator.test.ts"
  - "src/tests/lib/recipe-reachability.test.ts"
---

# LP / flow / graph layer invariants

The planner is a single global LP over every recipe in the multi-recipe graph. `calculator.ts:calculateProductionPlan` orchestrates it. The pipeline:

1. `graph-builder.ts:buildBipartiteGraph` — multi-recipe traversal, all alternative producers per item; **then** `injectDisposalRecipesIntoGraph` pulls in zero-output / forced-disposal-only-output recipes for any forced-disposal item in the graph (Liquid Cleaner + Sewage Inlet variants).
2. `graph-builder.ts:detectSCCs` — Tarjan; kept for rendering and prefill detection.
3. `flow-solver.ts:calculateFlows` — builds the global LP, calls `solveLP`.
4. `multi-formula-packing.ts:packBins` — see `.claude/rules/packer.md`.
5. `calculator.ts:propagatePrefillCandidates` — see `.claude/rules/prefill.md`.
6. `calculator.ts:buildProductionGraph` — filters to active subgraph for rendering.

The old post-LP `injectDisposalRecipes` step is gone. Disposal recipes live in the LP itself; the lex objective picks Sewage Inlet (0W) over Liquid Cleaner (50W) up to the facility cap and falls back to Cleaner for any spillover.

## Lex LP (recipe selection)

`solveLP` minimises in order `rawCost → buildingCount → power` (`lp-solver.ts:43-59`). Each pass adds an upper-bound cap from the prior optimum with `LEX_TOLERANCE` slack (`lp-solver.ts:68-72`: `rawCost: 1e-6`, `buildingCount: 1e-3`, `power: 1e-3`).

Constants (verified):

- `FACILITY_COUNT_EPSILON = 1e-6` (`lp-solver.ts:40`). Clamps tiny LP outputs to zero — defends against HiGHS degenerate-vertex artefacts. Subsumes the old `SURPLUS_EPSILON` (formerly in `injectDisposalRecipes`, now removed).
- `SLACK_PENALTY = 1e6` (`lp-solver.ts:81`). Cost coefficient on `disposal-slack` vars (both `slack_def` and `slack_sur`) in every objective.
- `POWER_COST_FLOOR = 1e-4` (`lp-solver.ts:89`). Tiny positive baseline so zero-power recipes stay bounded under the power pass.
- `LP_EPSILON = 1e-9` (`lp-solver.ts:23`). Sign/equality checks against LP output.

`costlessRaws` (`src/data/index.ts`) is derived as `items.filter(isLiquid) ∩ rawMaterialSources.keys()` → currently `{item_liquid_water, item_liquid_acid}`. These contribute 0 to `rawCost` so the LP doesn't bias against recipes that consume them. Set auto-extends if game data adds a new liquid raw.

## LP item-constraint selection (`flow-solver.ts`)

- **User targets** (not forced-disposal) → `min: targetRate` (surplus allowed).
- **Forced-disposal items WITH a consumer in the graph** → `disposal-slack: targetRate ?? 0`. Strict equality (`prod - cons + slack_def - slack_sur = rhs`), both slacks penalised at `SLACK_PENALTY`. Forces the LP to exactly hit the target rate AND dispose every unit produced beyond it via the available disposer recipes. Surplus reported in `disposalSurpluses`, deficit in `disposalDeficits`.
- **Forced-disposal items WITHOUT a consumer in the graph** → fall back to `min: 0`. Strict equality is meaningless without a disposer (slack would always engage), so surplus is permitted.
- **Raws** (forced + manual + chain-terminated) → excluded from balance (infinite-supply).
- **Other intermediates** → `min: 0` (LP cost-minimisation drives surplus to 0 in optimal; `min` is robust against multi-output recipes whose byproducts have no consumer — `equal: 0` would refuse to run them).

## Facility caps (LP + packer)

`facilityCaps?: ReadonlyMap<FacilityId, number>` threads end-to-end:
- App.tsx aggregates AIC `effectiveCaps` + structures `solver.role === "instance"` per active domain.
- `calculator.ts` forwards it to `buildBipartiteGraph` (for the variant-recipe filter) AND to `calculateFlows` AND to `packBins`.
- `lp-solver.ts` emits per-facility constraint `Σ_{r : r.facilityId === F} x_r ≤ cap` (`faccap_*_${facilityId}`). Hard constraint, no slack.
- The packer's existing per-facility cap block (`multi-formula-packing.ts:879-889`) stays in place as defence-in-depth and as the source of `computeOverCapWarnings`.

Cap = 0 explicitly forbids any use of the facility; absence leaves it unconstrained. This is load-bearing for the `facilityRecipeVariants` filter in `calculator.ts:840-855`: variant recipes (today: `LIQUID_CLEAN_GATE_1_*`) are dropped entirely when their facility cap is absent or 0, so an unfiltered `recipes` array (typical of tests) doesn't accidentally enable them.

## Disposal-recipe pre-LP injection (`graph-builder.ts:injectDisposalRecipesIntoGraph`)

Target-rooted traversal never adds zero-output disposal recipes (Liquid Cleaner; Sewage Inlet DISPOSAL variant) because they don't produce any item. Sewage Inlet BYPRODUCT (which DOES produce `xiranite_poly`) might or might not be discovered depending on whether `xiranite_poly` is reachable from a target. The post-traversal injection pass fixes this:

For every forced-disposal item in the graph (excluding raws), enumerate every recipe consuming it whose outputs are either empty OR entirely in `forcedDisposalItems`. Add those recipes to the graph. Cascade: their forced-disposal outputs (if any) are queued so a chain like `sewage → xiranite_poly → (cleaner)` terminates at a true sink.

Filters honoured by the injection:
- `recipeConstraints` (per-output and per-input — covers the zero-output case where the per-output check yields nothing).
- `optInVariantRecipeIds`: recipes from `facilityRecipeVariants` whose facility has no positive cap are skipped, so LIQUID_CLEAN_GATE_1 variants only appear when the user explicitly enables them.

The injection is defensive against direct callers: `calculator.ts` also filters `maps.recipeMap` up-front via the same `optInVariantRecipeIds` rule, so tests that pass the unfiltered `recipes` array stay aligned with App-layer behaviour.

## Disposal-deficit → invalid-SCC translation

When the LP is `feasible` but a `disposal-slack` variable absorbs positive deficit, the constraint couldn't be satisfied without slack — operationally a phantom plan. `flow-solver.ts:213-238` maps each non-zero deficit back to the containing SCC and emits `InvalidSCCInfo`. Deduped by `sccId`. Defensive DEV log fires if a deficit item has no containing SCC (would mean a future game-data shift produced a non-cyclic deficit).

## `itemDemands` netting rules (`flow-solver.ts:240-286`)

Post-LP, gross consumption and gross byproduct production are summed **separately** across recipes, then `itemDemands[rawItem] = max(0, gross - byproduct)`. Per-recipe interleaved netting would zero out negative intermediates and lose the byproduct credit whenever a producer is processed before its consumers. This is the source of truth for the pickup-count layer.

## `availableProducersFor` (`graph-builder.ts:42-77`)

Order is load-bearing:
1. Filter to recipes that output `itemId`.
2. **Recipe pin wins outright** (`recipeOverrides`) — narrows to just the pinned recipe if it survives, else falls through.
3. AIC / per-plan exclusions (`recipeConstraints`).
4. Per-item dismantler fallback: drop dismantle recipes iff a non-dismantle producer survives.

## Recipe reachability + bootstrap (`recipe-reachability.ts`)

`computeRecipeReachability` does two-phase closure:
1. **Bootstrap pass**: recipes on a `bootstrapFacilities` member are unconditionally runnable; their outputs join `reachableItems` before fixpoint.
2. **Fixpoint pass**: until no change, mark a recipe runnable iff all inputs are in `reachableItems`.

`bootstrapFacilities` (`src/data/index.ts:127`, currently `{seedcollector_1}`) is the App-layer mechanism. The prefill-detection layer (`computeBootableItems` in `calculator.ts:155`) intentionally does NOT use bootstrap — bootstrap is a planning-layer concept ("can the user configure this plan?"), prefill is runtime ("does the cycle need a kickstart?"). Both are simultaneously true for planter↔seedcollector.

**Manual raws do NOT feed the App-layer reachability closure** — they're a plan-specific calc-time hint, not a configuration-level capability.

## Active-subgraph filter

`calculator.ts:660-676` builds the active subgraph: only recipes with `facilityCount > 0` (`fc > 0` at line 668) make it into `plan.nodes`. Inactive alternatives stay in `graph.recipeNodes` but are dropped — else isolated zero-throughput recipe nodes appear in mappers and trip `assertFlowIntegrity`.

`detectedCycles` (in `calculator.ts`) iterates active recipes only (filtered by `activeRecipeIds`). Walking `scc.recipes` without this filter trips `[resolveBinInfo] ... has no bin allocation` warnings for recipes the packer correctly didn't allocate.

## User-pinned recipe outcomes (UI must handle all four)

- **Effective pin** — pinned recipe ends up in `plan.nodes` with `fc > 0`. Normal row.
- **Vacuously ineffective pin** — pinned recipe has `fc = 0` (pinned item also produced as a byproduct of another active recipe). Detected in `useProductionPlan.ts:571` via `!plan.nodes.has(pinnedRecipeId)`. Surfaced as ghost rows. Check is exact — no thresholding — because `FACILITY_COUNT_EPSILON` and the `fc > 0` filter already provide the threshold semantics.
- **Deficit-inducing pin** — LP reports feasible but `disposalDeficits` (the `slack_def` side of the two-sided disposal slack) is non-empty (classic case: pin a dismantle recipe whose corresponding FILLING recipe consumes the same item, forming a bottle ↔ fbottle loop). Translated to `invalidSCCs`, existing cycle-warning pipeline fires. Recovery: drop the pin, or mark the cycle's fbottle as a manual raw.
- **Surplus-only**: when `disposalSurpluses` (the `slack_sur` side) is non-empty but `disposalDeficits` is empty, the LP wanted to dispose more than the available disposers could handle (e.g. LIQUID_CLEAN_GATE_1 capped at N while sewage production exceeds N×120/min and Liquid Cleaner is unavailable in the current domain). Currently logged at DEV; not yet surfaced as a user warning — add a translation pass mirroring the deficit→invalidSCCs flow if a real scenario hits it.
- **LP-infeasible pin** — `invalidCycles` populated, warning surfaces immediately.

## DO NOT

- DO NOT call `highsSolve` directly from outside `solveLP` / `solvePacking`. The wrappers handle raw-material exclusion, lexicographic passes, slack handling, recipe pinning, tolerance, and the solver timeout.
- DO NOT add ad-hoc `console.log` to `flow-solver.ts` or `graph-builder.ts`. Both carry heavy debug instrumentation already; gate new logging behind `import.meta.env?.DEV`.
- DO NOT iterate `scc.recipes` in rendering / prefill code without filtering to `activeRecipeIds` first. Inactive alternatives (e.g. `pool_xiranite_poly_2` when the LP picked tier 1) sit in the SCC's recipe set but don't run; walking them trips `[resolveBinInfo]` warnings.
- DO NOT add a graph-side selection heuristic to bypass an "unwanted" LP pick. The global LP picks recipes by the lex objective; if the result is wrong, fix the objective (`rawCost`, `buildingCount`, `power`, the `costlessRaws` set).
- DO NOT introduce a threshold or epsilon to detect "ineffective pin" in `useProductionPlan.ineffectivePins`. The predicate is exact: `!plan.nodes.has(pinnedRecipeId)`. The clamp at `lp-solver.ts:379` and the filter at `calculator.ts:668` already provide the thresholding semantics.
- DO NOT silently drop non-zero `result.disposalDeficits` from `flow-solver.ts`. Each non-zero deficit MUST be translated to an `InvalidSCCInfo` so the cycle-warning pipeline fires. The defensive DEV log for "deficit on item with no containing SCC" is the canary — keep it.
- DO NOT pass `manualRawMaterials` to `computeRecipeReachability`'s App-layer call. Manual raws are calc-time only; the AIC menu/availability layer reads `forcedRawMaterials` + `bootstrapFacilities` only.
- DO NOT re-introduce a post-LP `injectDisposalRecipes` step. The LP itself sizes disposers via the two-sided disposal-slack constraint + pre-LP `injectDisposalRecipesIntoGraph` in graph-builder. Reintroducing post-LP injection would double-count and break the lex-optimal disposer selection.
- DO NOT add a recipe whose `facilityId` is in `facilityRecipeVariants` without also adding a corresponding `default`/`toggled` entry to that map. The `calculator.ts` filter assumes every variant facility has both entries; an orphan recipe would silently never enter the LP.
