---
paths:
  - "src/hooks/useDomainSettings.ts"
  - "src/lib/persisted-shape.ts"
  - "src/lib/plan-share-codec.ts"
  - "src/lib/plan-options-storage.ts"
  - "src/lib/onboarding-storage.ts"
  - "src/lib/plan-prune.ts"
  - "src/lib/aic-cascade.ts"
  - "src/lib/aic-research-helpers.ts"
  - "src/contexts/DomainSettingsProvider.tsx"
  - "src/contexts/domain-settings-context.ts"
  - "src/components/settings/**"
  - "src/components/onboarding/**"
  - "src/components/production/ProductionTable.tsx"
  - "src/hooks/useProductionPlan.ts"
  - "src/data/aic-plans.ts"
  - "src/types/aic.ts"
  - "src/types/domain.ts"
  - "src/tests/lib/aic-*.test.ts"
---

# Per-domain settings, AIC research, facility caps

## State ownership

- `useDomainSettings` (`src/hooks/useDomainSettings.ts`) owns the user-controlled state: domain activation + AIC research (deny-list) + facility cap overrides. It returns a `DomainSettingsValue` shape with `{ domains, activeDomains, toggleDomain, applyOnboardingChoices, aic: {...} }`.
- `DomainSettingsProvider` (`src/contexts/DomainSettingsProvider.tsx`) calls `useDomainSettings()` once at the root and broadcasts via Context (`domain-settings-context.ts`). Consumers read with `useDomainSettingsContext()`. **Without the provider, each consumer would get its own `useState` instance** — settings in the sheet wouldn't reach the calc.
- `src/lib/aic-research-helpers.ts` — pure derivation functions (`computeUnlockedFacilities`, `computeUnlockedModes`, `computeEffectiveCaps`, `capKey`, `isGroupAtDefaults`).
- `src/lib/aic-cascade.ts` — pure DAG-cascade primitives (`buildNodeIndex`, `cascadeActivate`, `cascadeDeactivate`, `previewActivationDelta`).

## Domain vs category split

`useDomainSettings` is intentionally a "domain-settings umbrella":
- Domain-level concerns at the top (`domains`, `activeDomains`, `toggleDomain`, `applyOnboardingChoices`).
- Per-category sub-states nested under their own keys: `aic`, `rawLimits`, `structures`. Future categories (power budget, …) add new peer sub-objects without disturbing existing call sites.

## Region structures (`structures` sub-state + "Structures" tab)

Region-exclusive **map structures** the user opts into (not roster/AIC buildings). Today: the Wuling Purification Node (3 Sewage Inlets + 1 Byproduct Outlet, a linear prereq chain). **Wired to the solver** via `facilityRecipeVariants` + the App-layer bridge in `src/App.tsx`.

- **Registry** (AUTO-GENERATED — `pnpm run extract:structures`): `src/data/region-subsystems.ts` → `regionStructures: ReadonlyMap<DomainId, readonly RegionStructure[]>`. Each entry carries `requires` (the chain), `nodeId` / `index` / `iconSlug` (display; names resolve from the `structure` locale namespace), and a `solver: { role, facilityId }` discriminator. The structure's `id` is the upstream game building id verbatim (e.g. `liquid_clean_gate_1`):
  - `role: "instance"` — each enabled instance adds +1 to `facilityCaps[facilityId]` (Sewage Inlets 1/2/3 contribute to `LIQUID_CLEAN_GATE_1`).
  - `role: "recipeToggle"` — when enabled, the facility's `toggled` variant (declared in `facilityRecipeVariants`, `src/data/index.ts`) becomes **additionally** available alongside the `default` — it is ADDITIVE, not a swap (issue #90). The Byproduct Outlet makes `LIQUID_CLEAN_GATE_1_BYPRODUCT` available next to `…_DISPOSAL`, sharing the facility cap; the LP recycles sewage into xiranite_poly up to real downstream demand and disposes the rest via the 0 W pure sink.
  - The structure carries no rate numbers — those live on the real `Recipe` entries pointed to by `facilityRecipeVariants`. Single source of truth between what the UI annotates and what the LP runs.
