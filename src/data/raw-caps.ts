// AUTO-GENERATED — do not hand-edit. Run `pnpm run extract:raw-caps` to regenerate.
//
// Per-region default raw-material caps (items/min): each region's maximum
// mining output at max Regional Development Level. Derived entirely from
// the game data: mining spots + per-spot density schedules, region
// membership + max dev level, and the base 20/min per-spot rate.
// Spot-count comments show the density mix
// at max dev. Ore purity runs on a 100-scale (100% = high purity, 50% =
// low); gas purity runs on a 50-scale (50% = high purity = full rate,
// 25% = low = half rate) — verified in-game (1.4).
//
// Items without an entry — Burdo-Muck, liquids, any future non-rig raw —
// have no default cap and stay unlimited unless the user sets one.
// `App.tsx` seeds `rawMaterialCaps` from this map; a user override for
// the same (item, region) always wins.

import { DomainId, ItemId } from "@/types/constants";

export const defaultRawCapsByDomain: ReadonlyMap<
  DomainId,
  ReadonlyMap<ItemId, number>
> = new Map([
  [
    DomainId.DOMAIN_1,
    new Map<ItemId, number>([
      [ItemId.ITEM_IRON_ORE, 1080], // 54×100%
      [ItemId.ITEM_ORIGINIUM_ORE, 560], // 28×100%
      [ItemId.ITEM_QUARTZ_SAND, 240], // 12×100%
    ]),
  ],
  [
    DomainId.DOMAIN_2,
    new Map<ItemId, number>([
      [ItemId.ITEM_COPPER_ORE, 360], // 18×100%
      [ItemId.ITEM_GAS_INERT, 40], // 2×50%
      [ItemId.ITEM_GAS_XIRANITE, 280], // 14×50%
      [ItemId.ITEM_IRON_ORE, 120], // 6×100%
      [ItemId.ITEM_ORIGINIUM_ORE, 540], // 22×100% + 10×50%
    ]),
  ],
]);
