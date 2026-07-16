# CLAUDE.md

Instructions for Claude Code in this repository. Deeper, file-scoped invariants live in `.claude/rules/` and load only when you touch matching files.

## Project

Endfield Calc is a production-chain calculator for *Arknights: Endfield* — single-page React + TypeScript, deployed to GitHub Pages at `/endfield-calc/`. Computes resource requirements, production ratios, and facility counts for potentially circular production loops.

## Commands

```bash
pnpm install                 # Install dependencies
pnpm dev                     # Dev server
pnpm run build               # tsc -b then Vite build
pnpm run lint                # ESLint
pnpm vitest run              # Run all Vitest tests
pnpm vitest run <path>       # Run a single test file
pnpm run knip                # Detect unused code/exports
pnpm run extract:all         # Run every extractor in dependency order (recommended)
pnpm run extract:ids         # Refresh src/types/constants.ts (Item/Recipe/FacilityId enums) + orphan-guard
pnpm run extract:facilities  # Refresh src/data/facilities.ts + public/locales/{lang}/facility.json
pnpm run extract:recipes     # Refresh src/data/recipes.ts + public/locales/{lang}/recipe.json
pnpm run extract:items       # Refresh src/data/items.ts + public/locales/{lang}/item.json
pnpm run extract:metastorage # Refresh src/data/metastorage.ts (TTV caps + per-item costs)
pnpm run extract:power       # Refresh src/data/power.ts (Thermal Bank + battery burn recipes) + locale name merges
pnpm run extract:structures  # Refresh src/data/region-subsystems.ts + public/locales/{lang}/structure.json
pnpm run extract:aic         # Refresh src/data/aic-plans.ts + public/locales/{lang}/{aic,domain}.json
pnpm run extract:raw-caps    # Refresh src/data/raw-caps.ts (per-region max mining output from scene data LevelGenForRuntime/TotalFactoryRegions.json + DomainDataTable + FactoryMinerTable; the scene file is extracted from the game client — see the script header)
pnpm run extract:item-colors # Refresh src/data/item-colors.ts from public/images/items/*.png — STANDALONE, not in extract:all (icons are manually curated); re-run when icons change
```

Game-data refresh: set `ENDFIELD_DATA_DIR` to the dir containing `TableCfg/` (the scripts fall back to a built-in default if unset — see `scripts/lib/paths.ts`). Note: `scripts/` is **intentionally untracked** (gitignored — the extraction toolchain stays out of the repo), so the `extract:*` commands and any `scripts/**` references only work on a machine that has the private toolchain; every file stamped AUTO-GENERATED can only be regenerated there. `extract:item-colors` is the exception: it reads committed icons, needs no data dir, and is therefore not part of `extract:all`.

## Cardinal rules (always apply)

**IMPORTANT — every rule below has caused real bugs when violated:**

- **Brand discipline**: never `as ItemId` / `as RecipeId` / `as FacilityId` / `as BinId` in production code. Use `getItemById` or thread the brand through. The only permitted `as BinId` cast is inside `makeBinId` in `multi-formula-packing.ts`.
- **`aggregateBinTotals` (`src/lib/plan-helpers.ts:164`) is the single source of truth** for buildings / power / per-facility totals. Per-recipe-ceiled aggregation triple-counts shared multi-formula bins. Source-facility power (pump_1/pump_2/unloader_1) is folded in here — do NOT re-sum at the caller.
- **`MIN_VISIBLE_RATE_PER_MIN` (`src/lib/flow-thresholds.ts:39`, value `0.001`)** is the shared visibility threshold between the packer and the mappers. Production code must import this constant — bare `0.001` literals are forbidden.
- **`assertFlowIntegrity` throws in test mode** (`import.meta.env.MODE === "test"`), warns in dev, no-ops in production. Mapper regressions surface as hard test failures.
- **Match existing style**, even where you'd do it differently. This codebase uses closed-enum literal-string unions for game-data IDs and brand intersections for runtime-constructed IDs — see "Type system" below.

## Where critical logic lives

One sentence per file. Deep invariants in `.claude/rules/` load when you touch these files.

