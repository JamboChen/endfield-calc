import type { Item, Recipe, Facility, ItemId, RecipeId, FacilityId, BinId } from "@/types";

/**
 * Represents a single step in the production chain.
 * This is the building block for the dependency tree.
 */
export type ProductionNode = {
  item: Item;
  targetRate: number;
  recipe: Recipe | null;
  facility: Facility | null;
  facilityCount: number;
  isRawMaterial: boolean;
  isTarget: boolean;
  dependencies: ProductionNode[];
  manualRawMaterials?: Set<ItemId>;

  // Cycle support fields
  isCyclePlaceholder?: boolean;
  cycleItemId?: ItemId;

  /**
   * The bin in which this production node runs (Phase 3). Always set for
   * recipe nodes; absent for raw-material and pure-item nodes. Mappers
   * use this to annotate group membership and resolve the physical
   * facility (which may differ from `recipe.facilityId` if Phase 3
   * swapped to a twin variant).
   */
  binId?: BinId;
  /**
   * IDs of sister recipes co-located in the same bin (excluding self).
   * Empty when the bin runs a single recipe.
   */
  binSisterRecipeIds?: RecipeId[];
  /**
   * For bin-fused production nodes: the bin's external outputs other
   * than the headline (which is rendered as the primary item). When set,
   * the card lists these as additional byproducts — covering outputs
   * from sister recipes in the bin that wouldn't otherwise appear via
   * the headline recipe's `outputs` array.
   *
   * Always omitted for non-fused (per-recipe) nodes; the regular
   * `recipe.outputs` byproduct path handles those.
   */
  binExtraOutputs?: Array<{
    itemId: ItemId;
    rate: number;
    isLiquid: boolean;
  }>;
  /**
   * For bin-fused production nodes: full bin reference, used by the
   * card's tooltip to render per-formula breakdown, internal items,
   * port utilization, and power-breakdown sections. Always omitted
   * for non-fused (per-recipe) nodes — the standard tooltip is enough.
   *
   * Carrying the full `Bin` object on the node keeps the
   * tooltip self-contained without re-querying the plan.
   */
  bin?: Bin;
};

/**
 * Represents a detected production cycle in the dependency graph.
 */
export type DetectedCycle = {
  cycleId: string;
  involvedItemIds: ItemId[];
  breakPointItemId: ItemId;
  cycleNodes: ProductionNode[];
  netOutputs: Map<ItemId, number>;
};

export type ProductionGraphNode =
  | {
      type: "item";
      itemId: ItemId;
      item: Item;
      productionRate: number;
      isRawMaterial: boolean;
      isTarget: boolean;
    }
  | {
      type: "recipe";
      recipeId: RecipeId;
      recipe: Recipe;
      /**
       * Physical facility hosting this recipe. May differ from
       * `recipe.facilityId` when Phase 3 packed a recipe into a twin
       * variant on a different facility (e.g. `_1` demand placed in a
       * `_2` Expanded bin). Reflects the actually-built building.
       */
      facility: Facility;
      facilityCount: number;
      isDisposal?: boolean;
      /**
       * Bin id this recipe is hosted in (Phase 3). Set for all recipes
       * after Phase 3 runs; mappers use it to annotate group
       * membership and to look up the bin's facility / sister recipes.
       */
      binId?: BinId;
      /** IDs of sister recipes co-located in the same bin. */
      binSisterRecipeIds?: RecipeId[];
    };

/**
 * Represents an unsolvable production cycle that could not be resolved
 * by either the SCC solver or feeder extension.
 */
export type InvalidCycleInfo = {
  cycleId: string;
  involvedItemIds: ItemId[];
  involvedRecipeIds: RecipeId[];
  reason: "no_solution" | "no_external_demand";
  /** Item IDs with recipe overrides that contribute to this cycle */
  overriddenItemIds: ItemId[];
};

