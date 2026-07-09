# Target Optimizer — implementation plan

Status: **shipped.** Phase F landed the UI surface, gating logic, and
lock-state plumbing; the engine phase landed the bisection engines
(`maximizeTargetRate`, `fitTargetsToLimits`, `isPlanFeasible` in
`src/lib/target-optimizer.ts`), the hook wiring (`useProductionPlan`),
the Fit pill, and the auto-fit toggle. This document remains the
canonical semantics + invariants reference — read it fully before
changing the engine.

## Goal

Automate the "squeeze the maximum out of the factory" workflow when the
user has configured resource limits, replacing manual
nudge-and-watch-the-badge searching:

1. **Max(X)** — set target X to the highest rate that stays inside every
   configured constraint. X has *priority*: unlocked targets may be
   shrunk (down to 0 if X can use their share); whatever X's chain does
   not consume is then handed back to them proportionally.
2. **Fit to limits** — when the user's demands exceed the limits, shrink
   the *flexible* (unlocked) targets proportionally so the plan fits.

## Agreed semantics (decided with the project owner — do not relitigate)

- **Lock flag** (`ProductionTarget.locked`, shipped in Phase F): locked
  targets are **frozen under every automatic adjustment** — both Max
  and Fit. Default is **unlocked** (= fair game for both). Pressing Max
  *on* a locked target is an explicit user action on that target and is
  allowed; the lock protects it from being adjusted by operations
  aimed at *other* targets.
