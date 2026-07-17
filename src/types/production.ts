import type {
  Item,
  Recipe,
  Facility,
  DomainId,
  ItemId,
  RecipeId,
  FacilityId,
  BinId,
} from "@/types";

/**
 * Structured warning emitted from the calc/packer layers. Display
 * formatting (ceilMode-aware counts, localised facility/recipe names,
 * plural forms) is the responsibility of the consumer — typically
 * `useProductionPlan`'s `warnings` memo, which has access to `ceilMode`
 * state and the `i18next` translator.
 *
 * Why structured instead of strings: keeps the data layer free of
 * display state (`ceilMode`) and i18n state. New warning kinds can be
 * added by extending this union without threading new parameters down
 * through the packer. Consumers pattern-match on `kind`.
 *
 * Adding a new warning kind:
 *   1. Add a discriminant arm here.
 *   2. Emit it from the source (packer / calculator).
 *   3. Add a formatter branch in `useProductionPlan.formatPlanWarning`.
 *   4. Add i18n keys to all 7 `app.json` locales.
 *   5. If the kind means "this plan exceeds a configured limit", add
 *      it to `OVER_LIMIT_WARNING_KINDS` (plan-helpers.ts) — that
 *      enrolls it in Fit/Max/auto-fit and the Fit pill automatically
 *      (see `.claude/rules/optimizer.md`).
 */
export type PlanWarning =
  | {
      /**
       * Per-facility placement cap exceeded. Emitted by
       * `calculateProductionPlan` at plan assembly (via
       * `computeLimitViolations` in plan-helpers), comparing the
       * always-ceiled `physicalPerFacility` aggregate against the
       * user's caps. `used` is a physical placement count (integer);
       * `cap` is always integer (parseInt-guarded at the UI input).
       *
       * Applies uniformly to single-formula facilities (singleton
       * bins), multi-formula facilities (LP-packed bins), and
       * pickup-point source facilities (pump_1, pump_2, unloader_1).
       */
      kind: "facility-over-cap";
      facilityId: FacilityId;
      used: number;
      cap: number;
    }
  | {
      /**
       * The user pinned a recipe override whose facility has no valid
       * bin shape on the packer side. Packer fell back to a per-recipe
       * singleton bin for that recipe.
       */
      kind: "packer-override-infeasible";
      recipeId: RecipeId;
      facilityId: FacilityId;
    }
  | {
      /**
       * Generic packer-fallback signal. Emitted when the LP fails for
       * a reason that isn't tied to a specific override (e.g. demand
       * ratios outside the conic hull of available variants). All
       * recipes fall through to singleton bins.
       */
      kind: "packer-fallback";
    }
  | {
      /**
       * Per-(item, region) raw-material limit exceeded. Emitted by
       * `calculateProductionPlan` at plan assembly (via
       * `computeLimitViolations` in plan-helpers), comparing the
       * plan's raw-node requirement fold (items/min consumption)
       * against the user-configured `rawCaps` map for the current
       * region.
       *
       * Mirrors `facility-over-cap` semantically: the value is
       * informational (warn-only, never blocks). The LP layer
       * additionally adds slack-based upper-bound constraints (see
       * `lp-solver.ts`), so the LP actively biases toward conserving
       * the capped raw — this warning surfaces residual overage when
       * no recipe combination respects the cap.
       *
       * `used` may be fractional (LP-derived); `cap` is integer
       * (parseInt-guarded at the UI + 4-layer validation).
       */
      kind: "raw-over-cap";
      itemId: ItemId;
      used: number;
      cap: number;
    }
  | {
      /**
       * A Metastorage route could not be used because every viable
       * item assignment would exceed the route's TTV budget — only
       * possible when the demand is import-only (no local producer):
       * the LP's `TTV_SLACK_PENALTY` ordering exhausts local
       * production and every user-imposed soft cap (raw caps,
       * facility caps) before ever touching budget overage, and the
       * selection gate in `selectMetastorageImports` rejects any
       * candidate that still carries overage. **No import is applied**
       * (the budget is a game constant; an over-budget plan is
       * unrealizable), so the affected demand goes unsatisfied and the
       * plan typically comes out infeasible — this warning is the
       * explanation.
       *
       * Figures come from the closest-to-possible rejected candidate,
       * in per-delivery-cycle units (game-native, e.g. "needs 1800,
       * budget 1500").
       */
      kind: "metastorage-budget-insufficient";
      sourceDomain: DomainId;
      itemId: ItemId;
      neededPerCycle: number;
      capPerCycle: number;
    }
  | {
      /**
       * Two or more **target** items can only be supplied via
       * Metastorage (no local producer, not a raw) but the available
       * route(s) transfer one item type each — the plan cannot satisfy
       * all of them simultaneously. Emitted by
       * `calculateProductionPlan` before solving; the affected targets
       * surface as infeasible in the plan itself.
       */
      kind: "metastorage-route-conflict";
      itemIds: ItemId[];
    }
  | {
      /**
       * The plan was asked to sustain its own power (`powerSustain`
       * option) but no battery fuel is producible, raw, or importable
       * under the current configuration — no burn recipe entered the
       * graph and the LP ran WITHOUT the power-balance constraint.
       * The plan's power consumption is therefore uncovered by any
       * generation. Emitted by `calculateProductionPlan`.
       */
      kind: "power-sustain-unavailable";
    }
  | {
      /**
       * Self-sustaining power could not be fully funded from headroom
       * UNDER the user's raw/facility limits: battery production is a
       * suggestion, so it never violates caps (unlike locked user
       * targets, which may — with their own warnings). The LP covered
       * every affordable watt and reports the rest here
       * (`LPSolution.powerShortfall` via the `power_slack` tier — see
       * `POWER_SLACK_PENALTY` in `lp-solver.ts`). Remedies: raise
       * limits, unlock targets (Fit treats this warning as
       * over-limit), or accept the shortfall. Emitted by
       * `calculateProductionPlan`.
       */
      kind: "power-sustain-insufficient";
      /** Watts of consumption left uncovered by generation. */
      shortfallWatts: number;
    };