export type ProductionDependencyGraph = {
  nodes: Map<string, ProductionGraphNode>;
  edges: Array<{ from: string; to: string }>;
  targets: Set<ItemId>;
  detectedCycles: DetectedCycle[];
  invalidCycles: InvalidCycleInfo[];
  /**
   * Result of Phase 3 multi-formula bin packing. Empty when the plan
   * contains no recipes from multi-formula facilities (those with
   * `cacheSlots` defined).
   *
   * Each bin represents one or more buildings of a multi-formula facility
   * hosting a fixed set of recipes. `buildingCount` is the integer number
   * of physical buildings of this bin's shape.
   */
  bins: Bin[];
  /**
   * Per-recipe distribution across bins. For a recipe `r` with slot demand
   * `N_r`, the entry's `perBin` array sums to `N_r` and each row indicates
   * how many slots of `r` are allocated to bin `binId`. Recipes from
   * single-formula facilities (no `cacheSlots`) produce trivial allocations
   * (`perBin = [{ binId: <singleton-bin>, slots: N_r }]`).
   */
  recipeBinAllocations: Map<RecipeId, RecipeBinAllocation>;
  /**
   * Non-fatal warnings surfaced from any calculation stage. Currently
   * populated by Phase 3 bin packing when a user recipe override pins a
   * variant that has no valid bin shape on its facility, forcing a
   * fallback to per-recipe singletons. Empty when the calculation
   * completed without such issues.
   */
  warnings: string[];
};

/**
 * A multi-formula bin produced by Phase 3 packing. Represents one or more
 * buildings of a particular facility, all configured with the same set of
 * recipes (formulas). Each building provides 1 slot of each constituent
 * recipe per cycle.
 *
 * Singleton bins (one recipe per building) are emitted for every active
 * recipe even when the facility is single-formula (no `cacheSlots`) —
 * they unify the data shape downstream consumers (mappers, table)
 * work against.
 *
 * **`recipeIds` semantics**: the recipe ids stored here are **demand
 * recipe ids** (Phase 2's pick), not the physical twin variant the ILP
 * may have packed. This lets downstream consumers compare against
 * production-graph recipe ids with plain equality. The bin's
 * `facilityId` separately records the physical facility (e.g. the
 * smaller vs larger variant in a multi-formula family) so power and
 * building-count cost are always accurate.
 *
 * **Variant semantics**: Phase 3 enumerates one or more "variants" per
 * (facility, recipeIds) combination, each variant locking in a specific
 * internal/external/in/out classification of every borderline item. The
 * variant is chosen by the LP so that the resulting external port count
 * is provably within facility caps under any feasible demand. The bin's
 * `variantId` records which variant was chosen — used purely for
 * debugging visibility; UI consumers should rely on
 * `externalInputs`/`externalOutputs`/`internalItems` which are derived
 * from the variant.
 */
export type Bin = {
  /** Stable bin identifier, e.g. "bin-mix_pool_2-pool_xirpoly_1-pool_xe_1-pool_lx_1-0". */
  id: BinId;
  /** Physical facility hosting every building of this bin. */
  facilityId: FacilityId;
  /**
   * Demand recipe ids (Phase 2's pick) hosted by every building of this
   * bin. Sorted ascending. Plain id-equality with `ProductionGraphNode`
   * recipe ids is the supported comparison pattern.
   */
  recipeIds: RecipeId[];
  /** Integer number of buildings configured with this recipe set. */
  buildingCount: number;
  /**
   * Net external inputs at the bin's slot allocation: items consumed
   * inside the bin in excess of internal production. Rate is items/min
   * across all buildings in this bin.
   */
  externalInputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }>;
  /**
   * Net external outputs at the bin's slot allocation: items produced
   * inside the bin in excess of internal consumption. Rate is items/min
   * across all buildings in this bin.
   */
  externalOutputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }>;
  /** Items whose net flow is zero (fully internal); occupies an inner slot. */
  internalItems: ItemId[];
  /** Distinct item count actually used by this bin (≤ facility.cacheSlots). */
  innerSlotsUsed: number;
  /** True when this bin shape groups ≥ 2 distinct recipes per building. */
  isGrouped: boolean;
  /**
   * Variant identifier chosen by the Phase 3 packer. Multi-formula bins
   * have one variant per feasible internal/external classification of
   * borderline items (`${shapeId}#v${index}`). Singleton bins carry a
   * trivial `${shapeId}#v0`. Used for debug logging and packer tests;
   * UI consumers should read `externalInputs`/`externalOutputs`/
   * `internalItems` instead.
   */
  variantId: string;
};

/**
 * Distribution of a single recipe's slot count across one or more bins.
 *
 * Invariant: `perBin.reduce((s, e) => s + e.slots, 0) ≈ totalSlots`.
 */
export type RecipeBinAllocation = {
  recipeId: RecipeId;
  /** Original slot demand from Phase 2 LP (may be fractional). */
  totalSlots: number;
  /**
   * Per-bin allocation. The number of buildings of `binId` allocated to
   * this recipe equals `slots`, since each building provides 1 slot of
   * each constituent recipe.
   */
  perBin: Array<{ binId: BinId; slots: number }>;
};
