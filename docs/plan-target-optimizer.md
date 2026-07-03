# Target Optimizer — implementation plan

Status: **planned, not yet built.** The frontend phase (Phase F) already
landed the UI surface, gating logic, and lock-state plumbing; this
document specifies the engine so the follow-up phase can be picked up
cold. Read it fully before extending `src/lib/target-optimizer.ts`.

## Goal

Automate the "squeeze the maximum out of the factory" workflow when the
user has configured resource limits, replacing manual
nudge-and-watch-the-badge searching:

1. **Max(X)** — set target X to the highest rate that stays inside every
   configured constraint, all other targets held at their current rates.
2. **Fit to limits** — when the user's demands exceed the limits, shrink
   the *flexible* (unlocked) targets proportionally so the plan fits.

## Agreed semantics (decided with the project owner — do not relitigate)

- **Lock flag** (`ProductionTarget.locked`, shipped in Phase F): locked
  targets are never auto-adjusted. Default is **unlocked**.
- **Max(X)** holds ALL other targets fixed — locked or not. Lock state
  only affects Fit. ("Max that also shrinks others" degenerates to
  "give X everything", silently zeroing flexible targets — rejected.)
- **Max gating** (shipped in Phase F): the button is enabled iff a raw
  material in X's chain (`rawsInChainOf`) has a configured limit
  (`rawMaterialCaps`). Raw limits are what make the maximum *finite*.
  Facility caps and metastorage budgets **bound the search result** but
  do not *enable* the button.
- **Fit** scales all unlocked targets by a single factor λ ∈ [0, 1]
  (largest feasible). Proportional scaling preserves the ratios between
  flexible targets and has exactly one parameter to search.
- **Fit triggers**: an explicit affordance by default, PLUS an opt-in
  "auto-fit" toggle (Options card). In auto mode, an edit that pushes
  the plan over its limits shrinks the *other* unlocked targets — the
  just-edited target is the demand and is excluded from shrinking.
  One-shot per edit (loop guard), with an undo toast.

## Feasibility definition (shared by both operations)

A candidate target vector is *feasible* iff, after a full solve:

```
error == null
∧ computeOverCapWarnings(aggregates.rawPerFacility, facilityCaps) is empty
∧ computeRawOverCapWarnings(...) is empty
∧ plan.warnings has no `metastorage-budget-insufficient`
```

Composition (all existing exports — no solver surgery):

```
calculateProductionPlan(targets, items, availableRecipes, facilities, opts)
  → aggregateBinTotals(plan, facilities, items)        // plan-helpers
  → computeOverCapWarnings / computeRawOverCapWarnings // plan-helpers
  → plan.warnings                                      // calculator
```

Notes:
- Over-cap detection reads `rawPerFacility` (mode-independent LP
  counts), so feasibility — and therefore Max/Fit results — do **not**
  depend on the "Round up facilities" toggle.
- The `opts` bundle must mirror `useProductionPlan`'s calc effect
  exactly: `rawMaterials`, `rawCaps`, `recipeOverrides`,
  `manualRawMaterials`, `facilityCaps`, `metastorageRoutes`.
- Cycle warnings and packer fallbacks are NOT infeasibility.

## Algorithms

### `maximizeTargetRate({ targets, index, opts, cancel })`

1. If the current vector is already infeasible at X's current rate,
   set `lo = 0`; else `lo = currentRate`.
2. **Bracket**: `hi = max(currentRate, 1)`; double until infeasible.
   Hard ceiling `MAX_RATE_CEILING` (default `2^20`; injectable via
   options so tests stay fast). If `hi` reaches the ceiling while still
   feasible → return `{ kind: "unbounded" }` ("no limit reached" toast;
   defends against gating over-approximation).
3. If infeasible at `lo = 0` (i.e. the *other* targets alone blow the
   caps) → return `{ kind: "infeasible" }`.
4. **Bisect** to `PRECISION = 0.001`/min.
5. Round the result **down** to 3 decimals, run one final verification
   solve, return `{ kind: "ok", rate }`.

Cost: ~15–25 sequential solves ≈ 1–4 s on typical plans. Async all the
way; check `cancel` between solves.

### `fitTargetsToLimits({ targets, excludeIndex?, opts, cancel })`

1. Flexible set S = unlocked targets, minus `excludeIndex` (auto mode
   passes the just-edited index; the manual button passes none).
2. If feasible at λ = 1 → `{ kind: "noop" }`.
3. If infeasible at λ = 0 → `{ kind: "impossible" }` (locked + excluded
   demands alone exceed the limits — surface as a toast; the over-cap
   badges remain).
4. Bisect λ; candidate rates = `round3(desired × λ)` (round down).
5. Return `{ kind: "ok", rates: Map<index, number> }`.

