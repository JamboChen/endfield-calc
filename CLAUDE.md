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
pnpm run extract:sustain     # Refresh src/data/gas-sustain.ts (1.4 transmuter catalysts + vaporizer envs) + vaporize_* recipe name merges
pnpm run extract:structures  # Refresh src/data/region-subsystems.ts + public/locales/{lang}/structure.json
pnpm run extract:aic         # Refresh src/data/aic-plans.ts + public/locales/{lang}/{aic,domain}.json
pnpm run extract:raw-caps    # Refresh src/data/raw-caps.ts (per-region max mining output, derived from the game data)
pnpm run extract:item-colors # Refresh src/data/item-colors.ts from public/images/items/*.png — STANDALONE, not in extract:all (icons are manually curated); re-run when icons change
pnpm run extract:url-codes   # Refresh src/data/id-codes.ts (stable APPEND-ONLY id→URL-code registries) — STANDALONE + self-contained (parses committed constants.ts + aic-plans.ts, no data dir); re-run after extract:all
pnpm run extract:icons       # Sync missing item/facility icons from the game's icon assets — STANDALONE; run extract:ids first, then extract:item-colors after
```

Game-data refresh: point the extractor at your local game data (it falls back to a built-in default if unset). Note: the extraction toolchain is **intentionally untracked** (gitignored — it stays out of the repo), so the `extract:*` commands only work on a machine that has the private toolchain; every file stamped AUTO-GENERATED can only be regenerated there. `extract:item-colors` and `extract:url-codes` are the exceptions: they read committed files (icons; `constants.ts` + `aic-plans.ts`), need no data dir, and are therefore not part of `extract:all`.

## Cardinal rules (always apply)

**IMPORTANT — every rule below has caused real bugs when violated:**

- **Brand discipline**: never `as ItemId` / `as RecipeId` / `as FacilityId` / `as BinId` in production code. Use `getItemById` or thread the brand through. The only permitted `as BinId` cast is inside `makeBinId` in `multi-formula-packing.ts`.
- **`aggregateBinTotals` (`src/lib/plan-helpers.ts:164`) is the single source of truth** for buildings / power / per-facility totals. Per-recipe-ceiled aggregation triple-counts shared multi-formula bins. Source-facility power (pump_1/pump_2/unloader_1) is folded in here — do NOT re-sum at the caller.
- **`MIN_VISIBLE_RATE_PER_MIN` (`src/lib/flow-thresholds.ts:39`, value `0.001`)** is the shared visibility threshold between the packer and the mappers. Production code must import this constant — bare `0.001` literals are forbidden.
- **`assertFlowIntegrity` throws in test mode** (`import.meta.env.MODE === "test"`), warns in dev, no-ops in production. Mapper regressions surface as hard test failures.
- **"Over-limit" has ONE judge**: `calculateProductionPlan` emits every limit violation (facility/raw caps, metastorage budget, power shortfall) into `plan.warnings`; `OVER_LIMIT_WARNING_KINDS` (`src/lib/plan-helpers.ts`) is the complete kind set. `isPlanFeasible`, the Fit pill, auto-fit, and the badges are all plain scans of the same warnings — never re-derive the verdict from aggregates at a consumer. See `.claude/rules/optimizer.md`.
- **Match existing style**, even where you'd do it differently. This codebase uses closed-enum literal-string unions for game-data IDs and brand intersections for runtime-constructed IDs — see "Type system" below.

## Where critical logic lives

One sentence per file. Deep invariants in `.claude/rules/` load when you touch these files.

- `src/lib/multi-formula-packing.ts` — Phase 3 ILP bin packer. See `.claude/rules/packer.md`.
- `src/lib/lp-solver.ts` — generic LP wrapper around HiGHS (WASM); N-pass lexicographic. See `.claude/rules/solver.md`.
- `src/lib/highs-wrapper.ts` + `src/lib/highs-singleton.ts` — HiGHS solve seam: per-solve `time_limit = accumulated + budget` compensation for the WASM instance's unresettable run clock, `resetHighs()` self-heal, raw solver status out. See `.claude/rules/solver.md`.
- `src/lib/calc-client.ts` + `src/workers/calc.worker.ts` — worker transport for `calculateProductionPlan` AND the optimizer searches (`searchMaximize`/`searchFit` run a whole Max/Fit search as ONE in-worker job with a `cancel()` handle): latest-wins solve slot + separate search slot, crash re-dispatch with a per-job retry budget, main-thread fallback. See `.claude/rules/solver.md` + `optimizer.md`.
- `src/lib/target-optimizer.ts` — priority-Max / Fit-to-limits bisection engine (pure; solve injected — the worker in production, direct calls in tests). The module JSDoc is the canonical semantics + invariants reference. See `.claude/rules/optimizer.md`.
- `src/lib/optimizer-orchestration.ts` — pure reducer for the optimizer gesture bookkeeping (auto-fit one-shot guard, protected-demand exclusion, Max marks). See `.claude/rules/optimizer.md`.
- `src/hooks/useTargetOptimizer.ts` — Max / Fit / auto-fit orchestration: worker searches with token + captured-targets commit gates, cancellation on targets/config identity change, toasts + Restore. See `.claude/rules/optimizer.md`.
- `src/lib/raw-limits-helpers.ts` + `src/data/raw-caps.ts` — per-region default mining caps (AUTO-GENERATED, `extract:raw-caps`) + user-override merge feeding the LP's soft raw caps. See `.claude/rules/raws.md`.
- `src/lib/flow-solver.ts` — `calculateFlows`: one global LP over every recipe in the multi-recipe graph. See `.claude/rules/solver.md`.
- `src/lib/graph-builder.ts` — `buildBipartiteGraph` (all alternative producers, no single-pick) + `detectSCCs` (Tarjan). See `.claude/rules/solver.md`.
- `src/lib/calculator.ts` — orchestrates `calculateProductionPlan` (graph + pre-LP disposal-inject → SCC → LP → pack → prefill → render); also applies the `facilityRecipeVariants` filter so variant recipes (`LIQUID_CLEAN_GATE_1_*`) only enter the LP when their facility cap is positive.
- `src/lib/recipe-reachability.ts` — App-layer chain-reachability closure with `bootstrapFacilities` bypass.
- `src/lib/plan-helpers.ts` — `aggregateBinTotals` + `computeLimitViolations` (the calculator's over-limit judge) + `OVER_LIMIT_WARNING_KINDS` + `buildBinActivitySums`.
- `src/lib/flow-thresholds.ts` — single source of `MIN_VISIBLE_RATE_PER_MIN`.
- `src/components/mappers/{bin-fused,merged}-mapper.ts` — selects on `bf` URL flag + Facility-vs-Recipe view. See `.claude/rules/mappers.md`.
- `src/components/mappers/flow-assertions.ts` — `assertFlowIntegrity` (throws in test).
- `src/hooks/useDomainSettings.ts` + `src/lib/aic-{research-helpers,cascade}.ts` — per-domain settings state. See `.claude/rules/domain-settings.md`.
- `src/contexts/DomainSettingsProvider.tsx` — Context wrapper that broadcasts `useDomainSettings()` + renders `AicOnboardingDialog`.
- `src/hooks/useProductionPlan.ts` — top-level plan orchestration: the `calcProblem` memo (the ONE problem-definition bundle shared by the display calc and the optimizer searches), plan/warnings derivation off `plan.warnings`, ineffective-pin detection, `facilityCaps` / `rawMaterialCaps` threading, the auto-prune effect, and the save/open + URL-sync effects; delegates Max/Fit/auto-fit to `useTargetOptimizer` and every pure concern to the `plan-*` lib modules below. Takes ONE options object (like `useTargetOptimizer`), destructured at the top so dep arrays keep referring to plain values.
- `src/lib/plan-url.ts` — the plan ⇄ URL layer, all pure: `encodeHashToken`/`decodeHash` (the opaque `#0dD0…` token, which is also the ONLY place compression happens), `serializeHash`/`parseHash` (the hash body), and `PlanHashState` (the plan). The two halves are **provable inverses** — `plan-hash.test.ts` round-trips them as a property, which is what catches a field added to one and forgotten in the other. `serializeHash` emits **nothing for a target-less plan** (options and the settings blob describe no plan alone, so an empty app keeps a hash-less URL) and omits any option equal to `DEFAULT_PLAN_OPTIONS` — which is why an absent param means "the sharer had the default", never "unspecified". `parseHash` clamps to `MAX_TARGETS`: a link is an untrusted artifact.
- `src/lib/plan-share-codec.ts` — the `s=` settings blob: a **per-top-level-field delta** from `DEFAULT_PERSISTED_SHAPE`, serialized to a compact non-JSON string (fields delimited by their uppercase letter, `~` within). `DELTA_KEYS` has a build-time completeness guard — adding a `PersistedShape` field without listing it fails the build, because otherwise every shared link would silently omit it. Decoding always ends at `sanitizePersistedShape`, so a cross-version blob degrades instead of reaching the solver.
- `src/lib/persisted-shape.ts` — `PersistedShape` + `sanitizePersistedShape` / `canonicalizeShape` / `loadPersistedShape` / the compose+persist pair. Lives in `lib/` because three consumers need it and only one is a hook. **`sanitizePersistedShape` is the single validation path** for every settings payload (localStorage, shared link, saved file) and therefore the trust boundary for URL content — tested directly against hostile input.
- `src/lib/plan-file.ts` — the saved-plan file format (`SavedPlan`) + `buildSavedPlan` / `savedPlanToHashState` / `readSavedSettings`. A **versioned wire format**, deliberately not coupled to the internal types. `readSavedSettings` returns `null` for a settings block that fails validation: damage must read as ABSENT, never as "valid, all default", or opening your own damaged file drops you into read-only shared-view against the pre-onboarding world.
- `src/lib/plan-prune.ts` — `computePlanPrune`: what a plan must drop to stay honourable under the current settings. Suppressed entirely while `onboardingPending`, because the pre-onboarding defaults are STRICTER than the all-checked default the dialog is about to apply, and the prune is destructive.
- `src/lib/plan-options-storage.ts` — the four plan options (`ceilMode`, `binFusion`, `powerSustain`, `machinesPerVaporizer`) as persisted preferences (`endfield-calc:plan-options-v1`). **Precedence is all-or-nothing**: `serializeHash` omits default-valued options, so an absent param in a link means "the sharer had the default" — consulting preferences per-key would reproduce a shared plan with the wrong options. A hash ⇒ options come wholly from the URL; no hash ⇒ from preferences, else defaults. Writes are **per key, on setter calls only** (never on mount), so opening someone else's link can't fold their options into the viewer's preferences.
- `src/data/index.ts` — `rawMaterialSources`, `rawAvailabilityByDomain`, `costlessRaws`, `forcedDisposalItems`, `bootstrapFacilities`, `facilityRecipeVariants`, `mapPlacedFacilities`; barrel re-exports `defaultRawCapsByDomain`, `regionStructures`, `metastorageSources`/`metastorageExports`. See `.claude/rules/raws.md`.
- `src/data/region-subsystems.ts` — AUTO-GENERATED (`extract:structures`) region subsystems: map-placed structures (`regionStructures`, the `solver: { role, facilityId }` bridge that drives the Settings "Structures" tab + App-layer cap aggregation + variant filter) plus the collapsed capped facility (`regionFacilities`), the disposal/byproduct recipe variants (`regionRecipes`), and the toggle map (`regionFacilityVariants`). Derived from the game data (map structures + their import/export); merged into `facilities`/`recipes` by the `@/data` barrel. Structure names live in `public/locales/{lang}/structure.json`.
- `src/data/metastorage.ts` — AUTO-GENERATED (`extract:metastorage`) Metastorage Transfer capability: `metastorageSources` (per-source TTV cap/cycle/unlock) + `metastorageExports` (source → item → TTV cost). Feeds the LP import variables (`lp-solver.ts`), the per-route auto-item-selection (`calculator.ts:selectMetastorageImports`), the `useDomainSettings.metastorage` route modes, and the App-layer route resolution + reachability seeding. See `.claude/rules/solver.md` + `domain-settings.md`.
- `src/data/gas-sustain.ts` — AUTO-GENERATED (`extract:sustain`) 1.4 gas-sustain model: `facilitySustainDrains` (transmuter catalyst fuel, 6/min per building at 100% duty — 1 unit = 10 s of working time, charge load-proportional) + `vaporizerEnvs` (env id → gas + synthetic zero-output `vaporize_*` recipe). ALWAYS ACTIVE in the calculator (unlike `powerSustain`): catalyst folds into transmuter recipe clones at graph build as `rate × fc_r` (plan surfaces the decomposition as the `ProductionGraphNode.catalyst` contract — display code reads that, never game data); the ceil-floor loop forces whole always-on vaporizers per `Recipe.gasEnv` group via `LPInput.recipeMinRates` (shared-aura uptime = union of unsynchronized machine duties ≈ 100%). Coverage ratio = `machinesPerVaporizer` plan option (URL `mpv`, default 4 from `src/lib/sustain-constants.ts` — UI-safe, keeps the solver code-split). See `.claude/rules/solver.md`.
- `src/data/power.ts` — AUTO-GENERATED (`extract:power`) Thermal Bank power generation: the `power_station_1` facility (merged into the `facilities` barrel tail) + `powerFuels` (battery-burn recipes with out-of-band `powerGeneration`; batteries only — ore burning deliberately excluded). Rides `CalculateProductionPlanOptions.powerSustain` (URL flag `ps=1`) into the graph injection + the LP's hard `power_balance` row + the calculator's ceil-floor loop (generation sized to whole-building consumption via `LPPowerBalance.minGeneration`); display side is `aggregateBinTotals.totalPowerGeneration` + the `powerSink` mapper node. See `.claude/rules/solver.md`.
- `src/data/id-codes.ts` + `src/lib/url-codes.ts` — AUTO-GENERATED (`extract:url-codes`) **stable, APPEND-ONLY** id→URL-code registries (code = base36 array index) + the `makeRefCodec`-built `encode*Ref`/`decode*Ref` helpers that shorten ids in the URL: items (`t`/`r`/`m` plan params + the `s=` settings `R` field), recipes (`r`), facilities (`s=`'s `A` field), structures (`S`), AIC techs (`A`). **Codes must never change or be reused** — shared URLs reference them — so the generator ONLY appends: it never reorders, and departed ids keep their slot (named) forever. Liveness is not stored; `makeRefCodec` resolves a code only for ids present in the live game data, so a removal needs no regeneration and a restored id gets its original code back. The registry is therefore a deliberate superset of the `constants.ts` enums, which shed removals and are sorted — **never derive codes from them**. Codes are lowercase base36, which keeps the settings blob's uppercase-letter field delimiter unambiguous. `decode*Ref` also accepts full ids (legacy-link back-compat) and returns `null` for ids absent at runtime, so it doubles as the existence check. In `url-codes.test.ts`, the completeness guard fails if a new id lacks a code and the pinned-code test fails if an existing code moves (every other assertion there passes under a wholesale renumber). Tech codes matter most: the settings delta is per-top-level-field, so researching one node emits the WHOLE unresearched list, and those ids average 22 chars — coding them took a realistic shared URL from 718 to 137 chars. `AicTechId` is a brand rather than a `constants.ts` enum, so its registry is sourced from `aic-plans.ts`.

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
3. If you touched `src/lib/`: also run targeted suites: `pnpm vitest run src/tests/lib/{calculator,flow-integrity,bin-fusion-mapper,multi-formula-packing}.test.ts`. Solver transport (`calc-client`, `highs-*`) → add `{calc-client,highs-wrapper,lp-solver-status}.test.ts`; optimizer → add `{target-optimizer,optimizer-orchestration}.test.ts`.
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
- `optimizer.md` — Max/Fit/auto-fit stack: over-limit single-judge contract, probe≡UI, wedge tripwire, orchestration reducer transitions, in-worker search protocol.
- `prefill.md` — cycle-prefill two-phase detection (Phase 1 per-bin Tarjan, Phase 2 inter-bin pairs).
- `mappers.md` — bin-fused vs merged vs separated, pickup counts, flow integrity, ELK gotchas.
- `raws.md` — `rawMaterialSources` contract, source facilities, pump-vs-pipe throughput.
- `domain-settings.md` — `useDomainSettings` + `persisted-shape.ts`, AIC research, facility caps, onboarding, read-only shared-view, the localStorage keys.
- `i18n.md` — 7 locales, auto- vs hand-maintained namespaces, extraction workflow, style + official-glossary terminology conventions.
