// AUTO-GENERATED — do not hand-edit. Run `pnpm run extract:sustain` to regenerate.
//
// 1.4 gas-sustain model: the out-of-band item drains that keep
// transmuters and vaporizers running. Derived from the game data.
//
// - `facilitySustainDrains`: catalyst fuel burned at `ratePerMinute`
//   per building at 100% duty — one unit buys 60/rate seconds of
//   working time, so consumption is load-proportional (verified
//   in-game 1.4; the eager activation port is assumed throttled to the
//   duty rate). The calculator folds the charge into each recipe's
//   inputs at graph-build time (see `src/lib/calculator.ts`).
// - `vaporizerEnvs`: one synthetic zero-output recipe per gas
//   environment (`Recipe.gasEnv` joins on the map key). Each vaporizer
//   drains `ratePerMinute` of its gas, modeled ALWAYS-ON (the shared
//   aura's uptime is the union of up to machinesPerVaporizer
//   unsynchronized duty cycles ≈ 100%); vaporizer count =
//   ceil(env machines / machinesPerVaporizer) — coverage is a plan
//   option, not spatial modeling. Aura: 13×13, buildings fully inside.
//
// These recipes are NOT part of the main `recipes` roster (mirrors the
// Thermal Bank `burn_*` pattern) — the calculator injects them when
// env-gated recipes are active.

import type { Recipe } from "@/types";
import { FacilityId, ItemId, RecipeId } from "@/types/constants";

export interface SustainDrain {
  itemId: ItemId;
  /** Items/min per building at 100% duty (fuel: 1 unit = 60/rate s of work). */
  ratePerMinute: number;
}

/** Per-facility always-on catalyst drains (transmuters). */
export const facilitySustainDrains: ReadonlyMap<FacilityId, SustainDrain> =
  new Map([
  [
    FacilityId.TRANSMUTER_1,
    { itemId: ItemId.ITEM_LIQUID_XIRANITE, ratePerMinute: 6 },
  ],
  [
    FacilityId.TRANSMUTER_2,
    { itemId: ItemId.ITEM_GAS_XIRANITE, ratePerMinute: 6 },
  ],
  ]);

/**
 * Gas environments by upstream env id (`Recipe.gasEnv`). The synthetic
 * recipe consumes `ratePerMinute` gas per 60 s craft — one facility
 * count unit = one always-on vaporizer.
 */
export const vaporizerEnvs: ReadonlyMap<
  number,
  { gasItemId: ItemId; ratePerMinute: number; recipe: Recipe }
> = new Map([
  [
    1,
    {
      gasItemId: ItemId.ITEM_GAS_INERT,
      ratePerMinute: 6,
      recipe: {
        id: RecipeId.VAPORIZE_ITEM_GAS_INERT,
        inputs: [{ itemId: ItemId.ITEM_GAS_INERT, amount: 6 }],
        outputs: [],
        facilityId: FacilityId.VAPORIZER_1,
        craftingTime: 60,
      },
    },
  ],
  [
    2,
    {
      gasItemId: ItemId.ITEM_GAS_WATER,
      ratePerMinute: 6,
      recipe: {
        id: RecipeId.VAPORIZE_ITEM_GAS_WATER,
        inputs: [{ itemId: ItemId.ITEM_GAS_WATER, amount: 6 }],
        outputs: [],
        facilityId: FacilityId.VAPORIZER_1,
        craftingTime: 60,
      },
    },
  ],
  [
    3,
    {
      gasItemId: ItemId.ITEM_GAS_ACID,
      ratePerMinute: 6,
      recipe: {
        id: RecipeId.VAPORIZE_ITEM_GAS_ACID,
        inputs: [{ itemId: ItemId.ITEM_GAS_ACID, amount: 6 }],
        outputs: [],
        facilityId: FacilityId.VAPORIZER_1,
        craftingTime: 60,
      },
    },
  ],
  [
    4,
    {
      gasItemId: ItemId.ITEM_GAS_XIRANITE,
      ratePerMinute: 6,
      recipe: {
        id: RecipeId.VAPORIZE_ITEM_GAS_XIRANITE,
        inputs: [{ itemId: ItemId.ITEM_GAS_XIRANITE, amount: 6 }],
        outputs: [],
        facilityId: FacilityId.VAPORIZER_1,
        craftingTime: 60,
      },
    },
  ],
]);
