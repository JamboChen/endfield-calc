---
paths:
  - "src/lib/multi-formula-packing.ts"
  - "src/lib/plan-helpers.ts"
  - "src/tests/lib/multi-formula-packing.test.ts"
  - "src/tests/lib/plan-helpers.test.ts"
---

# Phase 3 packer invariants

`multi-formula-packing.ts` decides how Phase 2's per-recipe slot demands (`recipeFacilityCounts`) become physical buildings. Multi-formula facilities (those with `cacheSlots` defined) may co-locate multiple recipes per building. The file's top-of-file JSDoc (lines 1-79) is authoritative — read it before changing the algorithm.

## Algorithm shape (verified against source)

- **Variables**: per-variant `x_v ∈ ℤ≥0` (integer building count) + per-variant `u_v ∈ ℝ≥0` (continuous scale factor). Active recipe rate is `y_r = u_v × rateDirection[r]`. `u_v` is **per-variant**, not per-recipe.
- **`rateDirection`** is normalised so `max = 1`, which lets the capacity constraint be `u_v ≤ x_v` in units of "max-utilisation building" (`multi-formula-packing.ts:200-221`).
- **Strict-equality demand**: `Σ_v u_v × rateDirection[r] = demand_r` per equivalence class and per pinned recipe (lines 892-965). Inequality (≥) would let variants over-produce one recipe to "fill" a bin, breaking Phase 2's flow balance.
- **Lex passes**: `buildings → power → shape-size sum (compactness tiebreak)`. There is NO fourth pass for over-provisioning — strict equality binds `y` exactly modulo HiGHS's 1e-10 feasibility tolerance (line 760-763).
- **Tolerances**: `LEX_BUILDINGS_TOLERANCE = 1e-9` (line 107), `LEX_POWER_TOLERANCE = 1e-6` (line 114). HiGHS's `primal_feasibility_tolerance` is 1e-10 in the wrapper, so the slacks are small defensive cushions.
- **Solver timeout**: `SOLVER_TIME_LIMIT_SECONDS = 30` (line 817), passed via `options: { timeLimitSeconds }` on the `LPModel` and translated by `highs-wrapper.ts:106-107` to HiGHS's native `time_limit` param. Matches vitest's `testTimeout: 30000` (ms) in `vite.config.ts:86`.
- **Port-cap feasibility is by construction**: only port-feasible variants are enumerated. `assertBinPortCaps` (line 1517) is the test-mode invariant guard — throws in test, warns in dev, no-op in production. It runs on `packed.bins` only, NOT on `singletons.bins` (singleton fallback may legitimately violate caps; those are surfaced via warnings instead).
- **Singleton fallback**: `emitSingletonBins` (line 1380) emits trivial 1-recipe bins for any active recipe the MIP didn't host. Always exact-match feasible per recipe because a singleton's direction is a unit vector. Triggered on LP infeasibility (line 1696) and for non-multi-formula recipes (no `cacheSlots`).

## Cardinal invariants

- **`bin.recipeIds` holds demand recipe IDs, not the physical twin IDs the LP picked.** Downstream consumers compare against `node.recipeId` with plain equality. `bin.facilityId` separately tracks the physical facility. Always sorted ascending — `useProductionTable.ts` uses `bin.recipeIds[0]` as the "primary row owns the power" key; re-ordering silently breaks attribution.
- **Active-rate bin I/O**: bin externals scale with per-recipe active slot counts, NOT `shape.netOutputs × buildingCount`. Partial-load cases (e.g. Xircon target=57) require this.
- **`aggregateBinTotals` (`plan-helpers.ts:154`) is the single source of truth** for buildings / power / per-facility totals. Per-recipe-ceiled aggregation triple-counts shared multi-formula bins. Source-facility power (pump_1/pump_2/unloader_1 from `rawMaterialSources`) is folded in here — do NOT re-sum at the caller.
- **`MIN_VISIBLE_RATE_PER_MIN` contract** (`flow-thresholds.ts:39`, value `0.001`): emission filter drops variants whose max recipe rate falls below this. Cumulative plan-wide drift ≤ ~0.005/min in practice, accepted as deliberate. Production code must use the imported constant — bare `0.001` literals are forbidden.
- **`makeBinId` is the only legal site for `as BinId` casts** (line 733-737, format `bin-<facilityId>-<recipeId...>-<index>`). Mapper synthetic IDs (`disposal-<recipeId>`, `<binId>-bldg<idx>`, target-sink IDs) are NOT BinIds — they stay plain `string`.
- **Pinned recipes use per-pin restricted + class-wide total constraints** (lines 892-965). `cls_${idx}_pin_${pinId}: equal: pinDemand` for each pin; `cls_${idx}_total: equal: cls.slotDemand` for the class.
- **`facilityCaps` retry path** (lines 1662-1694): cap-induced infeasibility triggers a retry without caps; the post-packing cap check still fires on the retry's bins. `facility-over-cap` warnings are NOT emitted here — they live at the hook layer via `computeOverCapWarnings` against `aggregateBinTotals.rawPerFacility`.

## DO NOT

- DO NOT call `highsSolve` directly outside `solvePacking` / `solveLP`. The wrappers handle pin constraints, lex passes, slack handling, and the 30-second solver timeout.
- DO NOT use bare `0.001` literals — import `MIN_VISIBLE_RATE_PER_MIN` from `@/lib/flow-thresholds`.
- DO NOT bypass `aggregateBinTotals` for building/power totals. Per-recipe-ceiled aggregation triple-counts shared multi-formula bins.
- DO NOT construct a fresh `BinId` outside `makeBinId`. Receive it through the type system.
- DO NOT re-order `bin.recipeIds`. Sorted ascending is a contract, pinned by tests.
- DO NOT re-sum pickup-point power at callers of `aggregateBinTotals`. The source-facility (`pump_1`, `pump_2`, `unloader_1`) power is already folded into `perFacility` and `totalPower`.
- DO NOT assert port caps on singleton-fallback bins. `emitSingletonBins`-produced bins from the infeasibility path can legitimately exceed caps; cap warnings come from the hook layer.