/**
 * One active Metastorage import in the final plan: the auto-selected
 * item arriving from `sourceDomain`. Carried on
 * `ProductionDependencyGraph.metastorageImports`; mappers render it as
 * an import source node and the table as an Imports row. Rates are
 * per-minute (calc-layer convention); `cycleSeconds` lets the UI
 * convert TTV figures to the game-native per-delivery unit.
 */
export type PlanMetastorageImport = {
  sourceDomain: DomainId;
  itemId: ItemId;
  ratePerMinute: number;
  ttvCostPerItem: number;
  /**
   * TTV/min consumed. Always ≤ `ttvBudgetPerMinute` in a final plan —
   * the selection gate rejects over-budget candidates outright.
   */
  ttvUsedPerMinute: number;
  /** TTV/min budget of the route. */
  ttvBudgetPerMinute: number;
  /** Real-time seconds per delivery cycle (3600 in current data). */
  cycleSeconds: number;
};

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
  /**
   * Items the player must seed into this node's hosting building(s)
   * at startup so a 2-recipe cycle can bootstrap. Source of truth for
   * the amber Prefill chip rendered by `CustomProductionNode`.
   *
   * Semantics differ slightly between mappers:
   *   - **bf=1** (`bin-fused-mapper`): one node per bin. The list is
   *     the bin's full union (= `bin.prefillCandidates`). Seeding ANY
   *     one item bootstraps the bin's cycle.
   *   - **bf=0** (`merged-mapper`): one node per recipe. The list is
   *     the recipe's specific prefill items (the union from
   *     `ProductionGraphNode.prefillCandidates` across hosting bins).
   *
   * Empty / undefined when no prefill is needed.
   */
  prefillCandidates?: ItemId[];

  /**
   * Set when this flow node is a **Metastorage import source** (the
   * item arrives from another region's depot). Mappers emit one such
   * node per imported item (`createMetastorageSourceId`); the card
   * renders the source region + TTV figures from this payload instead
   * of recipe/facility info (`recipe` and `facility` are null,
   * `isRawMaterial` stays false). Absent on every other node kind.
   */
  metastorageImport?: PlanMetastorageImport;
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
       * Power provided per facility while this recipe runs (Thermal
       * Bank battery burning). Present only on power-generation recipe
       * nodes injected via `CalculateProductionPlanOptions.powerSustain`.
       * Such nodes are also `isDisposal` (zero outputs) — consumers
       * that render power sinks must check this field FIRST.
       */
      powerGeneration?: number;
      /**
       * Bin id this recipe is hosted in (Phase 3). Set for all recipes
       * after Phase 3 runs; mappers use it to annotate group
       * membership and to look up the bin's facility / sister recipes.
       */
      binId?: BinId;
      /** IDs of sister recipes co-located in the same bin. */
      binSisterRecipeIds?: RecipeId[];
      /**
       * Per-recipe prefill items: items this recipe consumes that
       * participate in a 2-recipe cycle the LP can't bootstrap from
       * raws. Populated by `propagatePrefillCandidates` after packing.
       *
       * The mapper merges multiple bin allocations into a single
       * recipe-level list (union across hosting bins, filtered to
       * inputs THIS recipe consumes). Read by `merged-mapper` (bf=0)
       * to render the per-recipe chip and by tooltips that surface
       * the recipe's bootstrap requirement independently of bin
       * grouping. Empty when this recipe isn't on a stuck 2-cycle.
       *
       * For the bin-aware union (rendered on bin cards in bf=1), read
       * `bin.prefillCandidates` instead.
       */
      prefillCandidates?: ItemId[];
    };

