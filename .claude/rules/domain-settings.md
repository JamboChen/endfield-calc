---
paths:
  - "src/hooks/useDomainSettings.ts"
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

Region-exclusive **map structures** the user opts into (not roster/AIC buildings; not yet wired to the solver). Today: the Wuling Purification Node (3 Sewage Inlets + 1 Byproduct Outlet, a linear prereq chain).

- **Registry** (hand-curated, lightweight): `src/data/region-structures.ts` → `regionStructures: ReadonlyMap<DomainId, readonly RegionStructure[]>`. Captures `requires` (the chain), `kind` (sink/source), and game recipe numbers (from `FactorySewageTreat{Import,Export}Table` + `FactorySewageTreatPlantStoreTable`) for the future solver step. IDs are a closed `RegionStructureId` enum (`constants.ts`), kept distinct from `FacilityId` (these are not wired facilities).
- **State**: `structures.enabled: ReadonlySet<string>` keyed by `structureKey(domainId, structureId)`; `structures.toggle(domainId, id)` enforces the chain via `cascadeStructureChain` (enable pulls prereqs, disable drops dependents). **Allow-list, default off** (opt-in) — the opposite of AIC's deny-list-all-on default.
- **Row UX (shared with Limits cap-raises)**: rows whose prereq isn't enabled yet are faded (`opacity-55`) as a "level" hint, but stay clickable — clicking cascades the prereqs in. This is the lenient model; the Plan tab (`AicNodeRow`) stays strict (locked rows disabled).
- **UI**: `StructuresContent.tsx` in a region-conditional "Structures" tab (`RegionConfigTabs`). The tab only renders for regions present in `regionStructures`.
- Pure helpers in `settings-helpers.ts`: `structureKey`, `cascadeStructureChain`, `countRegionStructuresEnabled` (all unit-tested).

## Conditional + controlled tabs

`RegionConfigTabs` renders a tab only when its region has content: Plan (has groups), Limits (`countFacilityCapTargets > 0`), Resources (has raws), Structures (has registry entries). Plan/Resources are effectively always present. Tabs are **controlled** with `resolveActiveTab(activeTab, availableTabs)` so switching to a region lacking the selected tab falls back to the first available tab instead of leaving a dangling selection.

## Persistence (verified)

- Sole version signal: localStorage key `endfield-calc:aic-v1` (line 96). No `v` field inside the JSON.
- Loader detects shape (line 217-224): nested `{ domains, aic }` is current; flat `{ unresearched, capOverrides, inactiveDomains? }` is v1, migrated in-memory and re-written nested on next save.
- AIC sub-state uses a **deny-list** for research (`aic.unresearched`); domains use a **deny-list** for activation (`domains.inactive`). `rawLimits.overrides` + `structures.enabled` are **allow-lists** (optional keys; absent in older payloads).
- Defensive filter on load: drops tech / domain / cap-override / raw-limit / structure entries whose IDs no longer exist in data (e.g. after an `extract:aic` run, or a `regionStructures` change).

## First-run state

- `inactiveDomains` = `{ d ∈ domains : !d.isPinned }`. Pinned domain (`domain_1`, Valley IV, `sortId === 1`) always active.
- `researched` = for each node: researched iff its domain is active OR `node.alreadyUnlocked`. Active-domain nodes default to "all researched" (Step 1 default); inactive-domain nodes get the game-default subset only.

## Soft deactivation

`toggleDomain` only mutates `inactiveDomains` (lines 360-365). `researched` is preserved across activation flips — re-activating restores prior research state automatically. Pinned domains refuse deactivation silently.

## Onboarding dialog

`AicOnboardingDialog` (`src/components/onboarding/AicOnboardingDialog.tsx`) is rendered by `DomainSettingsProvider` as a sibling of children. It's self-gating against localStorage key **`endfield-calc:onboarding-v1`** (line 81) — a separate key from the AIC state. Shown once per browser. `applyOnboardingChoices` (`useDomainSettings.ts:367-383`) does the bulk apply atomically (one `setInactiveDomains` + one `setResearched` so the persist effect fires once).

## Per-plan reset

`aic.resetGroupToDefaults(groupId)` resets only that group's nodes to `researched.has(n.id) === n.alreadyUnlocked`. Other groups untouched. `aic.isAtDefaultsByGroup.get(groupId)` drives the Reset button visibility in `AicPlanContent` (the Plan sub-tab body).

## Facility caps + over-cap warnings (verified pipeline)

- User-overridable per-(facility, domain) caps live in `aic.capOverrides: ReadonlyMap<string, number>` keyed by `capKey(facilityId, domainId)` = `${facilityId}\u0000${domainId}`.
- `aic.effectiveCaps` derives `base + raises` (or override if set) per facility per domain.
- `useProductionPlan.ts` builds the aggregate `facilityCaps: ReadonlyMap<FacilityId, number>` (sum across active domains) and threads it into:
  1. The packer (`multi-formula-packing.ts` cap constraints) as the first line of defence.
  2. `computeOverCapWarnings(aggregates.rawPerFacility, facilityCaps)` (`plan-helpers.ts:277`, called at `useProductionPlan.ts:606`) — the diagnostic emission. Emits `{ kind: "facility-over-cap", facilityId, used, cap }` per offending facility. Covers BOTH recipe-bin facilities AND pickup-point source facilities (pump_1, pump_2, unloader_1) uniformly through `aggregateBinTotals.rawPerFacility`.
- The packer does NOT emit `facility-over-cap` warnings itself. That separation is load-bearing — see `multi-formula-packing.ts:164-169`.

## Extraction (`pnpm run extract:aic`)

- `pnpm run extract:aic` regenerates `src/data/aic-plans.ts` + `public/locales/{lang}/aic.json` + `public/locales/{lang}/domain.json` from `$ENDFIELD_DATA_DIR/TableCfg/{FacSTT*,FactoryBuildingTable,FactoryMachineCraftTable,ItemTable,DomainDataTable}.json`.
- **Hybrid cap-raise detection**: techs whose `action.actionType !== 5123` but whose `unlockReward` includes an `item_factech_*_amount_*` milestone item get a synthesised `capRaise` action. The delta is parsed from the tech's English `desc.id` (`+N` regex) and self-checked against the explicit-5123 deltas. Currently one such case: `tech_jinlong_3_xiranite_enr_formula` ("Forge Expansion III", +4). Display label is overridden to the milestone item's name.
- **Layer name normalisation**: Title-Case at extraction (`"WULING AIC I"` → `"Wuling AIC I"`), preserving ≤3-char upper-case tokens (catches "AIC") and roman numerals.
- **Domain registry**: emits `export const domains: readonly Domain[]` from `DomainDataTable.json`. `isPinned` derived from `sortId === 1`. Color sourced from `domainColor`. Each domain's `name` lives in `domain.json` per locale.

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
- DO NOT emit `facility-over-cap` warnings from the packer. That kind lives at the hook layer via `computeOverCapWarnings` so it uniformly covers recipe bins + pickup-point source facilities.
- DO NOT add a `v` field inside the JSON payload. The localStorage key (`endfield-calc:aic-v1`) is the sole version signal. The shape-detection loader handles migration.
- DO NOT add new state to `useDomainSettings` at the top level when it's category-specific. Nest it under a new sub-object alongside `aic` (e.g. `regionLimits: {...}`).
- DO NOT confuse the two localStorage keys: `endfield-calc:aic-v1` (settings state) vs `endfield-calc:onboarding-v1` (onboarding dialog seen-flag).