- **Max(X) is priority-Max** (two-pass lexicographic):
  - *Pass 1 — headroom*: maximize X with locked targets frozen at their
    current rates and unlocked others held at **0**. This operationally
    defines "X has priority" — its maximum assumes the flexible targets
    fully yield. (Defining it as a probe at others = 0 sidesteps
    exotic byproduct-coupling cases where another target's chain feeds
    X's; it is a definition, not an approximation claim.)
  - *Pass 2 — leftover recovery*: pin X at the pass-1 result and run
    the Fit bisection over the unlocked others (exclude X), desired =
    their **pre-Max** rates. They recover the largest common λ the
    leftovers allow — 0 only when X genuinely consumes everything, and
    their mutual ratios are preserved.
  - A plain "freeze-all" Max (X gets only the leftover headroom, others
    untouched) was considered and replaced by the owner's decision: the
    unified mental model is *lock = frozen, unlocked = adjustable*.
    The old objection ("Max that shrinks others degenerates to zeroing
    them") is answered by pass 2.
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

A candidate target vector is *feasible* iff the solve **resolves**
(does not reject) and, on the resulting plan:

```
plan.lpStatus == "ok"
∧ computeOverCapWarnings(aggregates.physicalPerFacility, facilityCaps) is empty
∧ computeRawOverCapWarnings(rawRequirements, rawCaps) is empty
∧ plan.warnings has no `metastorage-budget-insufficient`
```

The `lpStatus` clause is load-bearing: a failed flow LP (`infeasible`,
`unbounded`, `solver_error`) returns a best-effort EMPTY shell — no
bins, no recipe nodes, zero rates — which passes every cap check
vacuously. Before the clause existed, a wedged solver made every probe
"feasible" and Max bracketed to its ceiling, reporting "no limit
reached" on any target. `infeasible`/`unbounded` are legitimate
bisection verdicts (probe = false); `solver_error` **throws** from the
probe instead — it is evidence of a broken solver, not a verdict, and
counting it as infeasible would corrupt the bracket (the hook's catch
aborts the search with an error toast; `highs-singleton.resetHighs`
self-heals the instance for the next solve).

Composition (all existing exports — no solver surgery):

```
solve(vector)                                      // calc-client / injected
  → aggregateBinTotals(plan, facilities, items)    // plan-helpers
  → computeOverCapWarnings / computeRawOverCapWarnings
  → plan.warnings scan                             // calculator-emitted
```

Notes:
- **Facility-cap detection reads `physicalPerFacility`** (always-ceiled
  placement counts) — the SAME aggregate the UI badge path feeds
  (`useProductionPlan`'s `overCapWarnings`). Owner decision: after
  Max/Fit the plan must never still show red badges. Both
  `physicalPerFacility` and `rawPerFacility` are ceilMode-independent,
  so results still don't depend on the "Round up facilities" toggle;
  physical additionally matches what users see. (Cost: probes depend on
  the ILP packer's output, which is time-limited — mitigated by the
  verified-feasible invariant below.)
- Raw requirements are folded from the plan's raw item nodes
  (`node.isRawMaterial || manualRawMaterials.has(id)`, summing
  `productionRate`) — mirrors `useProductionStats.collectStats`.
- **Probes solve the FULL vector, zero-rate entries included.** The UI
  calc effect passes every target (including rate-0) and a rate-0
  target is not inert: it roots graph traversal (its whole producer
  closure enters the LP), seeds disposal-injection, and can flip a
  forced-disposal constraint from `min: 0` to `disposal-slack: 0` by
  adding a byproduct consumer. Filtering zeros made probes judge a
  smaller problem than the one the UI solves after the commit —
  priority-Max regularly zeroes unlocked targets, so a "verified
  feasible" rate could re-solve over-cap (the SC-Wuling-Battery
  ratchet bug). Only a truly empty target LIST short-circuits to
  trivially-feasible (`calculateProductionPlan` throws on it).
- There is no `plan.error` field: `calculateProductionPlan` **throws**,
  the worker converts to a rejection, and the hook keeps error state
  locally. See the error policy below.
- Cycle warnings and packer fallbacks are NOT infeasibility.

## Error & cancellation policy

- The engine takes an injected `solve` and an `isCancelled` callback.
  It checks `isCancelled()` before every solve and returns
  `{ kind: "cancelled" }`.
- The engine does NOT catch solve rejections — they propagate to the
  hook, which decides:
  - `CalcSupersededError` → abort the search silently (a UI edit
    displaced a parked probe — the user changed the problem).
  - Any other rejection → abort the search with an error toast.
    **Never treat a rejection as "infeasible"** — a transient worker
    failure counted as infeasible would silently corrupt the bisection
    bracket and return a wrong maximum.
- **Staleness guard**: superseded-rejection alone has a hole. The
  calc-client queue is one-inflight + one-pending; when the optimizer's
  sequential awaited probes *alternate* with UI-edit solves, nothing is
  ever displaced and no supersede error fires — the search would finish
  against stale targets and commit by index. The hook therefore
  captures the `targets` array identity at search start and feeds
  `isCancelled = () => token changed || targetsRef.current !== captured`.
  Identity comparison also covers add/remove (index shift) and lock
  toggles (flexible-set change) that don't reject anything.
  **Config staleness**: targets identity alone doesn't cover the rest
  of the problem definition — caps, raw limits, routes, available
  recipes, pins, manual raws, region. An effect on the
  `optimizerSolve` / `optimizerFeasibility` identities calls
  `cancelActiveSearch()` (token bump + self-cleanup + "Max done"
  marker drop) the moment the options bundle changes, so probes never
  judge a stale problem and then commit against a fresh one.
- **Verified-feasible invariant**: bisection runs on the integer
  milli-rate grid (1 unit = 0.001/min) and only ever returns a value
  that an actual solve verified feasible (`lo` is always verified; the
  midpoint is probed before moving a bound). No trailing rounding step,
  no unverified return — this also defends against ILP-packing
  non-monotonicity at bin-count boundaries.
- **"Couldn't solve" is not a verdict.** HiGHS reports solver failures
  (`timelimit`, `error`, `unknown`, …) as returned statuses, never
  throws; `solveLP` maps them to `reason: "solver_error"` (only
  `infeasible`/`unboundedorinfeasible` earn `"infeasible"`), the plan
  carries `lpStatus: "solver_error"`, and the probe **throws** → the
  search aborts without commit. Two solver-level hazards feed this,
  both fixed at the wrapper (`highs-wrapper.ts`): HiGHS's `time_limit`
  is checked against a run clock that is **cumulative across every
  solve on the instance and unresettable** — the packer's sticky 30s
  limit once became a session-wide budget after which every solve
  "timed out" instantly (the frozen-app bug) — so the wrapper offsets
  every limit by its own accumulated-solve-time tracking; and returned
  `error`/`unknown` statuses self-heal via `resetHighs()`.

## Algorithms

### `maximizeTargetRate({ targets, index, solve, feasibility, isCancelled, maxRateCeiling })`

Pass 1 (headroom, unlocked others at 0, locked ≠X frozen):

1. Probe X at `floor3(currentRate)`. Feasible → `lo = floor3(cur)`.
2. Else probe X at 0 (base vector = locked-only). Infeasible →
   `{ kind: "infeasible" }` (the locked demands alone blow the limits).
   Else `lo = 0`, `hi = floor3(cur)` (already infeasible — skip
   bracketing).
3. **Bracket** (when `lo = floor3(cur)`): `hi = max(lo·2, 1/min)`;
   double while feasible, moving `lo` up. Hard ceiling
   `MAX_RATE_CEILING` (default `2^20`/min; injectable so tests stay
   fast). Feasible at the ceiling → `{ kind: "unbounded" }` ("no limit
   reached" toast; defends against gating over-approximation).
4. **Bisect** on the milli grid until `hi − lo ≤ 1`; result =
   `lo / 1000` (verified feasible by construction).
   `{ kind: "ok", rate: 0, … }` is a valid outcome — locked targets
   alone exactly exhaust the limits.

Pass 2 (leftover recovery):

5. Run `fitTargetsToLimits` with X's rate replaced by the pass-1 result
   and `excludeIndex = index`; desired = the others' pre-Max rates.
   Map the outcome into `otherRates: Map<index, rate>`:
   `ok` → its rates; `noop` → empty (X's max didn't need their share);
   `impossible` → **throw** (abort, no commit). A pass-2 "impossible"
   contradicts pass 1: fit's λ=0 vector is the exact vector a pass-1
   probe verified feasible moments earlier, so two solves of identical
   input disagreed — solver instability, never a real result. The old
   "commit with zeroed flexible set" fallback shipped an unverified
   value once (the all-locked SC-Wuling-Battery freeze).

Return `{ kind: "ok", rate, otherRates }`.

Cost: two bisections ≈ 30–50 sequential solves ≈ 2–8 s typical. Async
all the way; `isCancelled` checked between solves.

### `fitTargetsToLimits({ targets, excludeIndex?, solve, feasibility, isCancelled })`

1. Flexible set S = unlocked targets with rate > 0, minus
   `excludeIndex` (auto mode passes the just-edited index; the manual
   button passes none; Max's pass 2 passes X).
2. Probe the full current vector (λ = 1). Feasible → `{ kind: "noop" }`.
3. If S is empty, or infeasible at λ = 0 (locked + excluded demands
   alone exceed the limits) → `{ kind: "impossible" }` (toast; the
   over-cap badges remain).
4. Bisect λ ∈ [0, 1]; candidate rates = `floor3(desired × λ)`.
   Probes are memoized by the rounded-rate vector signature (near
   convergence many λ values collapse to the same vector). Fixed
   iteration budget (~20); track the best *verified-feasible* vector.
5. Return `{ kind: "ok", rates: Map<index, number> }` (flexible indices
   only; all-zero is a valid result).

### Value-write & undo

Both operations write ordinary target edits (`setTargets`), which flow
into the URL hash as usual. Before applying, snapshot the previous
`targets` array and offer **Restore** in the completion toast. Sonner
supports `action` buttons; this is the first `action` usage in the
codebase (the auto-prune toast is a plain `toast.info` — do not copy
it for the action pattern, only for tone). With priority-Max the write
is multi-value, so Restore is load-bearing, not cosmetic.

## Hook integration (`useProductionPlan`)

- `optimizeState: { kind: "max"; index: number } | { kind: "fit" } | null`
  — drives per-button spinners and mutual exclusion (Max/Fit buttons
  disabled while a search runs).
- `handleMaximizeTarget(index)` — replaces the Phase F disabled stub in
  `TargetItemsGrid` (the `maximizeComingSoon` tooltip + `disabled` prop
  come off; the `maximizeNoLimits` gating tooltip stays).
- `handleFitToLimits(excludeIndex?)`.
- The optimizer's probes go through `calc-client.calculate()` with the
  exact `options` bundle the calc effect uses: `rawMaterials`,
  `rawCaps`, `recipeOverrides`, `manualRawMaterials`, `facilityCaps`,
  `metastorageRoutes`. Probe results never touch the UI plan state;
  the final `setTargets` commit re-triggers the calc effect naturally.
- **Auto-fit**: preference persisted at
  `namespaceStorageKey("endfield-calc:auto-fit-v1")`; toggle UI goes in
  the Options card under "Round up facilities". Effect: when a calc
  result lands infeasible (cap issues ∨ metastorage-budget warnings) ∧
  autoFit ∧ no search running ∧ ≥1 unlocked target (excluding
  last-edited) → debounce ~600 ms → run fit once. Track
  `lastEditedIndex` in `handleTargetChange`. **Loop guard**: at most one
  auto-fit pass per user edit; if still infeasible afterwards, stop
  until the next edit.
- **Fit pill**: amber "Fit to limits" button in the Targets card header
  (rendered once, visible in both PlanPanel hosts), shown when
  over-limit ∧ unlocked targets exist. Hidden while auto-fit is enabled
  (it would race).
- **"Max done" button lock** (`MaxedMarks`): after a Max reaches a
  deterministic terminal outcome (ok / already-at-max / infeasible /
  unbounded — never cancelled or solver-error), the index is marked
  against the targets-array identity it was computed for and the
  button disables with the `maximizeUpToDate` tooltip. Validity is
  derived (`maxedMarks.forTargets === targets`), so any other array —
  edit, add/remove, lock toggle, Fit commit, Restore, prune, plan load
  — re-enables it automatically; a Max commit marks against the array
  it just wrote, surviving its own write. Config-bundle changes clear
  marks via `cancelActiveSearch` (the same staleness set).
- The scrub input's trailing-throttle commit (Phase F,
  `SCRUB_COMMIT_THROTTLE_MS` in `TargetItemsGrid.tsx`) already rate-
  limits edit streams; the auto-fit debounce sits on top of it.

## Phase F artifacts to build on

| Artifact | Where |
|---|---|
| `rawsInChainOf` gating closure | `src/lib/target-optimizer.ts` |
| `maxEnabledByTarget` memo | `useProductionPlan.ts` |
| Disabled Max button + tooltips | `TargetItemsGrid.tsx` (rendered on every breakpoint; wiring the engine only removes the `disabled` prop + the `maximizeComingSoon` tooltip) |
| Lock flag + hash `:6l` suffix + save-file field | `TargetItemsGrid.tsx` type, `useProductionPlan.ts` parse/serialize/save/open |
| `handleTargetLockToggle` | `useProductionPlan.ts` |

Temporary key to delete when wiring the engine:
`targets:maximizeComingSoon` (all 7 locales).

Reserved i18n keys to add (7 locales): `maximizedTo`,
`maximizedToWithFit` (variant when pass 2 shrank other targets),
`maximizeAlreadyMax` (pure-noop repeat press — nothing moved, no
write, no Restore), `maximizeNoLimit` ("no limit reached"),
`maximizeInfeasible`, `maximizeUpToDate` (disabled-button tooltip
while a "Max done" marker applies), `fitToLimits`, `fitApplied`,
`fitNoop`, `fitImpossible`, `restore`, `autoFit`, `autoFitHint`,
`optimizeFailed`.

## Test matrix (`src/tests/lib/target-optimizer.test.ts` — extend)

1. **Analytic max vs raw cap**: raw capped at 30/min, 1:1 recipe,
   single target → `maximizeTargetRate` = 30.000 (`toBeCloseTo(30, 3)`).
2. **Priority over unlocked**: water 30 cap, A = 10 unlocked, Max(B) →
   B = 30.000, A shrunk to 0.
3. **Leftover recovery**: same but B facility-capped (cap binds at 20)
   → B = 20.000, A recovers to 10 (pass-2 λ = 1 noop).
4. **Lock protection in Max**: A **locked** = 10 → Max(B) = 20.000,
   A untouched (absent from `otherRates`).
5. **Facility cap binds tighter than raw cap** → result respects the
   facility cap via `physicalPerFacility` (owner's explicit rule: max
   must never exceed facility caps even with raw headroom — and must
   match the badge surface).
6. **Metastorage budget clause**: `isPlanFeasible` returns false for a
   plan carrying `metastorage-budget-insufficient` (unit-level; route
   setup is too heavy for a synthetic end-to-end).
7. **Fit λ analytic**: two targets share a raw capped at 30; locked
   target consumes 20; unlocked desires 20 → λ = 0.5, rate = 10.000.
8. **excludeIndex**: the excluded target keeps its rate; only the rest
   scale; ratio between two flexible targets is preserved.
9. **All-locked over-cap** → `{ kind: "impossible" }`.
10. **No binding caps + small injected ceiling** → `{ kind: "unbounded" }`
    (keeps the test fast).
11. **Verified-feasible invariant**: returned rate re-solved is feasible.
12. **Cancellation**: `isCancelled` flipping mid-search →
    `{ kind: "cancelled" }`, no further solves.
13. Real-data smoke: Xircon plan + water cap.

## Open items

- Bisection precision vs run time: 0.001 ⇒ ~20 iterations post-bracket.
  If too slow on big plans, drop to 0.01 (display shows ≤3 decimals).
- **Solver transport**: probes run through `calc-client.calculate()`
  (worker off-main-thread; latest-wins queue). Sequential awaited
  probes coexist with the UI edit stream via the error/staleness policy
  above. Moving the whole search loop into the worker is a clean later
  optimization if 30–50-probe searches feel slow on big plans — it
  would also eliminate the per-probe structured-clone of the full
  `items`/`recipes`/`facilities` tables (measured <5% of solve time
  today, but ×30–50 per search it's the transport's main overhead).
  Feasibility post-processing (`aggregateBinTotals` + over-cap checks)
  is cheap and runs main-thread on the structured-clone result.
- Whether Fit should also surface in the dock's Issues strip as an
  action — defer until the pill proves itself.
