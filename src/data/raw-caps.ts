// AUTO-GENERATED — do not hand-edit. Run `pnpm run extract:raw-caps` to regenerate.
//
// Per-region default raw-material caps (items/min): each region's maximum
// mining output at max Regional Development Level. Derived entirely from
// the game-data dump: mining spots + per-spot density schedules from the
// scene data (`LevelGenForRuntime/TotalFactoryRegions.json`), region
// membership + max dev level from `DomainDataTable.json`, and the base
// 20/min per-spot rate from `FactoryMinerTable.json`. Spot-count comments
// show the density mix at max dev (100% = high purity, 50% = low).
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
      [ItemId.ITEM_IRON_ORE, 120], // 6×100%
      [ItemId.ITEM_ORIGINIUM_ORE, 540], // 22×100% + 10×50%
    ]),
  ],
]);
