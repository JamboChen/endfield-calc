# CLAUDE.md

Instructions for Claude Code when working in this repository.

## Project

Endfield Calc is a production-chain calculator for *Arknights: Endfield* — single-page React + TypeScript, deployed to GitHub Pages at `/endfield-calc/`. Computes resource requirements, production ratios, and facility counts for potentially circular production loops.

## Commands

```bash
pnpm install                 # Install dependencies
pnpm dev                     # Dev server
pnpm build                   # tsc -b then Vite build
pnpm lint                    # ESLint
pnpm test                    # Vitest (run all)
pnpm knip                    # Detect unused code/exports
pnpm vitest run <path>       # Single test file
```

## Where critical logic lives

- `src/lib/multi-formula-packing.ts` — Phase 3 ILP bin packer (Reactor / Expanded Crucible).
- `src/lib/flow-solver.ts` + `src/lib/lp-solver.ts` — LP-based SCC flow solve; lexicographic two-pass (raw → power).
- `src/lib/calculator.ts` — orchestrates `calculateProductionPlan`; plumbs packer warnings into `plan.warnings`.
- `src/lib/plan-helpers.ts:aggregateBinTotals` — single source of truth for building / power / per-facility totals.
- `src/components/mappers/bin-fused-mapper.ts` — default rendering path (Recipe + Facility view).
- `src/components/mappers/merged-mapper.ts` — legacy per-recipe Recipe View (bf=0 toggle).
- `src/components/mappers/flow-assertions.ts` — `assertFlowIntegrity` (throws in test mode).

Everything else is discoverable via `ls` / `grep`. Game data: `src/data/{items,recipes,facilities}.ts`; types: `src/types/`; UI: `src/components/`; hooks: `src/hooks/`; tests: `src/tests/lib/`.

## Type system

Branded IDs in `src/types/constants.ts` prevent mixing:
```typescript
type ItemId    = string & { readonly __brand: "ItemId" };
type RecipeId  = string & { readonly __brand: "RecipeId" };
type FacilityId = string & { readonly __brand: "FacilityId" };
```

Domain types in `src/types/core.ts`, `src/types/production.ts` (including `Bin`, `RecipeBinAllocation`, `ProductionDependencyGraph.warnings`), `src/types/flow.ts`.

**IMPORTANT: Always thread brands through; never cast with `as ItemId`. Use `getItemById` or accept the branded type.**

## Bin-fused architecture

Phase 3 packs multi-formula recipes (facilities with `cacheSlots`) into shared buildings. Output: `plan.bins: Bin[]` + `plan.recipeBinAllocations: Map<RecipeId, RecipeBinAllocation>`. Even single-formula recipes get a singleton `Bin` so downstream consumers see a uniform shape.

`ProductionDependencyTree.tsx` selects the mapper:

| View | bf flag | Mapper |
|---|---|---|
| Facility View | (ignored) | `mapPlanToFlowBinFusedSeparated` (always bin-fused) |
| Recipe View | bf=1 (default) | `mapPlanToFlowBinFused` |
| Recipe View | bf=0 | `mapPlanToFlowMerged` (legacy per-recipe) |

The `bf` URL hash flag persists in `SavedPlan` JSON files alongside `ceilMode`. Toggle hides itself when no plan bin is grouped.

## Algorithm invariants

**IMPORTANT — these are non-obvious decisions that have caused real bugs when violated:**