- IDs are a closed `RegionStructureId` enum (`constants.ts`), kept distinct from `FacilityId` because a structure is conceptually a user-facing toggle that *maps to* a facility, not a facility itself.
- **State**: `structures.enabled: ReadonlySet<string>` keyed by `structureKey(domainId, structureId)`; `structures.toggle(domainId, id)` enforces the chain via `cascadeStructureChain` (enable pulls prereqs, disable drops dependents). **Allow-list, default off** (opt-in) — the opposite of AIC's deny-list-all-on default.
- **App-side bridge** (`src/App.tsx`):
  - `facilityCaps` memo adds `+1` per enabled `role: "instance"` structure across active domains, on top of the AIC `effectiveCaps` aggregation.
  - `structureVariantExcluded` memo walks `facilityRecipeVariants` × `regionStructures` × enabled set. Per variant facility: no `instance` enabled → exclude **both** variants; `instance` enabled + toggle OFF → exclude the `toggled` variant (only the pure-sink `default`); `instance` enabled + toggle ON → exclude **nothing** (both variants kept — the toggle is additive, issue #90). Applied to `availableRecipes` BEFORE reachability so excluded variants can't leak into the LP.
- **Calculator defence**: `calculator.ts` mirrors the variant filter (`optInVariantRecipeIds`) so direct callers (tests, future programmatic entry points) get the same semantics without having to pass the App-side filter.
- **Row UX (shared with Limits cap-raises)**: rows whose prereq isn't enabled yet are faded (`opacity-55`) as a "level" hint, but stay clickable — clicking cascades the prereqs in. This is the lenient model; the Plan tab (`AicNodeRow`) stays strict (locked rows disabled).
- **UI**: `StructuresContent.tsx` in a region-conditional "Structures" tab (`RegionConfigTabs`). The tab only renders for regions present in `regionStructures`. Per-row "Treats X" / "Produces Y" annotation is derived from the real `Recipe` data via `facilityRecipeVariants` (inlet → default recipe's first input; outlet → toggled recipe's first output).
- Pure helpers in `settings-helpers.ts`: `structureKey`, `cascadeStructureChain`, `countRegionStructuresEnabled` (all unit-tested).

## Metastorage (`metastorage` sub-state + "Metastorage" tab)

Per-**source**-region outbound route mode for Metastorage Transfer: `"auto"` (default — exports to whichever region is being planned) / `"disabled"` / a locked destination `DomainId`. State: `metastorage.routeModes` (materialized for every key of `metastorageSources`; in-memory map stores deviations only) + `setRouteMode(source, mode)` (validates capability, rejects self-routes/unknown destinations; `"auto"` deletes the entry). Persisted as the deviations-only `metastorage.routes` block (absent = all auto); loader drops unknown/incapable sources, `mode === source`, unknown destinations — dropping re-defaults to auto.

App bridge (`src/App.tsx`): source `S` feeds the `currentDomain = D` plan iff `S ∈ metastorageSources ∧ S ≠ D ∧ S active ∧ mode ∈ {"auto", D}`. Resolved routes become `MetastorageRouteConfig[]` (budget/min + `cycleSeconds` + full eligible `itemCosts`); their items seed `computeRecipeReachability` (4th param — configuration-level capability, unlike manual raws) AND the `useProductionPlan` auto-prune (import-only targets survive while a route is live).

UI: `MetastorageContent` in a region-conditional tab that renders for **source-capable** regions only (`metastorageSources.has(editingDomain)`) — the inverse of every other tab's "destination-side" framing. No item picker by design (auto-selection is the calculator's job).

## Conditional + controlled tabs

`RegionConfigTabs` renders a tab only when its region has content: Plan (has groups), Limits (`countFacilityCapTargets > 0`), Resources (has raws), Structures (has registry entries), Metastorage (source-capable regions). Plan/Resources are effectively always present. Tabs are **controlled** with `resolveActiveTab(activeTab, availableTabs)` so switching to a region lacking the selected tab falls back to the first available tab instead of leaving a dangling selection.

## Persistence (verified)

