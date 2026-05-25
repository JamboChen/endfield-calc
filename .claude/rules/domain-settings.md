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
- Per-category sub-states nested under their own keys. Today only `aic`. Future categories (region limits, power budget, …) add new peer sub-objects without disturbing existing call sites.

## Persistence (verified)

- Sole version signal: localStorage key `endfield-calc:aic-v1` (line 96). No `v` field inside the JSON.
- Loader detects shape (line 217-224): nested `{ domains, aic }` is current; flat `{ unresearched, capOverrides, inactiveDomains? }` is v1, migrated in-memory and re-written nested on next save.
- AIC sub-state uses a **deny-list** for research (`aic.unresearched`); domains use a **deny-list** for activation (`domains.inactive`).
- Defensive filter on load (lines 226-242): drops tech / domain / cap-override entries whose IDs no longer exist in data (e.g. after an `extract:aic` run).

## First-run state

- `inactiveDomains` = `{ d ∈ domains : !d.isPinned }`. Pinned domain (`domain_1`, Valley IV, `sortId === 1`) always active.
- `researched` = for each node: researched iff its domain is active OR `node.alreadyUnlocked`. Active-domain nodes default to "all researched" (Step 1 default); inactive-domain nodes get the game-default subset only.

## Soft deactivation

`toggleDomain` only mutates `inactiveDomains` (lines 360-365). `researched` is preserved across activation flips — re-activating restores prior research state automatically. Pinned domains refuse deactivation silently.

## Onboarding dialog

`AicOnboardingDialog` (`src/components/onboarding/AicOnboardingDialog.tsx`) is rendered by `DomainSettingsProvider` as a sibling of children. It's self-gating against localStorage key **`endfield-calc:onboarding-v1`** (line 81) — a separate key from the AIC state. Shown once per browser. `applyOnboardingChoices` (`useDomainSettings.ts:367-383`) does the bulk apply atomically (one `setInactiveDomains` + one `setResearched` so the persist effect fires once).

## Per-plan reset

`aic.resetGroupToDefaults(groupId)` resets only that group's nodes to `researched.has(n.id) === n.alreadyUnlocked`. Other groups untouched. `aic.isAtDefaultsByGroup.get(groupId)` drives the Reset button visibility in `AicPlanCard`.

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

- `DomainSection.tsx` — generic outer wrapper per domain. Hosts the activation `Switch` (hidden if `domain.isPinned`), accent stripe (`domain.color`), arbitrary child cards. When inactive: `opacity-50 pointer-events-none` (soft preservation — DOM kept intact).
- `AicPlanCard.tsx` — one category card hosted inside a `DomainSection`. AIC-specific.
- `AicLayer.tsx`, `AicNodeRow.tsx`, `AicFacilityLimits.tsx` — sub-components.
- `SettingsSheet.tsx` — top-level container.
- Future cards (e.g. `RegionLimitsCard`) follow the same sibling-within-DomainSection pattern.

## DO NOT

- DO NOT bypass `DomainSettingsProvider` and call `useDomainSettings()` from a leaf component. Multiple instances → settings made in the sheet won't reach the calc.
- DO NOT mutate `aic.researched` when toggling a domain. `toggleDomain` only touches `inactiveDomains` so soft preservation works.
- DO NOT emit `facility-over-cap` warnings from the packer. That kind lives at the hook layer via `computeOverCapWarnings` so it uniformly covers recipe bins + pickup-point source facilities.
- DO NOT add a `v` field inside the JSON payload. The localStorage key (`endfield-calc:aic-v1`) is the sole version signal. The shape-detection loader handles migration.
- DO NOT add new state to `useDomainSettings` at the top level when it's category-specific. Nest it under a new sub-object alongside `aic` (e.g. `regionLimits: {...}`).
- DO NOT confuse the two localStorage keys: `endfield-calc:aic-v1` (settings state) vs `endfield-calc:onboarding-v1` (onboarding dialog seen-flag).
