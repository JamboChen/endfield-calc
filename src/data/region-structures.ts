import { FacilityId, RegionStructureId } from "@/types/constants";
import type { DomainId } from "@/types/domain";
import type { RegionStructure } from "@/types/structures";

/**
 * Region-exclusive special structures, keyed by domain.
 *
 * The registry drives BOTH the Settings "Structures" tab (opt-in
 * checkboxes) AND the calc/solver bridge in `src/App.tsx`. Each
 * structure declares a `solver` role that says how enabling it should
 * affect the LP:
 *   - `role: "instance"` — adds +1 to `facilityCaps[facilityId]`.
 *   - `role: "recipeToggle"` — switches the facility's active recipe to
 *     the toggled variant declared in `facilityRecipeVariants`
 *     (`src/data/index.ts`).
 *
 * The actual rates / amounts live on the real `Recipe` entries in
 * `src/data/recipes.ts` (referenced via `facilityRecipeVariants`); this
 * file carries only the structure metadata + the bridge declarations.
 *
 * **ID convention**: each structure's `id` is the upstream game
 * building id verbatim (e.g. `liquid_clean_gate_1` from
 * `FactorySewageTreatImportTable.json`). Greppable across the codebase
 * and the upstream data dumps; mirrors how `FacilityId` works.
 *
 * Source tables (`$ENDFIELD_DATA_DIR/TableCfg/`):
 *   - FactorySewageTreatPlantStoreTable.json  — `liquidcleanfactory_005_1`
 *     (domain_2), a 4-level chain: 3 import levels (sewage inlet gates)
 *     + 1 export level (byproduct outlet gate).
 *   - FactorySewageTreatImportTable.json       — `liquid_clean_gate_1`
 *     (treats `item_liquid_sewage`, `msPerRound: 500` → 120/min/building).
 *   - FactorySewageTreatExportTable.json       — `liquid_recycle_gate_1`
 *     (`countCost: 30` sewage → `countProduce: 1` `item_liquid_xiranite_poly`).
 */

// Domain ids are runtime-constructed brands (mirrors the `as DomainId`
// idiom in the generated `aic-plans.ts`); cast once and thread through.
const WULING: DomainId = "domain_2" as DomainId;

const WULING_PURIFICATION_NODE: readonly RegionStructure[] = [
  {
    id: RegionStructureId.LIQUID_CLEAN_GATE_1,
    domainId: WULING,
    nameKey: "sewageInlet",
    index: 1,
    iconSlug: "icon_port_liquid_clean_gate_1",
    solver: { role: "instance", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 },
  },
  {
    id: RegionStructureId.LIQUID_CLEAN_GATE_2,
    domainId: WULING,
    requires: RegionStructureId.LIQUID_CLEAN_GATE_1,
    nameKey: "sewageInlet",
    index: 2,
    iconSlug: "icon_port_liquid_clean_gate_1",
    solver: { role: "instance", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 },
  },
  {
    id: RegionStructureId.LIQUID_CLEAN_GATE_3,
    domainId: WULING,
    requires: RegionStructureId.LIQUID_CLEAN_GATE_2,
    nameKey: "sewageInlet",
    index: 3,
    iconSlug: "icon_port_liquid_clean_gate_1",
    solver: { role: "instance", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 },
  },
  {
    id: RegionStructureId.LIQUID_RECYCLE_GATE_1,
    domainId: WULING,
    requires: RegionStructureId.LIQUID_CLEAN_GATE_3,
    nameKey: "byproductOutlet",
    iconSlug: "icon_port_liquid_recycle_gate_1",
    solver: { role: "recipeToggle", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 },
  },
];

export const regionStructures: ReadonlyMap<DomainId, readonly RegionStructure[]> =
  new Map([[WULING, WULING_PURIFICATION_NODE]]);
