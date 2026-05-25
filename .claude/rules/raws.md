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

The data layer is small and authoritative. `src/data/index.ts` exports five raw-related symbols (verified):

- `rawMaterialSources: Map<ItemId, RawSourceConfig>` (line 38) — binds each raw to its in-game source facility + optional `ratePerMinute` override.
- `forcedRawMaterials: ReadonlySet<ItemId>` (line 56) — derived from `rawMaterialSources.keys()`. Back-compat API for `.has()` / `for...of`.
- `costlessRaws: ReadonlySet<ItemId>` (line 83) — `items.filter(isLiquid) ∩ forcedRawMaterials`. Currently `{item_liquid_water, item_liquid_acid}`. Auto-extends.
- `forcedDisposalItems: Set<ItemId>` (line 93) — items that must net to zero (`{item_liquid_sewage, item_liquid_xiranite_lowpoly, item_liquid_xiranite_poly}`).
- `bootstrapFacilities: ReadonlySet<FacilityId>` (line 127) — facilities whose recipes bypass the chain-reachability check (currently `{seedcollector_1}`). See `.claude/rules/solver.md` for semantics.

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

- DO NOT add to `rawMaterialSources` / `forcedRawMaterials` without confirming the item has no in-game production recipe AND picking a real source facility. Wrong additions silently break upstream chains. Solids → `unloader_1`; liquids → `pump_1` (most) or `pump_2` (acid).
- DO NOT iterate `forcedRawMaterials` to compute source-facility info — use `rawMaterialSources.get(itemId)` directly. The Set is back-compat only and carries no source data.
- DO NOT pass `item` to `getPickupPointCount`. Signature is `(demandRate, perFacilityRate)` — get `perFacilityRate` from `getRawSourceRate(itemId, item)` so pump-rate overrides are honoured.
- DO NOT pass transport capacity directly to `getPickupPointCount`. Pumps (60/min) are slower than pipes (120/min); the source-rate abstraction is the right concept.
- DO NOT re-sum pickup power at callers of `aggregateBinTotals`. It's already folded in.