- **Channel namespacing**: every localStorage key in this file is the *base* (production) value. Beta builds (served at `/endfield-calc/beta/`) suffix all keys with `:beta` via `namespaceStorageKey` (`src/lib/storage-namespace.ts`), so on beta these become `endfield-calc:aic-v1:beta` and `endfield-calc:onboarding-v1:beta`. The two channels share an origin and would otherwise collide. New persisted keys MUST go through `namespaceStorageKey` for the same reason.
- The shape, its migration and its validation live in `src/lib/persisted-shape.ts`, NOT in the hook — `plan-share-codec.ts` and the saved-file loader need them too, and a `lib/` module importing a hook was the wrong way round.
- Sole version signal: the localStorage key `endfield-calc:aic-v1`. No `v` field inside the JSON.
- Loader detects shape: nested `{ domains, aic }` is current; flat `{ unresearched, capOverrides, inactiveDomains? }` is v1, migrated in-memory and re-written nested on next save.
- AIC sub-state uses a **deny-list** for research (`aic.unresearched`); domains use a **deny-list** for activation (`domains.inactive`). `rawLimits.overrides` + `structures.enabled` are **allow-lists** (optional keys; absent in older payloads).
- Defensive filter on load: drops tech / domain / cap-override / raw-limit / structure entries whose IDs no longer exist in data (e.g. after an `extract:aic` run, or a `regionStructures` change).

## First-run state

- `inactiveDomains` = `{ d ∈ domains : !d.isPinned }`. Pinned domain (`domain_1`, Valley IV, `sortId === 1`) always active.
- `researched` = for each node: researched iff its domain is active OR `node.alreadyUnlocked`. Active-domain nodes default to "all researched" (Step 1 default); inactive-domain nodes get the game-default subset only.

## Soft deactivation

`toggleDomain` only mutates `inactiveDomains`. `researched` is preserved across activation flips — re-activating restores prior research state automatically. Pinned domains refuse deactivation silently.

## Onboarding dialog

`AicOnboardingDialog` (`src/components/onboarding/AicOnboardingDialog.tsx`) is rendered by `DomainSettingsProvider` as a sibling of children. Shown once per browser, gated on localStorage key **`endfield-calc:onboarding-v1`** — a separate key from the AIC state.

The flag is NOT read by the dialog. `useDomainSettings` holds it as `onboardingPending` state and clears it via `completeOnboarding`, because **other code waits on it**: the plan auto-prune (`computePlanPrune`) is suppressed until onboarding is answered. The pre-onboarding defaults deactivate every non-pinned domain, so they are stricter than the all-checked default the dialog is about to apply — pruning against them would delete targets the user is one click away from being able to build, irreversibly. The dialog therefore applies choices FIRST and clears the flag second.

`applyOnboardingChoices` does the bulk apply atomically (one `setInactiveDomains` + one `setResearched` so the persist effect fires once).

## Read-only shared-view

Opening a link (or a saved file) whose embedded settings differ from the viewer's own puts the hook in **read-only shared-view**: it seeds from the snapshot instead of localStorage and `isSharedView` is true.

- **Hard invariant: localStorage is never written while viewing someone else's plan.** Enforced twice — every mutator early-returns on `readOnlyRef.current`, and the persist effect returns on `readOnly`. Do not add a mutator without the guard.
- `isSharedView` is the ONE read-only signal for the UI. `sharedDiff` / `changedNodes` are for ACCENTS only — never derive the mode from them (an empty diff would silently unlock the sheet).
- **Freezing a sub-tab body has two mechanisms, and picking the wrong one costs navigation.** Flat bodies (Resources / Structures / Metastorage) get a `<fieldset disabled>` in `RegionConfigTabs`. Bodies with collapsible cards (Plan / Limits) must instead take a `readOnly` prop and disable their own controls: a disabled `fieldset` disables EVERY descendant form control per the HTML spec, including the `SettingsCard` header `<button>` that expands/collapses the card and any info-popover trigger — so the viewer can no longer navigate what they are allowed to read. Per-card write actions are hidden rather than disabled. Guarded by `src/tests/dom/settings-read-only.test.tsx`.
- Exits: `importSharedPlan` adopts the snapshot as the viewer's own (and marks onboarding answered, since that is a deliberate configuration choice); `exitSharedPlan` restores their own settings and deliberately does NOT mark onboarding — a viewer who never onboarded has nothing to clobber, so the first-visit dialog is the correct prompt there.
- The dialog is suppressed during shared-view, so a never-onboarded viewer answers it only after leaving.

## Per-plan reset

`aic.resetGroupToDefaults(groupId)` resets only that group's nodes to `researched.has(n.id) === n.alreadyUnlocked`. Other groups untouched. `aic.isAtDefaultsByGroup.get(groupId)` drives the Reset button visibility in `AicPlanContent` (the Plan sub-tab body).

## Facility caps + over-cap warnings (verified pipeline)

