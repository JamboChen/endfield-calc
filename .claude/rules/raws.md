---
paths:
  - "src/data/index.ts"
  - "src/data/items.ts"
  - "src/data/facilities.ts"
  - "src/data/recipes.ts"
  - "src/lib/flow-solver.ts"
  - "src/lib/graph-builder.ts"
  - "src/lib/utils.ts"
  - "src/components/AddTargetDialogGrid.tsx"
---

# Raw materials, source facilities, and transport

The data layer is small and authoritative. `src/data/index.ts` exports these raw-related symbols (verified):

- `rawMaterialSources: Map<ItemId, RawSourceConfig>` — binds each raw to its in-game source facility + optional `ratePerMinute` override. Canonical "what items are raws" anchor.
- `rawAvailabilityByDomain: ReadonlyMap<DomainId, ReadonlySet<ItemId>>` — per-region raw availability. **Sole source of truth for "what counts as a raw in this plan"**: App.tsx threads `.get(currentDomain)` into the calc layer as the `rawMaterials` parameter. Subset-of-rawMaterialSources by invariant; tests enforce both soundness + completeness.
- `costlessRaws: ReadonlySet<ItemId>` — `items.filter(isLiquid) ∩ rawMaterialSources.keys()`. Currently `{item_liquid_water, item_liquid_acid}`. Auto-extends. TYPE classification (region-independent); the LP zero-cost bias applies wherever the recipe runs.
- `forcedDisposalItems: Set<ItemId>` — items that must net to zero (`{item_liquid_sewage, item_liquid_xiranite_lowpoly, item_liquid_xiranite_poly}`).
- `bootstrapFacilities: ReadonlySet<FacilityId>` — facilities whose recipes bypass the chain-reachability check (currently `{seedcollector_1}`). See `.claude/rules/solver.md` for semantics.

**Removed**: `forcedRawMaterials` (the global "all raws" Set) was dropped in the per-region refactor. Tests use `new Set(rawMaterialSources.keys())` as the convenience equivalent (extracted to `src/tests/lib/utils.ts` as `ALL_RAWS`); production code receives `rawMaterials` as an explicit parameter at every calc-layer call site.

## Source-facility assignment rules (verified)

- Solid ore/sand → `unloader_1` (Depot Unloader, 0 W, 30/min belt capacity)
- Most liquids → `pump_1` (Fluid Pump, 10 W, 60/min)
- Acid → `pump_2` (Acid Resistant Pump Mk II, 20 W, 60/min)

Per-facility throughput defaults to transport capacity (30/min belt, 120/min pipe). Liquid pumps cap at 60/min — half the pipe capacity — so they REQUIRE `ratePerMinute: 60` in `rawMaterialSources` (lines 43-44). The `msPerRound: 1000` in `FactoryFluidPumpInTable` (game data) is the source of truth for the 60/min rate.

## Transport capacities (`src/lib/utils.ts:19-23`)

- `TRANSPORT_BELT_CAPACITY = 30` items/min
- `TRANSPORT_PIPE_CAPACITY = 120` items/min
- `getTransportCapacity(item)` — branches on `item?.isLiquid`.

Pump throughput (60/min) and pipe capacity (120/min) are **distinct concepts**:
- `getRawSourceRate(itemId, item)` (`utils.ts:57`) — per-facility rate. Reads `rawMaterialSources.get(itemId)?.ratePerMinute`, falls back to `getTransportCapacity(item)`.
- `getTransportCapacity(item)` — per-belt/per-pipe rate.

One pipe carries two pumps' worth of flow (120 vs 60). Pickup count uses `getRawSourceRate`; edge labels use `getTransportCapacity`.

## Source-facility power folding

`aggregateBinTotals` (`plan-helpers.ts:154`) folds pickup-point pumps (`pump_1`, `pump_2`) and depot unloaders (`unloader_1`) into `perFacility` and `totalPower`. Pickup counts respect `ceilMode`: ceiled physical pickups when `ceilMode=true`, fractional theoretical when `ceilMode=false`. **Do NOT re-sum pickup power at the caller.**

## ID naming conventions

- Item IDs: `item_<category>_<subcategory>_<modifier>` (e.g. `item_copper_enr_powder`).
- Recipe IDs: `<facility_type>_<output>_<tier>` (e.g. `pool_xiranite_poly_1`).
- Facility IDs: `<type>_<tier>` (e.g. `pump_1`, `unloader_1`, `crucible_2`).
- Keep enums in `src/types/constants.ts` alphabetised.

## Image assets

- `public/images/items/<item_id>.png`
- `public/images/facilities/<facility_id>.png`
- Source-facility images `unloader_1.png`, `pump_1.png`, `pump_2.png` are placeholders pending real game-asset extracts.

## DO NOT

- DO NOT add to `rawMaterialSources` without confirming the item has no in-game production recipe AND picking a real source facility. Wrong additions silently break upstream chains. Solids → `unloader_1`; liquids → `pump_1` (most) or `pump_2` (acid). Adding to `rawMaterialSources` also requires adding to at least one region in `rawAvailabilityByDomain` (the completeness test fails loudly otherwise).
- DO NOT reach for a global "all raws" Set — there isn't one anymore. The per-region `rawAvailabilityByDomain.get(currentDomain)` is threaded explicitly through the calc layer; consumers receive it as a parameter.
- DO NOT pass `item` to `getPickupPointCount`. Signature is `(demandRate, perFacilityRate)` — get `perFacilityRate` from `getRawSourceRate(itemId, item)` so pump-rate overrides are honoured.
- DO NOT pass transport capacity directly to `getPickupPointCount`. Pumps (60/min) are slower than pipes (120/min); the source-rate abstraction is the right concept.
- DO NOT re-sum pickup power at callers of `aggregateBinTotals`. It's already folded in.
