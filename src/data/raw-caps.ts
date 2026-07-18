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
// A few values are PANEL-VERIFIED MANUAL OVERRIDES (flagged inline): the
// 1.4 "Homecoming" Wuling gas vents + new-region nodes aren't in the
// extractable scene data, so those caps are read off the in-game region
// panel instead of counted. They self-retire once the data catches up
// (the extractor warns to remove them). See MANUAL_CAP_OVERRIDES in
// scripts/extract-raw-caps.ts.
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
      [ItemId.ITEM_COPPER_ORE, 420], // manual override (1.4 Wuling): panel-verified; scene data yields 360 (18×100%)
      [ItemId.ITEM_GAS_INERT, 460], // manual override (1.4 Wuling): panel-verified; scene data yields 40 (2×50%)
      [ItemId.ITEM_GAS_XIRANITE, 100], // manual override (1.4 Wuling): panel-verified; scene data yields 280 (14×50%)
      [ItemId.ITEM_IRON_ORE, 120], // 6×100%
      [ItemId.ITEM_ORIGINIUM_ORE, 540], // 22×100% + 10×50%
    ]),
  ],
]);
