import type { ItemId, RegionStructureId } from "./constants";
import type { DomainId } from "./domain";

/**
 * Region-exclusive special structures (map buildings wired into a
 * factory; not roster/AIC buildings). Hand-curated in
 * `src/data/region-structures.ts` from the game's
 * `FactorySewageTreat{Import,Export}Table` +
 * `FactorySewageTreatPlantStoreTable`.
 *
 * Structures in a region form a linear opt-in chain via `requires`
 * (Wuling: Sewage Inlet 1 -> 2 -> 3 -> Byproduct Outlet). The Settings
 * "Structures" tab enforces the chain with a cascade.
 *
 * `recipe` is captured for the future solver step; it is NOT consumed by
 * the calc today (these are not yet wired as `Facility`/`Recipe` entries).
 */

type RegionStructureKind = "sink" | "source";

type RegionStructureRecipe = {
  /** Item consumed (always Sewage today). */
  readonly inputItemId: ItemId;
  /** Sink: amount treated per round. Source: cost per produced unit. */
  readonly inputAmount: number;
  /** Source output (e.g. Xircon Effluent). Omitted for pure sinks. */
  readonly outputItemId?: ItemId;
  readonly outputAmount?: number;
  /** Milliseconds per processing round (from `msPerRound`). */
  readonly msPerRound?: number;
};

type RegionStructure = {
  readonly id: RegionStructureId;
  readonly domainId: DomainId;
  /** Prereq structure in the chain; omitted for the chain head. */
  readonly requires?: RegionStructureId;
  readonly kind: RegionStructureKind;
  /** i18n key under the `settings` namespace: `structures.<nameKey>`. */
  readonly nameKey: string;
  /** Display index for repeated structures (Sewage Inlet 1/2/3). */
  readonly index?: number;
  /** Backing game building id (documentation / future solver wiring). */
  readonly gameBuildingId: string;
  readonly recipe: RegionStructureRecipe;
};

export type { RegionStructure, RegionStructureKind, RegionStructureRecipe };
