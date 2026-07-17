---
paths:
  - "src/lib/lp-solver.ts"
  - "src/lib/flow-solver.ts"
  - "src/lib/calculator.ts"
  - "src/lib/graph-builder.ts"
  - "src/lib/recipe-reachability.ts"
  - "src/lib/highs-wrapper.ts"
  - "src/lib/highs-singleton.ts"
  - "src/lib/calc-client.ts"
  - "src/lib/target-optimizer.ts"
  - "src/workers/calc.worker.ts"
  - "src/tests/lib/lp-solver.test.ts"
  - "src/tests/lib/lp-solver-status.test.ts"
  - "src/tests/lib/calculator.test.ts"
  - "src/tests/lib/recipe-reachability.test.ts"
  - "src/tests/lib/highs-wrapper.test.ts"
  - "src/tests/lib/calc-client.test.ts"
  - "src/tests/lib/target-optimizer.test.ts"
---

# LP / flow / graph layer invariants

The planner is a single global LP over every recipe in the multi-recipe graph. `calculator.ts:calculateProductionPlan` orchestrates it. The pipeline:

1. `graph-builder.ts:buildBipartiteGraph` — multi-recipe traversal, all alternative producers per item; **then** `injectPowerBurnRecipes` (only when `options.powerSustain` is set — injects each available fuel's zero-output Thermal Bank burn recipe and `traverse`s the fuel's chain in; MUST run before disposal injection so battery-chain byproducts get disposers); **then** `injectDisposalRecipesIntoGraph` pulls in zero-output / forced-disposal-only-output recipes for any forced-disposal item in the graph (Liquid Cleaner + Sewage Inlet variants).
2. `graph-builder.ts:detectSCCs` — Tarjan; kept for rendering and prefill detection.
3. `flow-solver.ts:calculateFlows` — builds the global LP, calls `solveLP`.
4. `multi-formula-packing.ts:packBins` — see `.claude/rules/packer.md`.
5. `calculator.ts:propagatePrefillCandidates` — see `.claude/rules/prefill.md`.
6. `calculator.ts:buildProductionGraph` — filters to active subgraph for rendering.

The old post-LP `injectDisposalRecipes` step is gone. Disposal recipes live in the LP itself; the lex objective picks Sewage Inlet (0W) over Liquid Cleaner (50W) up to the facility cap and falls back to Cleaner for any spillover.

## Lex LP (recipe selection)

`solveLP` minimises in order `rawCost → buildingCount → power` (`lp-solver.ts:74`). Each pass adds an upper-bound cap from the prior optimum with `LEX_TOLERANCE` slack (`lp-solver.ts:86`: `rawCost: 1e-6`, `buildingCount: 1e-3`, `power: 1e-3`).

Constants (verified):

- `FACILITY_COUNT_EPSILON = 1e-6` (`lp-solver.ts:50`). Clamps tiny LP outputs to zero — defends against HiGHS degenerate-vertex artefacts. Subsumes the old `SURPLUS_EPSILON` (formerly in `injectDisposalRecipes`, now removed).
- `SLACK_PENALTY = 1e6` (`lp-solver.ts:116`). Cost coefficient on `disposal-slack` vars (both `slack_def` and `slack_sur`) in every objective.
- `POWER_COST_FLOOR = 1e-4` (`lp-solver.ts:154`). Tiny positive baseline so zero-power recipes stay bounded under the power pass.
- `LP_EPSILON = 1e-9` (`lp-solver.ts:33`). Sign/equality checks against LP output.

`costlessRaws` (`src/data/index.ts`) is derived as `items.filter(isLiquid) ∩ rawMaterialSources.keys()` → currently `{item_liquid_water, item_liquid_acid}`. These contribute 0 to `rawCost` so the LP doesn't bias against recipes that consume them. Set auto-extends if game data adds a new liquid raw.

## Solver transport + failure semantics