- `src/lib/multi-formula-packing.ts` — Phase 3 ILP bin packer. See `.claude/rules/packer.md`.
- `src/lib/lp-solver.ts` — generic LP wrapper around HiGHS (WASM); N-pass lexicographic. See `.claude/rules/solver.md`.
- `src/lib/highs-wrapper.ts` + `src/lib/highs-singleton.ts` — HiGHS solve seam: per-solve `time_limit = accumulated + budget` compensation for the WASM instance's unresettable run clock, `resetHighs()` self-heal, raw solver status out. See `.claude/rules/solver.md`.
- `src/lib/calc-client.ts` + `src/workers/calc.worker.ts` — worker transport for `calculateProductionPlan`: latest-wins coalescing (`CalcSupersededError`), crash re-dispatch with a per-job retry budget, main-thread fallback. See `.claude/rules/solver.md`.
- `src/lib/target-optimizer.ts` — priority-Max / Fit-to-limits bisection engine (pure; solve injected by the hook). The module JSDoc is the canonical semantics + invariants reference.
- `src/lib/raw-limits-helpers.ts` + `src/data/raw-caps.ts` — per-region default mining caps (AUTO-GENERATED, `extract:raw-caps`) + user-override merge feeding the LP's soft raw caps. See `.claude/rules/raws.md`.
- `src/lib/flow-solver.ts` — `calculateFlows`: one global LP over every recipe in the multi-recipe graph. See `.claude/rules/solver.md`.
- `src/lib/graph-builder.ts` — `buildBipartiteGraph` (all alternative producers, no single-pick) + `detectSCCs` (Tarjan). See `.claude/rules/solver.md`.
- `src/lib/calculator.ts` — orchestrates `calculateProductionPlan` (graph + pre-LP disposal-inject → SCC → LP → pack → prefill → render); also applies the `facilityRecipeVariants` filter so variant recipes (`LIQUID_CLEAN_GATE_1_*`) only enter the LP when their facility cap is positive.
- `src/lib/recipe-reachability.ts` — App-layer chain-reachability closure with `bootstrapFacilities` bypass.
- `src/lib/plan-helpers.ts` — `aggregateBinTotals` + `computeOverCapWarnings` + `buildBinActivitySums`.
- `src/lib/flow-thresholds.ts` — single source of `MIN_VISIBLE_RATE_PER_MIN`.
- `src/components/mappers/{bin-fused,merged}-mapper.ts` — selects on `bf` URL flag + Facility-vs-Recipe view. See `.claude/rules/mappers.md`.
- `src/components/mappers/flow-assertions.ts` — `assertFlowIntegrity` (throws in test).
- `src/hooks/useDomainSettings.ts` + `src/lib/aic-{research-helpers,cascade}.ts` — per-domain settings state. See `.claude/rules/domain-settings.md`.
- `src/contexts/DomainSettingsProvider.tsx` — Context wrapper that broadcasts `useDomainSettings()` + renders `AicOnboardingDialog`.
- `src/hooks/useProductionPlan.ts` — top-level plan orchestration through `calc-client`, optimizer searches (Max / Fit with token + captured-targets cancellation, auto-fit), ineffective-pin detection, `facilityCaps` / `rawMaterialCaps` threading.
- `src/data/index.ts` — `rawMaterialSources`, `rawAvailabilityByDomain`, `costlessRaws`, `forcedDisposalItems`, `bootstrapFacilities`, `facilityRecipeVariants`, `mapPlacedFacilities`; barrel re-exports `defaultRawCapsByDomain`, `regionStructures`, `metastorageSources`/`metastorageExports`. See `.claude/rules/raws.md`.
- `src/data/region-subsystems.ts` — AUTO-GENERATED (`extract:structures`) region subsystems: map-placed structures (`regionStructures`, the `solver: { role, facilityId }` bridge that drives the Settings "Structures" tab + App-layer cap aggregation + variant filter) plus the collapsed capped facility (`regionFacilities`), the disposal/byproduct recipe variants (`regionRecipes`), and the toggle map (`regionFacilityVariants`). Derived from `Factory*PlantStoreTable` + the sibling Import/Export + `FactoryBuildingTable`; merged into `facilities`/`recipes` by the `@/data` barrel. Structure names live in `public/locales/{lang}/structure.json`.
- `src/data/metastorage.ts` — AUTO-GENERATED (`extract:metastorage`) Metastorage Transfer capability: `metastorageSources` (per-source TTV cap/cycle/unlock) + `metastorageExports` (source → item → TTV cost). Feeds the LP import variables (`lp-solver.ts`), the per-route auto-item-selection (`calculator.ts:selectMetastorageImports`), the `useDomainSettings.metastorage` route modes, and the App-layer route resolution + reachability seeding. See `.claude/rules/solver.md` + `domain-settings.md`.
- `src/data/power.ts` — AUTO-GENERATED (`extract:power`) Thermal Bank power generation: the `power_station_1` facility (merged into the `facilities` barrel tail) + `powerFuels` (battery-burn recipes with out-of-band `powerGeneration`; batteries only — ore burning deliberately excluded). Rides `CalculateProductionPlanOptions.powerSustain` (URL flag `ps=1`) into the graph injection + the LP's hard `power_balance` row + the calculator's ceil-floor loop (generation sized to whole-building consumption via `LPPowerBalance.minGeneration`); display side is `aggregateBinTotals.totalPowerGeneration` + the `powerSink` mapper node. See `.claude/rules/solver.md`.