/**
 * Represents an unsolvable production cycle that the global LP could
 * not satisfy. Typically traces to a user-pinned recipe that creates
 * a closed cycle with no external entry point, or a bootstrap problem
 * (e.g. planter ↔ seedcollector with no seed source).
 */
export type InvalidCycleInfo = {
  cycleId: string;
  involvedItemIds: ItemId[];
  involvedRecipeIds: RecipeId[];
  reason: "no_solution" | "no_external_demand";
  /** Item IDs with recipe overrides that contribute to this cycle */
  overriddenItemIds: ItemId[];
};

/**
 * Outcome of the global flow LP behind a plan.
 *
 *   - `"ok"` — the LP solved; facility counts are real.
 *   - `"infeasible"` — no recipe combination satisfies the targets
 *     (pinned dead cycles, genuine bootstrap problems, import-only
 *     demand above the TTV budget). The plan is the best-effort EMPTY
 *     shell: no recipe nodes, no bins, zero rates.
 *   - `"unbounded"` — pass-1 unbounded (practically unreachable;
 *     defensive). Same empty shell.
 *   - `"solver_error"` — HiGHS threw mid-solve (e.g. a wedged WASM
 *     instance). Same empty shell; the singleton self-heals on the
 *     next solve (see `highs-singleton.ts`).
 *
 * Consumers MUST NOT read production data off a non-`"ok"` plan as if
 * it were a real result — an empty shell is indistinguishable from
 * "nothing produced" otherwise. The target optimizer's feasibility
 * predicate treats non-`"ok"` as infeasible (a vacuously-clean empty
 * plan once let Max bracket to its ceiling and report "unbounded"),
 * and `useProductionPlan` surfaces a warning banner for it.
 */
export type PlanLpStatus = "ok" | "infeasible" | "unbounded" | "solver_error";

export type ProductionDependencyGraph = {
  nodes: Map<string, ProductionGraphNode>;
  edges: Array<{ from: string; to: string }>;
  targets: Set<ItemId>;
  detectedCycles: DetectedCycle[];
  invalidCycles: InvalidCycleInfo[];
  /** Global flow-LP outcome — see `PlanLpStatus`. */
  lpStatus: PlanLpStatus;
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
   * Non-fatal warnings surfaced from any calculation stage. Populated by:
   *
   *   - Phase 3 bin packing: recipe-override pin infeasibility, packer
   *     fallback, and (Step 2) per-facility cap overflow.
   *   - Metastorage selection: budget-insufficient routes, route conflicts.
   *
   * Warnings are emitted as structured `PlanWarning` discriminants so
   * the display layer can apply `ceilMode` + i18n at format time.
   * `useProductionPlan.warnings` (a memo) is the canonical formatter.
   */
  warnings: PlanWarning[];
  /**
   * Active Metastorage imports feeding this plan (one per route; the
   * item is auto-selected by the candidate enumeration in
   * `calculateProductionPlan`). Empty when no route applies. Item
   * nodes' `productionRate` stays LOCAL-only — imported supply lives
   * here exclusively, so consumers (mappers, table, stats) must add it
   * explicitly and nothing double-counts.
   */
  metastorageImports: PlanMetastorageImport[];
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
  /**
   * Items the player must seed into this bin's inner inventory at
   * startup so a 2-recipe cycle hosted by the bin (or spanning it)
   * can bootstrap. Populated by `propagatePrefillCandidates` in
   * `calculator.ts` after packing; the per-bin list is the union of
   * each member recipe's prefill items, restricted to items the bin's
   * recipes actually consume.
   *
   * **The 2-recipe cycle rule + bootability filter**: items become
   * candidates only when they participate in a TIGHT back-and-forth
   * between two recipes AND neither side of the cycle is reachable
   * from raws via the active recipe set. If even one cycle item has
   * a bootable producer (e.g. Furnace producing Sewage from raws in
   * Xircon-60), the cycle has an external entry point and emits no
   * chip — the system bootstraps via that side once any genuinely
   * stuck inner SCC is seeded.
   *
   * Two cycle shapes flagged when stuck:
   *   - **Inter-bin**: planter ↔ seedcollector moss cycle. Each bin
   *     gets the cycle item its own recipe consumes (planter→[seed],
   *     seedcollector→[plant]).
   *   - **Intra-bin (when stuck)**: a multi-formula building hosting
   *     a tight 2-cycle whose items have no bootable producer. In
   *     practice this is rare with the real recipe set; the Xircon
   *     Crucible cycle is NOT flagged because Sewage is bootable via
   *     Furnace.
   *
   * UI consumers: `CustomProductionNode` reads `node.prefillCandidates`
   * (which equals `bin.prefillCandidates` for bin-fused mappers, or
   * the per-recipe filtered list for the merged mapper).
   */
  prefillCandidates: ItemId[];
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