- **`bin.recipeIds` holds demand recipe ids (Phase 2's pick), not physical twin ids the ILP picked.** Downstream consumers compare against `node.recipeId` with plain equality. `bin.facilityId` separately tracks the physical facility.
- **Active-rate bin I/O.** Bin externals scale with per-recipe active slot counts, not `shape.netOutputs × buildingCount`. Partial-load cases (e.g. Xircon target=57) surface correctly.
- **`aggregateBinTotals` is the single source of truth** for buildings / power / per-facility counts. Per-recipe-ceiled aggregation triple-counts shared multi-formula bins.
- **Per-pin restricted + class-wide total constraints** in `solvePacking`. Pinned demand-recipes get a restricted constraint; the class also gets a total. Pinned demand allocates first in `allocateSlotsToBins`.
- **Lexicographic three-pass packer**: buildings (1e-6 tol) → power (1e-3 tol) → over-provisioning. Raw materials are the rarer resource in flow-solver's LP too; pass 1 minimises raw, pass 2 minimises power subject to raw cap.
- **Pool capacity is tracked in primary-output units** (recipe's first output). Byproducts derive via ratio `byproductAmount / primaryAmount`.
- **`itemDemands` accumulation rules** in `flow-solver.ts`: `Math.max` for SCC disposal-deficit propagation (Phase 4 against `externalDemand` floor); `+=` for external-input consumption (Phase 5) and plain recipe inputs.
- **Phase 1 of `solveSCCFlow` reads from `targetRates`, not `itemDemands`**, for target items — `itemDemands` already accumulated external-consumer demand. Same pattern in `tryExtendSCCWithFeeders`'s feeder-Phase 1.
- **`resolvedSCCIds`** filters `detectedCycles` so linearized cycles don't render backward edges.
- **LP item-constraint selection** (`flow-solver.ts:buildLPInputForSCC`): non-disposal SCC items use `=`; forced-disposal items get `disposal-slack` if they have an external producer (slack absorbs deficit, propagated upstream via `itemDemands`), `min` otherwise.
- **Singleton-terminal bin detection runs before producer/consumer map construction** in bin-fused mappers. The bin→sink redirect is baked into map construction; post-hoc remapping leaves phantom state that produces isolated nodes.
- **Target sinks register before disposal sinks** in the bin-fused greedy allocator so targets get first claim on producer output.
- **`assertFlowIntegrity` throws in test mode** (`import.meta.env?.MODE === "test"`), warns in dev, no-ops in production.

## Game data conventions

- `forcedRawMaterials` (in `src/data/index.ts`): items always treated as raw inputs, terminating DFS recursion. Add only if the item has no in-game production recipe (ores, base liquids).
- `forcedDisposalItems`: items that must net to zero in the plan. Other recipes may consume them, but any surplus is routed to disposal sinks via `injectDisposalRecipes`.
- Item IDs: `item_<category>_<subcategory>_<modifier>`. Recipe IDs: `<facility_type>_<output>_<tier>`. Keep enums in `src/types/constants.ts` alphabetised.
- Image assets: `public/images/items/<item_id>.png` and `public/images/facilities/<facility_id>.png`.

## Test conventions

- Tests live in `src/tests/lib/`. Run a single file with `pnpm vitest run <path>`.
- For latent-bug regressions, write tests with **inline synthetic items + recipes** passed to `calculateProductionPlan`. Isolates the bug from upstream-data drift.
- For upstream-data-triggered bugs, use the real-data regression style: import real `items` / `recipes` / `facilities`, target specific `ItemId` enum values, assert exact production rates.
- Use `toBeCloseTo(value, 3)` for facility counts and rates (absorbs floating-point noise).
- `flow-integrity.test.ts` is the model for mapper-output assertions (no dangling edges, no isolated nodes). `assertFlowIntegrity` automatically throws on integrity violations in test mode — most mapper bugs surface as test failures before reaching explicit assertions.

## Pre-ship workflow

1. `pnpm lint` — ESLint clean of new warnings.
2. `pnpm test` — all tests pass.
3. If you touched `src/lib/`: also `pnpm vitest run src/tests/lib/calculator.test.ts`, `pnpm vitest run src/tests/lib/flow-integrity.test.ts`, `pnpm vitest run src/tests/lib/bin-fusion-mapper.test.ts`, and `pnpm vitest run src/tests/lib/multi-formula-packing.test.ts` — these are sensitive to algorithm changes.
4. `pnpm build` — TypeScript clean and Vite build succeeds.
5. `pnpm knip` — surface any newly-unused exports introduced by the change.

## Anti-patterns

**IMPORTANT — these have caused real bugs:**

- DO NOT modify per-recipe rate computation in only one mapper. `merged-mapper.ts` and `bin-fused-mapper.ts` compute rate independently and MUST agree.
- DO NOT add `as ItemId` / `as RecipeId` / `as FacilityId` casts in production code. Brands exist to prevent this. Use `getItemById` or thread the type through. (Tests may use `as never[]` for synthetic fixtures.)
- DO NOT bypass `aggregateBinTotals` for building / power totals. Per-recipe-ceiled aggregation triple-counts shared multi-formula bins.
- DO NOT detect singleton-terminal bins after building producer/consumer maps. Bake the bin→sink redirect into map construction; isolated-node bugs trace back to phantom-state remapping.
- DO NOT register disposal-bin consumers before target sinks in `consumersByItem`. Greedy allocator iterates in insertion order; targets must get priority.
- DO NOT call `solver.Solve` directly from outside `solveLP` / `solvePacking`. The wrappers handle raw-material exclusion, lexicographic passes, slack handling, recipe pinning, and tolerance.
- DO NOT add to `forcedRawMaterials` without confirming the item has no in-game production recipe. Wrong additions silently break upstream chains.
- DO NOT add ad-hoc `console.log` to `src/lib/flow-solver.ts` or `src/lib/graph-builder.ts`. Both carry heavy debug instrumentation already. Gate new logging behind `import.meta.env?.DEV`.
- DO NOT read `itemDemands.get(itemId)` for target items inside `solveSCCFlow` Phase 1 or `tryExtendSCCWithFeeders` Phase 1. Use `targetRates.get(itemId)` to avoid double-counting.
- DO NOT set `elk.layered.priority.direction` to a negative value. Lower bound is 0; values below are silently clamped.

## Terminology

- `targetRate` (flow node) — per-recipe per-output rate, `calcRate(output.amount, t) * facilityCount`. **Not** the user's request.
- `userTargetRate` / `targetRates: Map<ItemId, number>` — what the user requested via the UI.
- `Bin` — packed unit. **Singleton** bin: 1 recipe. **Grouped** bin: 2+ recipes co-located in a multi-formula building, sharing inner inventory and port budget.
- **Internal items** — items balanced within a bin (no external port consumption); hidden from edges in bin-fused view.
- **"Backward" edge** — producer and consumer in the same SCC; tagged for distinct visual rendering.

## Internationalization

7 languages via i18next at `public/locales/{lang}/{namespace}.json`. The `recipe` namespace is generated from game data — do not hand-edit. Other namespaces are hand-maintained.

## Commit convention

- `Add:` new feature
- `Fix:` bug fix
- `Update:` enhancement to existing feature
- `Refactor:` code restructuring