Everything else is discoverable via `ls` / `grep`. Game data: `src/data/{items,recipes,facilities}.ts`; types: `src/types/`; UI: `src/components/`; hooks: `src/hooks/`; tests: `src/tests/lib/`.

## Type system

Two nominal-typing patterns coexist in `src/types/constants.ts`:

**Closed-enum literal-string unions** for IDs from the game-data dump (finite, enumerable):

```typescript
const ItemId = { ITEM_X: "item_x", ... } as const;
type ItemId = (typeof ItemId)[keyof typeof ItemId];
```

`ItemId`, `RecipeId`, and `FacilityId` follow this pattern. A plain `string` cannot satisfy them.

**Brand intersection** for dynamic identifiers (open set):

```typescript
type BinId = string & { readonly __brand: "BinId" };
```

`BinId` is the only one — bin IDs are constructed at runtime by `makeBinId` (`multi-formula-packing.ts:733`).

Domain types in `src/types/{core,production,flow,domain,aic}.ts`. Keep enums in `constants.ts` alphabetised.

## Test conventions

- Tests live in `src/tests/lib/`. Run a single file: `pnpm vitest run <path>`.
- **For latent-bug regressions**: write tests with inline synthetic items + recipes passed to `calculateProductionPlan`. Isolates from upstream-data drift.
- **For upstream-data-triggered bugs**: import real `items` / `recipes` / `facilities`, target specific `ItemId` enum values, assert exact rates.
- Use `toBeCloseTo(value, 3)` for facility counts and rates.
- `flow-integrity.test.ts` is the model for mapper-output assertions. `assertFlowIntegrity` throws in test mode — most mapper bugs surface as test failures before reaching explicit assertions.
- `vite.config.ts:92` sets `testTimeout: 30000` (30s) — matches the packer's `SOLVER_TIME_LIMIT_SECONDS = 30`.
- Solver-transport tests run without WASM: `calc-client.test.ts` stubs `globalThis.Worker` with a recording fake; `highs-wrapper.test.ts` mocks the singleton. Use those as models when testing transport-layer behavior.

## Pre-ship workflow

1. `pnpm run lint` — ESLint clean of new warnings.
2. `pnpm vitest run` — all tests pass.
3. If you touched `src/lib/`: also run targeted suites: `pnpm vitest run src/tests/lib/{calculator,flow-integrity,bin-fusion-mapper,multi-formula-packing}.test.ts`. Solver transport (`calc-client`, `highs-*`) → add `{calc-client,highs-wrapper,lp-solver-status}.test.ts`; optimizer → add `target-optimizer.test.ts`.
4. `pnpm run build` — TypeScript clean and Vite build succeeds.
5. `pnpm run knip` — surface any newly-unused exports.

## Terminology

- `targetRate` (flow node) — per-recipe per-output rate, `calcRate(output.amount, t) * facilityCount`. **Not** the user's request.
- `userTargetRate` / `targetRates: Map<ItemId, number>` — what the user requested via UI.
- `Bin` — packed unit. **Singleton**: 1 recipe. **Grouped**: 2+ recipes co-located in a multi-formula building, sharing inner inventory and port budget.
- **Internal items** — items balanced within a bin (no external port consumption); hidden from edges in bin-fused view.
- **"Backward" edge** — producer and consumer in the same SCC; tagged for distinct visual rendering.
- `plan.lpStatus` — `"ok" | "infeasible" | "solver_error"`. Infeasible = proven no-solution (a verdict); solver_error = the solver itself failed (evidence only — never treat it as infeasible).
- **Max / Fit** — the two optimizer operations (`target-optimizer.ts`): priority-Max bisects one target's maximum under the configured limits; Fit scales all unlocked targets by one λ to feasibility. **Locked** targets are frozen under both.

## Commit convention

- `Add:` new feature
- `Fix:` bug fix
- `Update:` enhancement to existing feature
- `Refactor:` code restructuring

## Path-scoped rules in `.claude/rules/`

These load automatically when Claude reads matching files. Listed by topic:

- `packer.md` — Phase 3 ILP packer, `aggregateBinTotals`, port caps, slot semantics.
- `solver.md` — LP / flow / graph / reachability / bootstrap, lex objectives, pinned-recipe outcomes, solver transport + `lpStatus` semantics.
- `prefill.md` — cycle-prefill two-phase detection (Phase 1 per-bin Tarjan, Phase 2 inter-bin pairs).
- `mappers.md` — bin-fused vs merged vs separated, pickup counts, flow integrity, ELK gotchas.
- `raws.md` — `rawMaterialSources` contract, source facilities, pump-vs-pipe throughput.
- `domain-settings.md` — `useDomainSettings`, AIC research, facility caps, onboarding, two localStorage keys.
- `i18n.md` — 7 locales, auto- vs hand-maintained namespaces, extraction workflow, style + official-glossary terminology conventions.