- User-overridable per-(facility, domain) caps live in `aic.capOverrides: ReadonlyMap<string, number>` keyed by `capKey(facilityId, domainId)` = `${facilityId}\u0000${domainId}`.
- **An override value is validated at three layers, and they must agree** (same contract as raw limits): the input rejects and toasts, `setCapOverride` rejects as the net for every non-UI caller (URL, saved file, programmatic), and `sanitizePersistedShape` rejects at rest. A value accepted by fewer layers than the others applies to the LP for one session and then vanishes on reload. Today's rule is finite and `>= 0`; `computeEffectiveCaps` passes the override straight through (`override ?? base + raises`), so nothing downstream re-checks it.
- `aic.effectiveCaps` derives `base + raises` (or override if set) per facility per domain.
- `App.tsx` builds the aggregate `facilityCaps: ReadonlyMap<FacilityId, number>` (sum across active domains of `effectiveCaps`, PLUS `+1` per enabled `role: "instance"` structure) and threads it into:
  1. The **LP** (`lp-solver.ts` per-facility cap constraint) — soft upper bound with `SLACK_PENALTY`: `Σ_{r : r.facilityId === F} x_r ≤ cap + slack`. The penalty makes the LP respect the cap whenever any alternative producer exists; slack engages only when demand is otherwise infeasible.
  2. The **packer** (`multi-formula-packing.ts` cap constraints) as the second line of defence (kept post-LP cap-aware so the integer packing also respects the cap). Only multi-formula (cacheSlots) facilities pass through the MIP — single-formula facilities emit singleton bins that bypass it.
  3. `computeOverCapWarnings(aggregates.physicalPerFacility, facilityCaps)` (`plan-helpers.ts`, called by the calculator at plan assembly via `computeLimitViolations`) — the diagnostic emission into `plan.warnings`, on **always-ceiled physical placement counts** (in-game caps are hard limits on whole buildings; fractional usage that fits can still fragment into more placements than the cap — the Forge-of-the-Sky 12.0-fractional/13-physical case). Emits `{ kind: "facility-over-cap", facilityId, used, cap }` per offending facility, `used` integer. Covers BOTH recipe-bin facilities AND pickup-point source facilities (pump_1, pump_2, unloader_1) uniformly through `aggregateBinTotals.physicalPerFacility`.
- The packer does NOT emit `facility-over-cap` warnings itself. That separation is load-bearing — see `multi-formula-packing.ts`.
- **Cap = 0 vs absent**: absence is "no constraint" (uncapped). `cap: 0` is "forbid this facility". The `facilityRecipeVariants` filter in `calculator.ts` uses this distinction to gate variant recipes (`LIQUID_CLEAN_GATE_1_*`): absent → variants dropped; positive → variants available; 0 → variants dropped.

## Extraction (`pnpm run extract:aic`)

- `pnpm run extract:aic` regenerates `src/data/aic-plans.ts` + `public/locales/{lang}/aic.json` + `public/locales/{lang}/domain.json` from the game data.
- **Hybrid cap-raise detection**: techs that aren't explicit cap-raises but whose unlock reward includes an `item_factech_*_amount_*` milestone item get a synthesised `capRaise` action. The delta is parsed from the tech's English description (`+N` regex) and self-checked against the explicit cap-raise deltas. Currently one such case: `tech_jinlong_3_xiranite_enr_formula` ("Forge Expansion III", +4). Display label is overridden to the milestone item's name.
- **Layer name normalisation**: Title-Case at extraction (`"WULING AIC I"` → `"Wuling AIC I"`), preserving ≤3-char upper-case tokens (catches "AIC") and roman numerals.
- **Domain registry**: emits `export const domains: readonly Domain[]` from the game data. `isPinned` derived from the domain's sort order. Color sourced from the game data. Each domain's `name` lives in `domain.json` per locale.

## Type split

- `src/types/domain.ts` — generic `DomainId` brand + `Domain` registry shape.
- `src/types/aic.ts` — AIC-specific (`AicGroupId`, `AicLayerId`, `AicNode`, `AicTechId`, `FacilityBaseCap`) and imports `DomainId` from `domain.ts`.
- Future per-domain categories add their own type files alongside.

## UI components (`src/components/settings/`)

The panel is a region **navigator + sub-tabs** (the old per-domain
`DomainSection` accordion is retired).

