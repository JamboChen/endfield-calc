import type {
  DomainId,
  ItemId,
  RecipeId,
  FacilityId,
  Item,
  Recipe,
  Facility,
} from "@/types";

export type ProductionMaps = {
  itemMap: Map<ItemId, Item>;
  recipeMap: Map<RecipeId, Recipe>;
  facilityMap: Map<FacilityId, Facility>;
};

export type ItemNode = {
  itemId: ItemId;
  item: Item;
  isRawMaterial: boolean;
};

export type RecipeNodeData = {
  recipeId: RecipeId;
  recipe: Recipe;
  facility: Facility;
};

export type BipartiteGraph = {
  itemNodes: Map<ItemId, ItemNode>;
  recipeNodes: Map<RecipeId, RecipeNodeData>;

  itemConsumedBy: Map<ItemId, Set<RecipeId>>;

  recipeInputs: Map<RecipeId, Set<ItemId>>;
  recipeOutputs: Map<RecipeId, Set<ItemId>>;

  targets: Set<ItemId>;
  rawMaterials: Set<ItemId>;
};

export type SCCInfo = {
  id: string;
  items: Set<ItemId>;
  recipes: Set<RecipeId>;
  externalInputs: Set<ItemId>;
};

/**
 * One active Metastorage import in a solved flow: the route's single
 * transferred item with its LP-chosen rate and TTV accounting. Empty
 * `FlowData.metastorageFlows` means no route was supplied or the LP
 * left every route unused.
 */
export type MetastorageFlow = {
  sourceDomain: DomainId;
  itemId: ItemId;
  ratePerMinute: number;
  ttvCostPerItem: number;
  ttvUsedPerMinute: number;
  ttvBudgetPerMinute: number;
  /** TTV/min beyond the budget absorbed by the soft-cap slack (0 = within budget). */
  ttvOverusePerMinute: number;
};

export type FlowData = {
  itemDemands: Map<ItemId, number>;
  recipeFacilityCounts: Map<RecipeId, number>;
  metastorageFlows: MetastorageFlow[];
};

/**
 * LP-solution quality metrics surfaced by `calculateFlows` for the
 * Metastorage candidate enumeration in `calculator.ts`. Compared
 * lexicographically: `feasible` → `slackMagnitude` → `powerShortfall`
 * → `totalRawCost` → `totalBuildingCount` → `totalPower` →
 * `totalTtvUsedPerMinute`. `ttvOverusePerMinute` is not a ranking key
 * — it's the viability gate: any positive value disqualifies the
 * candidate outright (an over-budget plan is physically unrealizable).
 *
 * **Cross-unit rule**: metrics with different units must NEVER be
 * summed into one key — `powerShortfall` (watts) folded into
 * `slackMagnitude` (items/min) once let the selection trade a cap
 * violation for a token amount of generation. New soft tiers get
 * their own comparison key at the position matching the LP's penalty
 * lattice.
 */
export type FlowSolveMetrics = {
  feasible: boolean;
  /**
   * Pass-1 failure reason when `feasible` is false (threaded from
   * `solveLP` so the plan can carry an honest `lpStatus` instead of a
   * silent empty shell — see `PlanLpStatus` in `types/production.ts`).
   * Absent on feasible solves.
   */
  failureReason?: "infeasible" | "unbounded" | "solver_error";
  /**
   * Σ of the `SLACK_PENALTY`-tier soft-constraint violations (disposal
   * deficits + surpluses + raw-cap overuse + TTV-budget overuse), all
   * in items-per-minute-scale units. A candidate with less slack is
   * strictly better regardless of cost totals — the LP itself already
   * prices this tier at `SLACK_PENALTY`, this mirrors that ranking
   * across separate solves. `powerShortfall` (watts — a LOWER tier and
   * a different unit) is deliberately NOT included; it has its own
   * comparison key.
   */
  slackMagnitude: number;
  /**
   * Σ TTV-budget overage across routes, in TTV/min. Positive ⟺ the LP
   * needed an import beyond a route's budget (only possible for
   * import-only demand — see `TTV_SLACK_PENALTY` in `lp-solver.ts`).
   */
  ttvOverusePerMinute: number;
  /**
   * Watts of self-sustaining-power demand not fundable from headroom
   * under the user's raw/facility caps (`LPSolution.powerShortfall`).
   * 0 when power sustain is off or fully funded. Surfaced by the
   * calculator as the `power-sustain-insufficient` plan warning, and
   * ranked as its own comparison key AFTER `slackMagnitude` (cap
   * compliance strictly dominates power coverage) and BEFORE
   * `totalRawCost` (covering power is worth real cost, within caps).
   */
  powerShortfall: number;
  totalRawCost: number;
  totalBuildingCount: number;
  totalPower: number;
  totalTtvUsedPerMinute: number;
};

export type InvalidSCCInfo = {
  sccId: string;
  involvedItems: Set<ItemId>;
  reason: "no_solution" | "no_external_demand";
};
