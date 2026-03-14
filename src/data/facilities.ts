import type { Facility } from "../types";
import { FacilityId } from "../types/constants";

export const facilities: Facility[] = [
  {
    id: FacilityId.ITEM_PORT_CMPT_MC_1,
    powerConsumption: 20,
    tier: 2,
  },
  {
    id: FacilityId.ITEM_PORT_DISMANTLER_1,
    powerConsumption: 20,
    tier: 4,
  },
  {
    id: FacilityId.ITEM_PORT_FILLING_PD_MC_1,
    powerConsumption: 20,
    tier: 3,
  },
  {
    id: FacilityId.ITEM_PORT_FURNANCE_1,
    powerConsumption: 5,
    tier: 1,
  },
  {
    id: FacilityId.ITEM_PORT_GRINDER_1,
    powerConsumption: 5,
    tier: 1,
  },
  {
    id: FacilityId.ITEM_PORT_LIQUID_CLEANER_1,
    powerConsumption: 50,
    tier: 3,
  },
  {
    id: FacilityId.ITEM_PORT_MIX_POOL_1,
    powerConsumption: 50,
    tier: 3,
  },
  {
    id: FacilityId.ITEM_PORT_PLANTER_1,
    powerConsumption: 20,
    tier: 3,
  },
  {
    id: FacilityId.ITEM_PORT_SEEDCOL_1,
    powerConsumption: 10,
    tier: 3,
  },
  {
    id: FacilityId.ITEM_PORT_SHAPER_1,
    powerConsumption: 10,
    tier: 2,
  },
  {
    id: FacilityId.ITEM_PORT_THICKENER_1,
    powerConsumption: 50,
    tier: 4,
  },
  {
    id: FacilityId.ITEM_PORT_TOOLS_ASM_MC_1,
    powerConsumption: 20,
    tier: 3,
  },
  {
    id: FacilityId.ITEM_PORT_WINDER_1,
    powerConsumption: 10,
    tier: 1,
  },
  {
    id: FacilityId.ITEM_PORT_XIRANITE_OVEN_1,
    powerConsumption: 50,
    tier: 4,
  },
];

facilities.forEach((f) => {
  f.iconUrl = `${import.meta.env.BASE_URL}images/facilities/${f.id}.png`;
});