- `SettingsSheet.tsx` — top-level container. Owns local `editingDomain` (the "Configuring" context), initialised to `currentDomain`, re-synced on each closed→open transition (the sheet stays mounted), and guarded by `resolveEditingDomain` (`src/lib/settings-helpers.ts`) when a region is deactivated mid-session. Composes `RegionNavMenu` + `RegionConfigTabs` and owns the toast-wrapped AIC handlers (cascade deltas, prereq warning, reset).
- `RegionNavMenu.tsx` — dropdown that is both region navigator and roster. Per-row `Switch` toggles activation (hidden for the pinned/home region); clicking a name sets `editingDomain`; activating an inactive region auto-selects it. Owns the deactivate-current-factory fallback toast (moved here from `SettingsSheet`).
- `RegionConfigTabs.tsx` — Plan / Limits / Raws sub-tabs for the edited region, with word-labeled count badges derived via `settings-helpers` (`countAicResearched` / `countCustomizedCaps` / `countRawSourced`). The trigger `CountBadge` is `hidden sm:inline-flex` so 4 tab labels fit at ~331px; the in-panel status line still shows counts on mobile.
- `SettingsCard.tsx` — **the single shared card chrome for every sub-tab** (collapsible or static). Header is a flex row: `title` + optional `icon`/`badge` + an `actions` slot rendered OUTSIDE the `CollapsibleTrigger` (you can't nest a `<button>` in the trigger button), which is why the old absolute-positioned activate/reset hack is gone. Also exports `settingsRowClass`: the shared responsive row spec (`min-h-[44px] py-2` touch target on mobile, `sm:min-h-0 sm:py-1.5` compact on desktop). It is layout-only — callers add their own bg/hover/state classes via `cn(settingsRowClass, ...)`. Responsive sizing convention across the tabs: numeric inputs `h-9 sm:h-7`, header icon buttons `size-9 sm:size-7`.
- `AicPlanContent.tsx`, `FacilityLimitsContent.tsx`, `RawLimitsContent.tsx`, `StructuresContent.tsx` — tab bodies; all route their cards through `SettingsCard` and their rows through `settingsRowClass`. `CapTargetRow` (in FacilityLimitsContent) and `RawLimitRow` (in RawLimitsContent) are internal. Limits flattens the old Game/Custom/Effective grid into one row (custom input + muted game-limit hint; effective stays in the header pill). Limits cap-raise rows + Structures rows share the lenient faded-but-clickable model: an unresearched cap-raise click routes through `onActivateRaiseNodes` (`cascadeActivate`, pulls prereqs) instead of the strict `onToggle`; unchecking still uses `onToggle` -> `cascadeDeactivate`. Per-row resets removed: Raws has a tab-level "Clear all" (in the card `actions` slot); Limits has a per-building "Reset to base limit" (unresearch cap-raises via `aic.deactivateNodes` + clear override).
- `AicLayer.tsx`, `AicNodeRow.tsx` — AIC sub-components; `AicLayerSection` renders through `SettingsCard`, `AicNodeRow` through `settingsRowClass`.
- `RegionPicker.tsx` — current-factory-region picker; mounted in `AppHeader` (interim home), not in Settings.
- A new per-domain category adds a sub-tab to `RegionConfigTabs` (state still nests under a new `useDomainSettings` sub-object, as below).

## DO NOT

- DO NOT bypass `DomainSettingsProvider` and call `useDomainSettings()` from a leaf component. Multiple instances → settings made in the sheet won't reach the calc.
- DO NOT mutate `aic.researched` when toggling a domain. `toggleDomain` only touches `inactiveDomains` so soft preservation works.
- DO NOT emit `facility-over-cap` warnings from the packer. That kind is emitted by the calculator at plan assembly (`computeLimitViolations` → `computeOverCapWarnings`) so it uniformly covers recipe bins + pickup-point source facilities.
- DO NOT add a `v` field inside the JSON payload. The localStorage key (`endfield-calc:aic-v1`) is the sole version signal. The shape-detection loader handles migration.
- DO NOT add new state to `useDomainSettings` at the top level when it's category-specific. Nest it under a new sub-object alongside `aic` (e.g. `regionLimits: {...}`).
- DO NOT confuse the two localStorage keys: `endfield-calc:aic-v1` (settings state) vs `endfield-calc:onboarding-v1` (onboarding dialog seen-flag).