- **Worker transport** (`calc-client.ts` + `workers/calc.worker.ts`): `calculateProductionPlan` runs in a module worker; the worker file is transport-only (business logic stays in `@/lib/calculator` / `@/lib/target-optimizer`). The client enforces **latest-wins coalescing** — one inflight job + one parked SOLVE slot; a displaced parked solve rejects with `CalcSupersededError`, which callers treat as "ignore silently". **Optimizer searches are single worker jobs** (`searchMaximize` / `searchFit`) with their OWN parked slot, dispatched ahead of a parked solve — searches can never displace a display calc (see `.claude/rules/optimizer.md` for the search contract + cancellation). A worker **crash re-dispatches the inflight job** (fresh worker, then main-thread fallback) instead of rejecting the caller — except a search whose `cancelled` flag is set, which resolves `{ kind: "cancelled" }` rather than transparently re-running a 30s search; the **per-job retry budget** (`retries`) is load-bearing because the global `workerFailures` counter resets on every successful init — without it a request that deterministically crashes a fresh worker would loop forever. Crash retries re-dispatch the SAME job object with a fresh `seq`; dispatch-generation guards (`isCurrent`) key on job identity AND seq. Main-thread fallback engages when `Worker` is undefined (vitest/node) or a budget is exhausted; fallback searches run the same engines via dynamic import, polling the job's `cancelled` flag.
- **Cumulative run clock** (`highs-wrapper.ts`): the HiGHS WASM instance checks `time_limit` against a clock that accumulates across every solve and cannot be reset. The wrapper sets `time_limit = accumulatedSolveSeconds + perSolveBudget` on EVERY solve (`highs-wrapper.ts:165`, WeakMap keyed on instance identity). Setting a bare per-solve limit starves later solves.
- **Self-heal seam** (`highs-singleton.ts`): `highs-wrapper.solve` awaits `initHighs()` per call; on parse/solve throw or a returned `error`/unknown status it calls `resetHighs()` so the next call gets a fresh instance — the fix for the "frozen until refresh" wedged-WASM failure mode.
- **`plan.lpStatus` threading**: `"ok" | "infeasible" | "solver_error"`. Infeasible is a **verdict** (proven no-solution); solver_error is **evidence** (the solver itself failed). A later-pass solver_error falls back to the previous pass's `lastSolution` and reports `ok` (a real optimum exists); a first-pass failure surfaces as `solver_error`. The optimizer's `probeVector` **throws** on solver_error rather than counting it as infeasible — a wedged solver must never corrupt a bisection bracket. Pinned by `lp-solver-status.test.ts`.
- **Optimizer** (`target-optimizer.ts`): pure bisection engine on an integer milli-rate grid; the solve closure is injected (in production: the worker runs the engines with a direct `calculateProductionPlan` call; tests inject it directly). `isPlanFeasible` is a pure warning scan — the calculator emits every limit violation into `plan.warnings` (see `.claude/rules/optimizer.md`). Semantics, pass structure, and cancellation contract: the module JSDoc (canonical — read it before editing the engine).

## LP item-constraint selection (`flow-solver.ts`)

- **User targets** (not forced-disposal) → `min: targetRate` (surplus allowed).
- **Forced-disposal items WITH a consumer in the graph** → `disposal-slack: targetRate ?? 0`. Strict equality (`prod - cons + slack_def - slack_sur = rhs`), both slacks penalised at `SLACK_PENALTY`. Forces the LP to exactly hit the target rate AND dispose every unit produced beyond it via the available disposer recipes. Surplus reported in `disposalSurpluses`, deficit in `disposalDeficits`.
- **Forced-disposal items WITHOUT a consumer in the graph** → fall back to `min: 0`. Strict equality is meaningless without a disposer (slack would always engage), so surplus is permitted.
- **Raws** (forced + manual + chain-terminated) → excluded from balance (infinite-supply).
- **Other intermediates** → `min: 0` (LP cost-minimisation drives surplus to 0 in optimal; `min` is robust against multi-output recipes whose byproducts have no consumer — `equal: 0` would refuse to run them).

## Metastorage imports (LP + auto-selection)

