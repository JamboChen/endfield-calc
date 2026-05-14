import type { ItemId, RecipeId, FacilityId } from "@/types";

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
 * Placement cap for a facility. The per-domain instance limit is
 * `base + sum(increments)`. `null` on a Facility means uncapped.
 */
type PlacementCap = { base: number; increments: number[] };

/**
 * One logical I/O stream of a building, carrying its physical port count.
 * Each Channel represents one slot in the player's view; multi-port channels
 * are physical taps sharing the same logical stream.
 */
type Channel = { ports: number };

/**
 * Belt and pipe channels for one direction (in or out).
 */
type Channels = { belt: Channel[]; pipe: Channel[] };

/**
 * A factory building. Schema mirrors the game-data dump emitted by the
 * upstream `build-factory-buildings.ts` extractor, with the calc-side
 * `FacilityId` brand applied to `id`.
 *
 * Multi-formula capability is signalled by the presence of `cacheSlots`
 * (mix pools today: 5 for `mix_pool_1`, 8 for `mix_pool_2`). Without
 * `cacheSlots`, the building is single-formula (one recipe per building).
 *
 * Distinct-item port caps used by the bin-packing solver are derived from
 * channel counts:
 *   - `liquidInPorts`  = `channelsIn.pipe.length`
 *   - `liquidOutPorts` = `channelsOut.pipe.length`
 *   - `beltOutPorts`   = `channelsOut.belt.length`
 *   - belt-in distinct-item variety is intentionally uncapped wrt bin
 *     packing (throughput remains validated separately during post-pass).
 *
 * Advisory fields (`channels{In,Out}`, `category`, `numId`, `domains`,
 * `cap`) carry data for future consumers (per-channel routing
 * visualisation, placement-aware planning warnings, categorical
 * filters). They are not consumed by today's solver.
 */
type Facility = {
  id: FacilityId;
  /** Numeric entity id from upstream `entity-ids.json` (−1 if unresolved). */
  numId: number;
  /**
   * Building progression tier (1..4 today), derived upstream from
   * `FactoryBuildingItemReverseTable -> ItemTable.rarity`.
   */
  tier: number;
  /**
   * Game enum `GEnums.FacBuildingType` value: 6 MachineCrafter,
   * 10 loader-class, 25 pump-class, 27 FluidReaction, 28 LiquidCleaner.
   */
  category: number;
  /** Power draw per active building (0 = passive). */
  powerConsumption: number;
  channelsIn: Channels;
  channelsOut: Channels;
  /**
   * Mix-pool inner-slot budget. Present only on FluidReaction buildings;
   * its presence is the multi-formula capability flag.
   */
  cacheSlots?: number;
  /**
   * Numeric DomainDataTable.sortId values. Empty = placeable anywhere.
   */
  domains: number[];
  /** Per-domain instance limit; `null` = uncapped. */
  cap: PlacementCap | null;
  iconUrl?: string;
};

export type { Item, Recipe, RecipeItem, Facility, Channel, Channels, PlacementCap };
