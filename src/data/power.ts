// AUTO-GENERATED — do not hand-edit. Run `pnpm run extract:power` to regenerate.
//
// Thermal Bank power generation: the `power_station_1` facility plus one
// zero-output "burn" recipe per battery fuel, with the out-of-band
// `powerGeneration` value (power output while a bank burns that fuel).
// Derived from `FactoryPowerStationTable` + `FactoryFuelItemTable` +
// `FactoryBuildingTable` in the upstream game-data dump. Batteries only:
// the dump also allows burning Originium Ore (50 power / 8 s) but its
// power density would suggest absurd Thermal Bank counts — see
// `scripts/lib/power-station.ts`.
//
// A fractional bank count is a duty cycle: one bank burning a 40 s
// battery consumes 60/40 = 1.5 fuel/min and provides `powerGeneration`
// power continuously while fed.

import type { Facility, PowerFuel } from "@/types";
import { FacilityId, ItemId, RecipeId } from "@/types/constants";
import { facilityIconUrl, isMonochromeFacilityIcon } from "@/lib/facility-icons";

export const powerStationFacility: Facility = {
  id: FacilityId.POWER_STATION_1,
  tier: 2,
  category: 3,
  powerConsumption: 0,
  footprint: { width: 2, depth: 2 },
  buffersIn: { belt: [{ ports: 2 }], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
};

powerStationFacility.iconUrl = facilityIconUrl(powerStationFacility.id);
powerStationFacility.iconIsMonochrome = isMonochromeFacilityIcon(
  powerStationFacility.id,
);

/** Battery fuels the Thermal Bank can burn, cheapest-tier first. */
export const powerFuels: readonly PowerFuel[] = [
  {
    powerGeneration: 220,
    recipe: {
      id: RecipeId.BURN_ITEM_PROC_BATTERY_1,
      inputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_1, amount: 1 }],
      outputs: [],
      facilityId: FacilityId.POWER_STATION_1,
      craftingTime: 40,
    },
  },
  {
    powerGeneration: 420,
    recipe: {
      id: RecipeId.BURN_ITEM_PROC_BATTERY_2,
      inputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_2, amount: 1 }],
      outputs: [],
      facilityId: FacilityId.POWER_STATION_1,
      craftingTime: 40,
    },
  },
  {
    powerGeneration: 1100,
    recipe: {
      id: RecipeId.BURN_ITEM_PROC_BATTERY_3,
      inputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_3, amount: 1 }],
      outputs: [],
      facilityId: FacilityId.POWER_STATION_1,
      craftingTime: 40,
    },
  },
  {
    powerGeneration: 1600,
    recipe: {
      id: RecipeId.BURN_ITEM_PROC_BATTERY_4,
      inputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_4, amount: 1 }],
      outputs: [],
      facilityId: FacilityId.POWER_STATION_1,
      craftingTime: 40,
    },
  },
  {
    powerGeneration: 3200,
    recipe: {
      id: RecipeId.BURN_ITEM_PROC_BATTERY_5,
      inputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_5, amount: 1 }],
      outputs: [],
      facilityId: FacilityId.POWER_STATION_1,
      craftingTime: 40,
    },
  },
];