The game's Metastorage Transfer ships **one item type per source region** per hourly delivery, bounded by a TTV budget (`src/data/metastorage.ts`, AUTO-GENERATED by `extract:metastorage`). Modeled as LP **import variables**, never as fake recipes (brand discipline + "recipe = physical building" invariants):

- `LPInput.metastorageImports` — one route = one `metaimp_*` var (`+1` on the item's balance row) + a budget row `cost×rate − slack ≤ budgetPerMinute`. Routes on raws / `disposal-slack` items / `cost ≤ 0` are filtered by `eligibleImportRoutes`.
- **Slack-penalty ordering is load-bearing**: the budget slack carries `TTV_SLACK_PENALTY = 1e8` ≫ `SLACK_PENALTY = 1e6` (raw caps / facility caps / disposal). Raw and facility caps stay soft in the LP so over-demand plans remain solvable and diagnosable (warn-only — calculator-emitted `plan.warnings`) — note facility caps ARE hard placement limits in-game (the game refuses building N+1); the softness is a solver-UX choice, not a game fact. The TTV budget is a GAME constant. At equal penalties, a demand that must violate *some* soft constraint becomes a degenerate tie (e.g. 1 Steel Part/min over = 2 ore raw-slack locally = 2 TTV budget-slack imported) and HiGHS can route the violation into the physically impossible valve (user-reported: "Steel Part 1800/1500 per delivery" while their soft Ferrium Ore cap had headroom semantics). The ordering makes `ttvOveruse` a pure impossibility diagnostic: non-zero ⟺ import-only demand above budget, no within-budget solution exists.
- **Viability gate** (`selectMetastorageImports`): candidates with `metrics.ttvOverusePerMinute > 0` are never selected — over-budget imports never reach a final plan. The closest-to-possible rejection per route becomes a `metastorage-budget-insufficient` PlanWarning (per-cycle needed vs cap figures); the plan comes out honestly infeasible.
- **`ttvCost` final lex pass** (only when import vars exist): zeroes useless imports, prefers cheaper-TTV solutions. Its caps re-anchor on the previous pass's ACTUAL solution with `TTV_PASS_CAP_TOLERANCE = 1e-6` — NOT the per-pass optima with loose tolerances (a 1e-3 buildings cap lets the pass trade phantom sub-tolerance buildings for TTV). The anchored power cap MUST go through `coefficientConsistentTotal` (adds `POWER_COST_FLOOR × buildings`; `totalPower` alone excludes the floor and would exclude the anchor solution itself).
- **Auto-selection** lives in `calculator.ts:selectMetastorageImports`: sequential greedy per route; candidates = eligible ∩ graph balance-row items that are targeted or consumed, `ItemId`-sorted; one `calculateFlows` per candidate; lex comparison `compareSolveMetrics` (feasible → slackMagnitude → rawCost → buildings → power → TTV, `METASTORAGE_METRIC_TOLERANCE` epsilons); strict improvement required so the no-import baseline wins ties.
- `buildBipartiteGraph(..., importableItems)` — producer-less importable items stay **balanced** (no raw auto-promotion); promoting them would grant infinite free supply and bypass the budget.
- Zero-variable LPs with a positive non-raw demand are **infeasible, not vacuous** (`solveLP` early-return scans constraints; `flow-solver`'s no-op early return requires all targets raw). Reachable since import-only targets exist.
- **Route-conflict detection** (`necessaryImportOnlyItems` + `canRoutesCoverItems`): compute the import-only items the plan *provably* needs via a necessity fixpoint from the targets (an item is necessary if it's an input to **every** surviving producer of an already-necessary item — sound under-approximation, no false positives; covers import-only intermediates, not just targets). Each source carries one item type per delivery (`routeNum: 1`), so feasibility is a bipartite matching (items ↔ routes, Kuhn's). No full matching → `metastorage-route-conflict` PlanWarning listing the competing items.
- **Known limitation** (unreachable in 1.x single-route data): `selectMetastorageImports` is a sequential greedy keyed on whole-plan feasibility, so it can't bootstrap a plan that's infeasible until ≥2 *separate-route* imports are added jointly (neither alone flips feasibility → neither ranks above the infeasible baseline; infeasible solves carry no deficit to rank by). Single import-only targets work (the one route flips the whole plan feasible). A forced-assignment pre-seed would fix it but risks the hard-budget invariant; defer until multi-route data exists to validate against.
- Plan output: `plan.metastorageImports` (per-minute rates + `cycleSeconds` for per-delivery display). Item-node `productionRate` stays LOCAL-only — imports never fold into it; `filterPlanForDisplay` (`plan-helpers.ts`) exempts imported items from the zero-rate drop so import-only intermediates survive into the table + merged graph.

## Self-sustaining power (`powerSustain` + the `power_balance` row)

`CalculateProductionPlanOptions.powerSustain = { fuels }` (App passes `powerFuels` from `@/data/power.ts`, AUTO-GENERATED by `extract:power`; tests pass synthetic fuels). One fuel = a zero-output burn recipe on `power_station_1` + an out-of-band `powerGeneration` (watts while one bank burns it). Batteries only — ore burning is deliberately excluded (50 W/bank would suggest absurd bank counts).

- **Injection guard is load-bearing** (`graph-builder.ts:injectPowerBurnRecipes`): a fuel is injected only if its item is producible / raw / manual-raw / importable, checked BEFORE `traverse` — otherwise the chain-leaf rule would auto-promote an unproducible battery to a free raw = free power. All fuels skipped ⇒ `power-sustain-unavailable` PlanWarning and NO balance row.
- **The LP rows are SOFT, one tier BELOW the user caps**: `power_balance + slack ≥ 0` with per-recipe coefficient `generation − powerConsumption − pumpPower` (`lp-solver.ts:buildModel`). Pump power charges each recipe for its raw inputs' source-facility watts (`pumpPowerPerItemRate`, built in `flow-solver.ts` from `rawMaterialSources` — mirrors `aggregateBinTotals`' pickup fold). Power is linear in `x_r`, so the circular "batteries need buildings that need power" fixed point solves exactly in one pass.
- **Slack-penalty tier ordering is load-bearing** (`POWER_SLACK_PENALTY = 1e2` per watt): `real lex costs (≈0.2/W) ≪ POWER_SLACK 1e2 ≪ raw/facility-cap SLACK_PENALTY 1e6 ≪ TTV_SLACK_PENALTY 1e8`. Battery production is a SUGGESTION — it is funded exclusively from headroom UNDER the user's raw/facility caps, never by violating them (user-reported regression: hard power rows pushed a maxed 540 ore cap to 700). One shared `power_slack` variable (+1 on both power rows) absorbs the unaffordable remainder at `max(balance deficit, floor deficit)` — penalized and reported once as `LPSolution.powerShortfall` → `metrics.powerShortfall` → the `power-sustain-insufficient` PlanWarning (watts re-anchored on the final plan's ceil aggregates after the loop). Magnitude bound: watts-per-raw-unit must stay < `SLACK_PENALTY / POWER_SLACK = 1e4` (densest battery ≈ 2133 W — 4.7× margin). Consequence: "can't self-power at any scale" is no longer `lpStatus: "infeasible"` — it's a best-effort plan + warning.
- **Cross-solve, the same lattice is re-stated structurally, never by summing units**: `powerShortfall` (watts) is its OWN key in `compareSolveMetrics` — `feasible → slackMagnitude → powerShortfall → rawCost → buildings → power → ttvUsed` — and is deliberately NOT folded into `slackMagnitude` (items/min scale). Folding it once let the Metastorage selection trade a 50 ore/min cap violation for a token 367 W of generation (user-reported: toggling power flipped the Valley IV route from originium powder to battery_3, ore 540→590). Any future soft tier gets its own comparison key at the position matching its LP penalty tier.
- **Over-limit warning kinds have ONE source of truth**: `OVER_LIMIT_WARNING_KINDS` (`plan-helpers.ts`) = `{facility-over-cap, raw-over-cap, metastorage-budget-insufficient, power-sustain-insufficient}`. Every kind in the set is emitted INTO `plan.warnings` by `calculateProductionPlan` itself (the cap kinds via `computeLimitViolations` at plan assembly), so `isPlanFeasible` (Fit scales unlocked targets, Max treats the limit as a ceiling) and the hook's `planOverLimit` (Fit pill / auto-fit) are both plain warning scans of the same plan. Enrolling a new limit = emit its warning in the calculator + add the kind to the set. See `.claude/rules/optimizer.md`.
- **Ceil-floor loop** (`calculator.ts`, after `assemblePlan`): the balance row covers FRACTIONAL consumption, but players build whole buildings — a deep chain with many partially-loaded buildings out-draws fuel-limited generation by hundreds of watts in the physical view (user-reported: 513 W). After packing, the loop measures `aggregateBinTotals(plan, …, { ceilMode: true }).totalPower` (SSOT — never re-sum) and re-solves with that figure as the `power_floor` row (`LPPowerBalance.minGeneration`: `Σ generation_r × x_r + slack ≥ minGeneration`, softened by the shared `power_slack`), iterating to the discrete fixed point (monotone floor, `MAX_POWER_FLOOR_ITERATIONS = 5`, `POWER_FLOOR_TOLERANCE = 0.25` W, no-progress guard, **affordability stop**: `powerShortfall > tolerance` ⇒ raising the floor further can't help — break, keep the warning-carrying plan; typical convergence = 1 extra pass). Also covers consumption the LP can't see structurally (raw-only targets' pickup pumps). **Deliberately NOT gated on the display-layer `ceilMode` flag** — the plan must never depend on display state (toggling "Round up facilities" must not re-solve or invalidate Max marks); the fractional view just shows generation headroom. Metastorage item selection runs once (first pass); iterations reuse the selected imports. On cap-out/failed re-solve the last good plan returns and the hook's deficit warning is the safety net. Cost: ~1 extra LP+pack pass; ~+25 ms simple plans, ~+250 ms pool-heavy (packer-ILP-dominated). Known future lever if optimizer searches feel slow: let probes skip the loop (fractional-only feasibility, bounded drift).
- The row is only added when a generator recipe is present in THIS LP (else `Σ −power·x ≥ 0` freezes every powered recipe). Do NOT name it `power` — constraint names share the coefficient record with objective keys and `power` is the pass-3 objective.
- **Targeted batteries are never burned**: target constraints are `min: rate` on NET production, so burn consumption is always extra production on top.
- Burn recipes ride the options bag, NOT the `recipes` roster (they bypass App-layer availability filters); `calculator.ts` registers them into `maps.recipeMap`, and the bin-fused mappers seed `recipeById` from `plan.nodes` as fallback (the App passes `availableRecipes`, which excludes them).
- Recipe nodes carry `powerGeneration` (set by `buildProductionGraph`); they are ALSO `isDisposal` (zero outputs) — display consumers must check `powerGeneration` first. `aggregateBinTotals.totalPowerGeneration` is the fuel-limited figure: fractional banks in BOTH ceil modes (a ceiled idle bank generates nothing), sized by the ceil-floor loop to cover the ceiled consumption.

## Gas sustain (1.4: transmuter catalyst + vaporizer environments)

ALWAYS ACTIVE (hard game facts, unlike the opt-in `powerSustain`); `options.gasSustain` overrides exist for tests (`{ drains: new Map(), vaporizerEnvs: new Map() }` disables). Data: `src/data/gas-sustain.ts` (AUTO-GENERATED, `extract:sustain`). Tests: `gas-sustain.test.ts`.

- **Catalyst folding** (`calculator.ts:applyCatalystFolding`): every recipe on a `facilitySustainDrains` facility (transmuter_1 → Liquid Xiranite, transmuter_2 → Xiragen, 6/min each) is CLONED with the catalyst as an extra input at `basePerCraft = rate × craftingTime / 60`. Gross semantics on purpose — the catalyst enters via dedicated intake ports, and a transmuter recipe that outputs its own catalyst item keeps the full output + gains the input, surfacing the real self-feed cycle to SCC/prefill. The LP/packer/mappers/display all read the clones via `maps.recipeMap`, so flows stay consistent by construction.
- **Idle-drain scale**: the catalyst drains per WHOLE building even when idle (verified in-game). The unified ceil-floor loop sets `k_F = maxCeilSeen_F / N_F` per drain facility and mutates the clones' catalyst amounts in place (`setCatalystScale`) so total consumption = `rate × ceil(N_F)` exactly. On a failed re-solve the scales that produced the surviving plan are RESTORED (`appliedScales`) — the returned plan's recipe amounts must match its flows.
- **Vaporize injection** (`graph-builder.ts`): env-gated recipes (`Recipe.gasEnv`; joins `vaporizerEnvs` by env id) pull the env's synthetic zero-output `vaporize_<gasItemId>` recipe into the graph — same pattern as burn recipes (consumer-only, options-bag not roster, availability guard BEFORE `traverse` so an unsuppliable gas never becomes a free raw, loop-until-stable for nested envs, runs BEFORE disposal injection). Guard failure + an ACTIVE env recipe ⇒ `gas-env-unavailable` PlanWarning (plan understates gas cost; unreachable through the App flow in 1.4 data).
- **Vaporizer min-runs**: `LPInput.recipeMinRates` — HARD `minrun_*` rows `x_r ≥ floor` (no slack; the floored recipes consume gas whose supply is itself soft, so the rows can't make the LP infeasible in practice). The loop sets `floor = ceil(Σ ceil(fc of env-E recipes) / machinesPerVaporizer)` — whole always-on Gas Dispersing Units, 6 gas/min each. `machinesPerVaporizer` (default `DEFAULT_MACHINES_PER_VAPORIZER = 4` in `src/lib/sustain-constants.ts` — UI-safe module, NOT calculator.ts, to keep the solver code-split) is a plan option (URL `mpv`) riding `calcProblem` for probe≡UI parity.
- **Unified loop**: the power ceil-floor loop now converges three monotone whole-building figures per iteration — power floor, catalyst scales, vaporizer min-runs (`MAX_POWER_FLOOR_ITERATIONS = 8`). Vaporize bins render through the existing zero-output disposal flow (`disposal-<recipeId>` sinks); the merged mapper additionally draws pickup→sink edges for RAW-consuming disposal sinks (vaporizers burn raw gas — pre-1.4 no zero-output recipe consumed a raw directly).
- **Integer snap at extraction** (`lp-solver.ts:extractSolution`): recipe counts within `FACILITY_COUNT_EPSILON` of an integer snap to it — re-solve vertex drift (9.000000027) otherwise ceils into a phantom building (isolated-node mapper failures). Consequence: displayed target rates can undershoot by ~1e-5; tests assert `≥ target − 1e-3` or `toBeCloseTo`.

## Facility caps (LP + packer)

`facilityCaps?: ReadonlyMap<FacilityId, number>` threads end-to-end:
- App.tsx aggregates AIC `effectiveCaps` + structures `solver.role === "instance"` per active domain.
- `calculator.ts` forwards it to `buildBipartiteGraph` (for the variant-recipe filter) AND to `calculateFlows` AND to `packBins`.
- `lp-solver.ts` emits per-facility constraint `Σ_{r : r.facilityId === F} x_r ≤ cap + slack` (`faccap_*_${facilityId}`), slack penalized by `SLACK_PENALTY` in every lex pass — soft so demand above `cap × throughput` with no alternative producer stays solvable (warn-only) instead of LP-infeasible.
- The packer's existing per-facility cap block (`multi-formula-packing.ts:868-889`) stays in place as defence-in-depth; only multi-formula (cacheSlots) facilities pass through it. The user-facing warning is emitted by the CALCULATOR at plan assembly (`computeLimitViolations` → `computeOverCapWarnings(aggregates.physicalPerFacility, …)` → `plan.warnings`) — always-ceiled physical placements, catching single-formula fragmentation (fractional 12.0 fits cap 12, but five singleton forge recipes ⇒ 13 placements) that both the LP and the MIP legitimately accept.

Cap = 0 explicitly forbids any use of the facility; absence leaves it unconstrained. This is load-bearing for the `facilityRecipeVariants` filter in `calculator.ts:1216-1223`: variant recipes (today: `LIQUID_CLEAN_GATE_1_*`) are dropped entirely when their facility cap is absent or 0, so an unfiltered `recipes` array (typical of tests) doesn't accidentally enable them.

## Disposal-recipe pre-LP injection (`graph-builder.ts:injectDisposalRecipesIntoGraph`)

Target-rooted traversal never adds zero-output disposal recipes (Liquid Cleaner; Sewage Inlet DISPOSAL variant) because they don't produce any item. Sewage Inlet BYPRODUCT (which DOES produce `xiranite_poly`) might or might not be discovered depending on whether `xiranite_poly` is reachable from a target. The post-traversal injection pass fixes this:

For every forced-disposal item in the graph (excluding raws), enumerate every recipe consuming it whose outputs are either empty OR entirely in `forcedDisposalItems`. Add those recipes to the graph. Cascade: their forced-disposal outputs (if any) are queued so a chain like `sewage → xiranite_poly → (cleaner)` terminates at a true sink.

Filters honoured by the injection:
- `recipeConstraints` (per-output and per-input — covers the zero-output case where the per-output check yields nothing).
- `optInVariantRecipeIds`: recipes from `facilityRecipeVariants` whose facility has no positive cap are skipped, so LIQUID_CLEAN_GATE_1 variants only appear when the user explicitly enables them.

The injection is defensive against direct callers: `calculator.ts` also filters `maps.recipeMap` up-front via the same `optInVariantRecipeIds` rule, so tests that pass the unfiltered `recipes` array stay aligned with App-layer behaviour.

## Disposal-deficit → invalid-SCC translation

When the LP is `feasible` but a `disposal-slack` variable absorbs positive deficit, the constraint couldn't be satisfied without slack — operationally a phantom plan. `flow-solver.ts:335-367` maps each non-zero deficit back to the containing SCC and emits `InvalidSCCInfo`. Deduped by `sccId`. Defensive DEV log fires if a deficit item has no containing SCC (would mean a future game-data shift produced a non-cyclic deficit).

## `itemDemands` netting rules (`flow-solver.ts:369-415`)

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

`bootstrapFacilities` (`src/data/index.ts:245`, currently `{seedcollector_1}`) is the App-layer mechanism. The prefill-detection layer (`computeBootableItems` in `calculator.ts:72`) intentionally does NOT use bootstrap — bootstrap is a planning-layer concept ("can the user configure this plan?"), prefill is runtime ("does the cycle need a kickstart?"). Both are simultaneously true for planter↔seedcollector.

**Manual raws do NOT feed the App-layer reachability closure** — they're a plan-specific calc-time hint, not a configuration-level capability.

## Active-subgraph filter

`calculator.ts:585-587` builds `activeRecipeIds`: only recipes with `facilityCount > 0` (`fc > 0` at line 587) make it into `plan.nodes`. Inactive alternatives stay in `graph.recipeNodes` but are dropped — else isolated zero-throughput recipe nodes appear in mappers and trip `assertFlowIntegrity`.

`detectedCycles` (in `calculator.ts`) iterates active recipes only (filtered by `activeRecipeIds`). Walking `scc.recipes` without this filter trips `[resolveBinInfo] ... has no bin allocation` warnings for recipes the packer correctly didn't allocate.

## User-pinned recipe outcomes (UI must handle all four)

- **Effective pin** — pinned recipe ends up in `plan.nodes` with `fc > 0`. Normal row.
- **Vacuously ineffective pin** — pinned recipe has `fc = 0` (pinned item also produced as a byproduct of another active recipe). Detected in `useProductionPlan`'s `ineffectivePins` memo via `!plan.nodes.has(pinnedRecipeId)`. Surfaced as ghost rows. Check is exact — no thresholding — because `FACILITY_COUNT_EPSILON` and the `fc > 0` filter already provide the threshold semantics.
- **Deficit-inducing pin** — LP reports feasible but `disposalDeficits` (the `slack_def` side of the two-sided disposal slack) is non-empty (classic case: pin a dismantle recipe whose corresponding FILLING recipe consumes the same item, forming a bottle ↔ fbottle loop). Translated to `invalidSCCs`, existing cycle-warning pipeline fires. Recovery: drop the pin, or mark the cycle's fbottle as a manual raw.
- **Surplus-only**: when `disposalSurpluses` (the `slack_sur` side) is non-empty but `disposalDeficits` is empty, the LP wanted to dispose more than the available disposers could handle (e.g. LIQUID_CLEAN_GATE_1 capped at N while sewage production exceeds N×120/min and Liquid Cleaner is unavailable in the current domain). Currently logged at DEV; not yet surfaced as a user warning — add a translation pass mirroring the deficit→invalidSCCs flow if a real scenario hits it.
- **LP-infeasible pin** — `invalidCycles` populated, warning surfaces immediately.

## DO NOT

- DO NOT call `highsSolve` directly from outside `solveLP` / `solvePacking`. The wrappers handle raw-material exclusion, lexicographic passes, slack handling, recipe pinning, tolerance, and the solver timeout.
- DO NOT treat `lpStatus: "solver_error"` as infeasible anywhere. It is evidence, not a verdict — the optimizer throws on it; the UI shows the recoverable `planSolverError` message, never the infeasible one.
- DO NOT reject a `calc-client` caller because a worker died. Re-dispatch through `onWorkerDeath` (fresh worker → fallback); only calculation errors (the `{ kind: "error" }` protocol message) and fallback failures reject.
- DO NOT set a bare per-solve `time_limit` on the HiGHS instance. Go through `highs-wrapper.solve`, which offsets by the instance's accumulated run clock.
- DO NOT add ad-hoc `console.log` to `flow-solver.ts` or `graph-builder.ts`. Both carry heavy debug instrumentation already; gate new logging behind `import.meta.env?.DEV`.
- DO NOT iterate `scc.recipes` in rendering / prefill code without filtering to `activeRecipeIds` first. Inactive alternatives (e.g. `pool_xiranite_poly_2` when the LP picked tier 1) sit in the SCC's recipe set but don't run; walking them trips `[resolveBinInfo]` warnings.
- DO NOT add a graph-side selection heuristic to bypass an "unwanted" LP pick. The global LP picks recipes by the lex objective; if the result is wrong, fix the objective (`rawCost`, `buildingCount`, `power`, the `costlessRaws` set).
- DO NOT introduce a threshold or epsilon to detect "ineffective pin" in `useProductionPlan.ineffectivePins`. The predicate is exact: `!plan.nodes.has(pinnedRecipeId)`. The extraction clamp at `lp-solver.ts:846` and the filter at `calculator.ts:587` already provide the thresholding semantics.
- DO NOT silently drop non-zero `result.disposalDeficits` from `flow-solver.ts`. Each non-zero deficit MUST be translated to an `InvalidSCCInfo` so the cycle-warning pipeline fires. The defensive DEV log for "deficit on item with no containing SCC" is the canary — keep it.
- DO NOT pass `manualRawMaterials` to `computeRecipeReachability`'s App-layer call. Manual raws are calc-time only; the AIC menu/availability layer reads `forcedRawMaterials` + `bootstrapFacilities` only.
- DO NOT re-introduce a post-LP `injectDisposalRecipes` step. The LP itself sizes disposers via the two-sided disposal-slack constraint + pre-LP `injectDisposalRecipesIntoGraph` in graph-builder. Reintroducing post-LP injection would double-count and break the lex-optimal disposer selection.
- DO NOT add a recipe whose `facilityId` is in `facilityRecipeVariants` without also adding a corresponding `default`/`toggled` entry to that map. The `calculator.ts` filter assumes every variant facility has both entries; an orphan recipe would silently never enter the LP.