### Value-write & undo

Both operations write ordinary target edits (`setTargets`), which flow
into the URL hash as usual. Before applying, snapshot the previous
`targets` array and offer **Restore** in the completion toast (sonner
supports action buttons — see the auto-prune toast for the pattern).

## Hook integration (`useProductionPlan`)

- `optimizeState: { kind: "max"; index: number } | { kind: "fit" } | null`
  — drives per-button spinners and mutual exclusion (one search at a
  time; new searches cancel the previous via the token).
- `handleMaximizeTarget(index)` — replaces the Phase F disabled stub in
  `TargetItemsGrid` (the `maximizeComingSoon` tooltip + `disabled` prop
  come off; the `maximizeNoLimits` gating tooltip stays).
- `handleFitToLimits(excludeIndex?)`.
- **Auto-fit**: preference persisted at
  `namespaceStorageKey("endfield-calc:auto-fit-v1")`; toggle UI goes in
  the Options card under "Round up facilities". Effect: when a calc
  result lands with over-cap warnings ∧ autoFit ∧ ≥1 unlocked target
  (excluding last-edited) → debounce ~600 ms → run fit once. Track
  `lastEditedIndex` in `handleTargetChange`. **Loop guard**: at most one
  auto-fit pass per user edit; if still infeasible afterwards, stop
  until the next edit.
- **Fit pill**: amber "Fit to limits" button in the Targets card header
  (LeftPanel + portrait sheet), visible when over-limit ∧ unlocked
  targets exist. Hidden while auto-fit is enabled (it would race).
- The scrub input's trailing-throttle commit (Phase F,
  `SCRUB_COMMIT_THROTTLE_MS` in `TargetItemsGrid.tsx`) already rate-
  limits edit streams; the auto-fit debounce sits on top of it.

## Phase F artifacts to build on

| Artifact | Where |
|---|---|
| `rawsInChainOf` gating closure | `src/lib/target-optimizer.ts` |
| `maxEnabledByTarget` memo | `useProductionPlan.ts` |
| Disabled Max button + tooltips | `TargetItemsGrid.tsx` |
| Lock flag + hash `:6l` suffix + save-file field | `TargetItemsGrid.tsx` type, `useProductionPlan.ts` parse/serialize/save/open |
| `handleTargetLockToggle` | `useProductionPlan.ts` |

Temporary key to delete when wiring the engine:
`targets:maximizeComingSoon` (all 7 locales).

Reserved i18n keys to add (7 locales): `maximizedTo`, `maximizeNoLimit`
("no limit reached"), `maximizeInfeasible`, `fitToLimits`, `fitApplied`,
`fitImpossible`, `restore`, `autoFit`, `autoFitHint`.

## Test matrix (`src/tests/lib/target-optimizer.test.ts` — extend)

1. **Analytic max vs raw cap**: raw capped at 30/min, 1:1 recipe →
   `maximizeTargetRate` = 30.000 (`toBeCloseTo(30, 3)`).
2. **Facility cap binds tighter than raw cap** → result respects the
   facility cap (owner's explicit rule: max must never exceed facility
   caps even with raw headroom).
3. **Metastorage budget binds** → capped by TTV budget.
4. **Fit λ analytic**: two targets share a raw capped at 30; locked
   target consumes 20; unlocked desires 20 → λ = 0.5, rate = 10.
5. **excludeIndex**: the excluded target keeps its rate; only the rest
   scale.
6. **All-locked over-cap** → `{ kind: "impossible" }`.
7. **No binding caps + small injected ceiling** → `{ kind: "unbounded" }`
   (keeps the test fast).
8. **Round-down invariant**: returned rate re-solved is always feasible.
9. Real-data smoke: Xircon plan + water cap.

## Open items

- Bisection precision vs run time: 0.001 ⇒ ~20 iterations post-bracket.
  If too slow on big plans, drop to 0.01 (display shows ≤3 decimals).
- **Solver transport**: since the worker migration
  (`src/lib/calc-client.ts` + `src/workers/calc.worker.ts`), solves run
  off the main thread. The optimizer should run its bisection through
  `calc-client.calculate()` — but note the client's latest-wins queue
  is tuned for the UI edit stream: a 20-iteration search issuing
  sequential awaited requests works fine (each completes before the
  next is sent), but a concurrent UI edit will supersede a parked
  search step. Either (a) treat `CalcSupersededError` as "abort the
  search" (simplest, correct — the user changed the problem), or
  (b) move the whole search loop into the worker later. Feasibility
  post-processing (`aggregateBinTotals` + over-cap checks) is cheap and
  runs main-thread on the structured-clone result.
- Whether Fit should also surface in the dock's Issues strip as an
  action — defer until the pill proves itself.
