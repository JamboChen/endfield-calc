---
paths:
  - "src/lib/target-optimizer.ts"
  - "src/lib/optimizer-orchestration.ts"
  - "src/hooks/useTargetOptimizer.ts"
  - "src/hooks/useProductionPlan.ts"
  - "src/tests/lib/target-optimizer.test.ts"
  - "src/tests/lib/optimizer-orchestration.test.ts"
---

# Optimizer stack (Max / Fit / auto-fit) invariants

Three layers, strictly separated:

1. **Engines** (`target-optimizer.ts`) — pure bisection (priority-Max, Fit λ-scaling) on an integer milli-rate grid. Solve closure injected; no React, no transport imports. The module JSDoc is the canonical semantics reference.
2. **Transport** (`calc-client.ts` `searchMaximize`/`searchFit` + `calc.worker.ts`) — a whole search runs IN the calc worker as ONE job; probes call `calculateProductionPlan` directly (no per-probe structured clone of plan graphs) and only the small result crosses the boundary. Details in `.claude/rules/solver.md` § transport.
3. **Orchestration** (`useTargetOptimizer.ts` + the pure `optimizer-orchestration.ts` reducer) — gesture bookkeeping (auto-fit guard, protected-demand exclusion, Max marks) is a unit-tested reducer transition table; async bookkeeping (search token, cancel handle, spinner state) stays as refs next to the dispatch calls.

## The over-limit contract (single judge)

- `calculateProductionPlan` emits EVERY limit violation into `plan.warnings` at plan assembly: cap kinds via `computeLimitViolations` (plan-helpers.ts — facility caps against always-ceiled `physicalPerFacility`, raw caps against the raw-node fold incl. manual raws), metastorage/power kinds at their sources.
- `OVER_LIMIT_WARNING_KINDS` (plan-helpers.ts) is the complete definition of "over-limit". `isPlanFeasible(plan)` = `lpStatus === "ok"` + no warning in the set; the hook's `planOverLimit` is the same scan. Probe/badge parity is structural — there is exactly ONE judge and it runs inside the pipeline.
- **Enrolling a new limit** = (1) emit its `PlanWarning` in the calculator, (2) add the kind to `OVER_LIMIT_WARNING_KINDS`, (3) formatter branch + i18n keys, (4) decide its banner policy (cap kinds are filtered OFF the banner — the stat-row chrome is their surface; `capIssueCount` keeps the ticker badge honest). Nothing else: Fit, Max, auto-fit, and the Fit pill all pick it up automatically.

## Probe ≡ UI problem (the ratchet-bug class)

- `useProductionPlan.calcProblem` is the ONE memo building the problem definition (items, recipes, facilities, options bundle). The display calc and both search ops consume it — a probe must judge the exact problem the UI solves after a commit, or a "verified feasible" rate re-solves over-cap (the SC-Wuling-Battery ratchet). Never hand-build a second options object.
- Probe vectors include ALL targets, zero-rate entries included — a rate-0 target still roots graph traversal (producer closure, disposal-injection cascades, forced-disposal constraint flips).

## Verified-feasible + the wedge tripwire

- Every committed rate was verified by an actual solve (`lo` only moves to probed-feasible values; Fit tracks the best verified rounded vector). Defends against ILP-packing non-monotonicity.
- `lpStatus: "solver_error"` probes THROW (evidence, not a verdict); Max's pass-2 `impossible` contradicting pass 1 THROWS (solver instability — the all-locked SC-Wuling wedge). Both abort without committing.
- **REJECTED optimization — do not re-attempt**: memoizing probes ACROSS Max's pass 1 → pass 2 (pass-2's λ=0 re-solves pass-1's final verified vector, ~1 duplicate solve per Max ≈ 2%). The re-solve IS the wedge tripwire: with a shared memo, a solver that wedges between passes serves a stale "feasible" from cache and the search commits instead of aborting — the `mid-search wedge` regression test pins this. The duplicate solve is the price of the tripwire.

## Staleness + cancellation (hook layer)

- Targets identity: the `targetsRef` effect cancels the active search whenever the live array leaves the captured snapshot (covers rate edits, add/remove, AND lock toggles — the calc effect ignores lock-only changes via its content signature, the optimizer's flexible set does not).
- Config identity: `calcProblem` change → `cancelActiveSearch` (token bump + worker cancel + marks dropped). A search probing a stale options bundle could commit values the fresh problem judges over-cap.
- Unmount: a cleanup effect cancels the worker-side loop. Both staleness effects above only fire while mounted, so a search in flight when the tree is torn down (loading a pasted plan link remounts it) would otherwise run to its time limit with no consumer. Token/marks need no cleanup — they die with the hook.
- **Commit gate**: after the await, re-check token + captured targets identity — a result can already be in flight when a cancel lands. Never commit past the gate.
- Errors: `CalcSupersededError` → silent abort; anything else → `optimizeFailed` toast. Never map an error to "infeasible".

## Reducer transitions (`optimizer-orchestration.ts`)

| Event | armed | lastEditedIndex | maxedMarks |
|---|---|---|---|
| `rate-edit(i)` | true | i | — |
| `lock-toggle` / `target-remove` | true | null | — |
| `structural-replace{disarm}` | disarm ? false : keep | null | — |
| `config-change` | — | — | null |
| `auto-fit-fired` | false | — | — |
| `max-marked` | — | — | accumulate (same identity) / replace |

- `lock-toggle` re-arming AND clearing the exclusion were both real dead-ends (unlock over a power shortfall did nothing; unlock after scrubbing that target's rate left no flexible target). Pinned in `optimizer-orchestration.test.ts`.
- Max-mark validity is DERIVED by identity (`marks.forTargets === targets`), never evented — Restore writes the EXACT captured array back, deliberately re-validating marks keyed on it.

## Performance notes

- Post-refactor Max on a real chain (Ferrium, Valley IV, ~25-30 probes) ≈ 260 ms wall in-browser — per-probe transport overhead is near-zero since searches moved in-worker. If big power-sustain searches ever feel slow, the documented lever is probes skipping the ceil-floor loop (bounded drift) — see solver.md § ceil-floor; measure before adding complexity.

## DO NOT

- DO NOT add a second feasibility check outside `isPlanFeasible` / `OVER_LIMIT_WARNING_KINDS`. If a consumer needs "is this plan over its limits", it reads the plan warnings.
- DO NOT build search/calc options anywhere but the `calcProblem` memo.
- DO NOT memoize probes across Max passes (wedge tripwire — see above).
- DO NOT commit a search result without the token + targets-identity gate.
- DO NOT put side effects (cancel, toasts, storage) in the orchestration reducer — it must stay a pure, unit-testable transition table.
- DO NOT re-run a cancelled search after a worker crash (`onWorkerDeath` resolves it cancelled — a 30 s search the user walked away from must stay dead).
