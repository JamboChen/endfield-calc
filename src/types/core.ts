import type { ItemId, RecipeId, FacilityId, DomainId } from "@/types";

type Item = {
  id: ItemId;
  iconUrl?: string;
  tier: number;
  asTarget?: boolean;
  isLiquid?: boolean;
};

type RecipeItem = {
  itemId: ItemId;
  amount: number;
};

type Recipe = {
  id: RecipeId;
  inputs: RecipeItem[];
  outputs: RecipeItem[];
  facilityId: FacilityId;
  craftingTime: number;
};

/**
 * One logical I/O stream of a building (one slot in the player's view),
 * carrying its physical port count. The engine itself uses "buffer" to
 * name the binding/grouping layer that ties one or more physical ports
 * to one cache — surfaced in the upstream game-data dump as the
 * per-recipe `*BufferBinding[]` arrays and the per-building
 * `buildingBufferStackLimit` field.
 *
 * Multi-port buffers are physical taps sharing the same logical stream.
 */
type Buffer = { ports: number };

/**
 * Belt and pipe buffers for one direction (in or out).
 */
type Buffers = { belt: Buffer[]; pipe: Buffer[] };

/**
 * A factory building. Schema mirrors the upstream game-data dump as
 * emitted by `scripts/extract-facilities.ts`, with the calc-side
 * `FacilityId` brand applied to `id`.
 *
 * Multi-formula capability is signalled by the presence of `cacheSlots`
 * (mix pools today: 5 for `mix_pool_1`, 8 for `mix_pool_2`). Without
 * `cacheSlots`, the building is single-formula (one recipe per building).
 *
 * Distinct-item port caps used by the bin-packing solver are derived from
 * buffer counts:
 *   - `liquidInPorts`  = `buffersIn.pipe.length`
 *   - `liquidOutPorts` = `buffersOut.pipe.length`
 *   - `beltOutPorts`   = `buffersOut.belt.length`
 *   - belt-in distinct-item variety is intentionally uncapped wrt bin
 *     packing (throughput remains validated separately during post-pass).
 *
 * Advisory fields (`buffers{In,Out}`, `category`, `domains`) carry data
 * for future consumers (per-buffer routing visualisation, placement-aware
 * planning warnings, categorical filters). They are not consumed by
 * today's solver.
 */
type Facility = {
  id: FacilityId;
  /**
   * Building progression tier (1..4 today), derived upstream from the
   * building → blueprint-item → rarity lookup chain in the game-data
   * dump.
   */
  tier: number;
  /**
   * Game enum `GEnums.FacBuildingType` value: 6 MachineCrafter,
   * 10 loader-class (Depot Loader), 11 unloader-class (Depot Unloader),
   * 25 pump-class (FluidPumpIn), 26 dumper-class (FluidPumpOut),
   * 27 FluidReaction, 28 LiquidCleaner.
   */
  category: number;
  /** Power draw per active building (0 = passive). */
  powerConsumption: number;
  /**
   * Build-grid footprint (`FactoryBuildingTable.range` width × depth,
   * in grid tiles). Drives the plan-level grid-area stat
   * (`aggregateBinTotals.totalTiles`). Optional so synthetic test
   * fixtures need not carry it; both extractors always emit it.
   */
  footprint?: { width: number; depth: number };
  buffersIn: Buffers;
  buffersOut: Buffers;
  /**
   * Mix-pool inner-slot budget. Present only on FluidReaction buildings;
   * its presence is the multi-formula capability flag.
   */
  cacheSlots?: number;
  /**
   * Domain ids where this building may be placed (e.g.
   * `[DomainId.DOMAIN_2]`); empty = placeable anywhere. Union of
   * `placeDomains` (the hard restriction) and `recommendDomains` (a
   * "suggested" location that is, in practice, enforced by the game today).
   */
  domains: DomainId[];
  iconUrl?: string;
  /**
   * True when `iconUrl` points at a monochrome game glyph that needs
   * `invert dark:invert-0` styling to remain visible on both light and
   * dark backgrounds. Today: synthetic manual facilities that reuse a
   * structure port glyph (no canonical building icon exists in the
   * game data dump). Auto-generated facilities never set this — their
   * icons are colored building renders.
   */
  iconIsMonochrome?: boolean;
};

export type { Item, Recipe, RecipeItem, Facility, Buffer, Buffers };
