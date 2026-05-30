import { ItemId, RegionStructureId } from "@/types/constants";
import type { DomainId } from "@/types/domain";
import type { RegionStructure } from "@/types/structures";

/**
 * Region-exclusive special structures, keyed by domain.
 *
 * LIGHTWEIGHT registry: drives the Settings "Structures" tab (an opt-in
 * signal that the user wants to use these map buildings). The calc/solver
 * does NOT consume these yet — `recipe` fields capture the game data so
 * the later solver-wiring step has the numbers on hand.
 *
 * Source tables (`$ENDFIELD_DATA_DIR/TableCfg/`):
 *   - FactorySewageTreatPlantStoreTable.json  — `liquidcleanfactory_005_1`
 *     (domain_2), a 4-level chain: 3 import levels (Sewage Inlets) + 1
 *     export level (Byproduct Outlet).
 *   - FactorySewageTreatImportTable.json       — `liquid_clean_gate_1`
 *     (treats `item_liquid_sewage`, `msPerRound: 500`).
 *   - FactorySewageTreatExportTable.json       — `liquid_recycle_gate_1`
 *     (`countCost: 30` sewage -> `countProduce: 1` `item_liquid_xiranite_poly`).
 *
 * Today only Wuling (`domain_2`) has structures. The shape generalises to
 * future regions without touching the settings code.
 */

// Domain ids are runtime-constructed brands (mirrors the `as DomainId`
// idiom in the generated `aic-plans.ts`); cast once and thread through.
const WULING: DomainId = "domain_2" as DomainId;

// One Sewage Inlet treats Sewage (sink). The store table gives only
// msPerRound (500); the per-round amount below reflects the in-game
// ~2 Sewage/s treatment rate and is solver-prep only.
const SEWAGE_INLET_RECIPE = {
  inputItemId: ItemId.ITEM_LIQUID_SEWAGE,
  inputAmount: 1,
  msPerRound: 500,
} as const;

const WULING_PURIFICATION_NODE: readonly RegionStructure[] = [
  {
    id: RegionStructureId.SEWAGE_INLET_1,
    domainId: WULING,
    kind: "sink",
    nameKey: "sewageInlet",
    index: 1,
    gameBuildingId: "liquid_clean_gate_1",
    iconSlug: "icon_port_liquid_clean_gate_1",
    recipe: SEWAGE_INLET_RECIPE,
  },
  {
    id: RegionStructureId.SEWAGE_INLET_2,
    domainId: WULING,
    requires: RegionStructureId.SEWAGE_INLET_1,
    kind: "sink",
    nameKey: "sewageInlet",
    index: 2,
    gameBuildingId: "liquid_clean_gate_2",
    iconSlug: "icon_port_liquid_clean_gate_1",
    recipe: SEWAGE_INLET_RECIPE,
  },
  {
    id: RegionStructureId.SEWAGE_INLET_3,
    domainId: WULING,
    requires: RegionStructureId.SEWAGE_INLET_2,
    kind: "sink",
    nameKey: "sewageInlet",
    index: 3,
    gameBuildingId: "liquid_clean_gate_3",
    iconSlug: "icon_port_liquid_clean_gate_1",
    recipe: SEWAGE_INLET_RECIPE,
  },
  {
    id: RegionStructureId.BYPRODUCT_OUTLET,
    domainId: WULING,
    requires: RegionStructureId.SEWAGE_INLET_3,
    kind: "source",
    nameKey: "byproductOutlet",
    gameBuildingId: "liquid_recycle_gate_1",
    iconSlug: "icon_port_liquid_recycle_gate_1",
    recipe: {
      inputItemId: ItemId.ITEM_LIQUID_SEWAGE,
      inputAmount: 30,
      outputItemId: ItemId.ITEM_LIQUID_XIRANITE_POLY,
      outputAmount: 1,
    },
  },
];

export const regionStructures: ReadonlyMap<DomainId, readonly RegionStructure[]> =
  new Map([[WULING, WULING_PURIFICATION_NODE]]);
