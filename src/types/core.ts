import type { ItemId, RecipeId, FacilityId, DomainId } from "@/types";

type Item = {
  id: ItemId;
  iconUrl?: string;
  tier: number;
  asTarget?: boolean;
  isLiquid?: boolean;
  /**
   * 1.4+ gas phase. Gas travels
   * through pipes like liquid (same 120/min throughput, same pipe port
   * class) but is a node-capped raw (gas vents, `raw-caps.ts`) rather
   * than an open-body costless liquid.
   */
  isGas?: boolean;
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
  /**
   * 1.4+ gas-environment requirement (non-zero upstream `gasEnv`): the
   * machine must sit inside a Gas Dispersing Unit (vaporizer) aura of
   * this environment. Joins against `vaporizerEnvs` in
   * `src/data/gas-sustain.ts` (1=inert, 2=water, 3=acid, 4=xiranite).
   */
  gasEnv?: number;
};

/**
 * One logical I/O stream of a building (one slot in the player's view),
 * carrying its physical port count. The engine itself uses "buffer" to
 * name the binding/grouping layer that ties one or more physical ports
 * to one cache — surfaced in the game data as per-recipe port-binding
 * arrays and a per-building buffer-stack-limit field.
 *
 * Multi-port buffers are physical taps sharing the same logical stream.
 */
type Buffer = { ports: number };

/**
 * Belt and pipe buffers for one direction (in or out).
 */
type Buffers = { belt: Buffer[]; pipe: Buffer[] };

/**
 * A factory building. Schema mirrors the game data, with the calc-side
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
/**
 * One battery fuel the Thermal Bank (`power_station_1`) can burn: a
 * zero-output "burn" recipe (1 fuel per `craftingTime` seconds) plus the
 * out-of-band power output while a bank burns it. Kept off `Recipe` /
 * `Facility` so the auto-generated rosters stay untouched; lives in
 * `src/data/power.ts`.
 */
type PowerFuel = {
  /** Power provided continuously while one bank burns this fuel. */
  powerGeneration: number;
  recipe: Recipe;
};

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
   * Build-grid footprint (width × depth, in grid tiles). Drives the
   * plan-level grid-area stat
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

export type { Item, Recipe, RecipeItem, Facility, Buffer, Buffers, PowerFuel };
