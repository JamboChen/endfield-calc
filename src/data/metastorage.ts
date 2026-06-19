// AUTO-GENERATED — do not hand-edit. Run `pnpm run extract:metastorage` to regenerate.
//
// Metastorage Transfer capability data: which regions can export
// (lossless, no source-depot debit), their Total Transfer Value (TTV)
// budget per delivery cycle, and the per-item TTV cost for every
// eligible export item. Derived from
// `FactoryDomainItemTransmissionTable` + `FactoryConst` +
// `FactoryItemTable` in the upstream game-data dump.
//
// Max import rate for an item = ttvCapPerCycle / cost / (cycleSeconds / 60)
// items per minute (e.g. 1500 / 1 / 60 = 25/min for a TTV-1 item).

import type { MetastorageSourceInfo } from "@/types/metastorage";
import { DomainId, ItemId } from "@/types/constants";

export const metastorageSources: ReadonlyMap<
  DomainId,
  MetastorageSourceInfo
> = new Map([
  [
    DomainId.DOMAIN_1,
    {
      ttvCapPerCycle: 1500,
      cycleSeconds: 3600,
      unlockLosslessLevel: 12,
      routeNum: 1,
    },
  ],
]);

/** Source domain → (eligible item → TTV cost per unit). */
export const metastorageExports: ReadonlyMap<
  DomainId,
  ReadonlyMap<ItemId, number>
> = new Map([
  [
    DomainId.DOMAIN_1,
    new Map<ItemId, number>([
      [ItemId.ITEM_BOTTLED_FOOD_1, 10],
      [ItemId.ITEM_BOTTLED_FOOD_2, 20],
      [ItemId.ITEM_BOTTLED_FOOD_3, 50],
      [ItemId.ITEM_BOTTLED_REC_HP_1, 10],
      [ItemId.ITEM_BOTTLED_REC_HP_2, 20],
      [ItemId.ITEM_BOTTLED_REC_HP_3, 50],
      [ItemId.ITEM_CARBON_ENR, 1],
      [ItemId.ITEM_CARBON_ENR_POWDER, 1],
      [ItemId.ITEM_CARBON_MTL, 1],
      [ItemId.ITEM_CARBON_POWDER, 1],
      [ItemId.ITEM_CRYSTAL_ENR, 2],
      [ItemId.ITEM_CRYSTAL_ENR_POWDER, 2],
      [ItemId.ITEM_CRYSTAL_POWDER, 1],
      [ItemId.ITEM_CRYSTAL_SHELL, 1],
      [ItemId.ITEM_EQUIP_SCRIPT_1, 10],
      [ItemId.ITEM_EQUIP_SCRIPT_2, 20],
      [ItemId.ITEM_EQUIP_SCRIPT_3, 50],
      [ItemId.ITEM_GLASS_BOTTLE, 2],
      [ItemId.ITEM_GLASS_CMPT, 1],
      [ItemId.ITEM_GLASS_ENR_BOTTLE, 5],
      [ItemId.ITEM_GLASS_ENR_CMPT, 2],
      [ItemId.ITEM_IRON_BOTTLE, 2],
      [ItemId.ITEM_IRON_CMPT, 1],
      [ItemId.ITEM_IRON_ENR, 2],
      [ItemId.ITEM_IRON_ENR_BOTTLE, 5],
      [ItemId.ITEM_IRON_ENR_CMPT, 2],
      [ItemId.ITEM_IRON_ENR_POWDER, 2],
      [ItemId.ITEM_IRON_NUGGET, 1],
      [ItemId.ITEM_IRON_ORE, 1],
      [ItemId.ITEM_IRON_POWDER, 1],
      [ItemId.ITEM_ORIGINIUM_ENR_POWDER, 1],
      [ItemId.ITEM_ORIGINIUM_ORE, 1],
      [ItemId.ITEM_ORIGINIUM_POWDER, 1],
      [ItemId.ITEM_PLANT_BBFLOWER_1, 1],
      [ItemId.ITEM_PLANT_BBFLOWER_POWDER_1, 1],
      [ItemId.ITEM_PLANT_BBFLOWER_SEED_1, 1],
      [ItemId.ITEM_PLANT_GRASS_1, 1],
      [ItemId.ITEM_PLANT_GRASS_2, 1],
      [ItemId.ITEM_PLANT_GRASS_POWDER_1, 1],
      [ItemId.ITEM_PLANT_GRASS_POWDER_2, 1],
      [ItemId.ITEM_PLANT_GRASS_SEED_1, 1],
      [ItemId.ITEM_PLANT_GRASS_SEED_2, 1],
      [ItemId.ITEM_PLANT_MOSS_1, 1],
      [ItemId.ITEM_PLANT_MOSS_2, 1],
      [ItemId.ITEM_PLANT_MOSS_3, 1],
      [ItemId.ITEM_PLANT_MOSS_ENR_POWDER_1, 1],
      [ItemId.ITEM_PLANT_MOSS_ENR_POWDER_2, 1],
      [ItemId.ITEM_PLANT_MOSS_POWDER_1, 1],
      [ItemId.ITEM_PLANT_MOSS_POWDER_2, 1],
      [ItemId.ITEM_PLANT_MOSS_POWDER_3, 1],
      [ItemId.ITEM_PLANT_MOSS_SEED_1, 1],
      [ItemId.ITEM_PLANT_MOSS_SEED_2, 1],
      [ItemId.ITEM_PLANT_MOSS_SEED_3, 1],
      [ItemId.ITEM_PROC_BATTERY_1, 20],
      [ItemId.ITEM_PROC_BATTERY_2, 20],
      [ItemId.ITEM_PROC_BATTERY_3, 50],
      [ItemId.ITEM_PROC_BOMB_1, 5],
      [ItemId.ITEM_QUARTZ_ENR, 2],
      [ItemId.ITEM_QUARTZ_ENR_POWDER, 2],
      [ItemId.ITEM_QUARTZ_GLASS, 1],
      [ItemId.ITEM_QUARTZ_POWDER, 1],
      [ItemId.ITEM_QUARTZ_SAND, 1],
    ]),
  ],
]);
