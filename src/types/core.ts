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
 * Multi-formula facility capabilities. When present on a `Facility`, the
 * solver may pack multiple recipes into a single building, sharing
 * inner-slot inventory and external port budget. Facilities without this
 * field are treated as single-formula (one recipe per building).
 *
 * "Inner slots" represent the building's internal inventory budget — every
 * distinct item touched by any constituent recipe (inputs, outputs, internal
 * intermediates) consumes one slot.
 *
 * Port caps apply to the *net* external flow at the chosen slot ratios:
 * an item produced and consumed in equal amounts inside the bin is fully
 * internal and does not occupy a port.
 */
type FacilityCapabilities = {
  /** Maximum distinct items that may appear inside the building. */
  innerSlots: number;
  /** Maximum distinct liquid items entering from outside. */
  liquidInPorts: number;
  /** Maximum distinct liquid items leaving to outside. */
  liquidOutPorts: number;
  /**
   * Belt-input port count. When undefined, belt-input variety is uncapped
   * (limited only by `innerSlots`); throughput remains validated separately.
   */
  beltInPorts?: number;
  /** Maximum distinct non-liquid items leaving to outside. */
  beltOutPorts: number;
  /**
   * Optional cap on number of formulas (recipes) per building. When
   * undefined, only `innerSlots` and port caps limit grouping.
   */
  maxFormulas?: number;
};

type Facility = {
  id: FacilityId;
  powerConsumption: number;
  iconUrl?: string;
  tier: number;
  /**
   * Multi-formula grouping capabilities. When present, the solver may pack
   * multiple recipes into a single building of this facility type.
   */
  capabilities?: FacilityCapabilities;
};

export type { Item, Recipe, RecipeItem, Facility, FacilityCapabilities };
