import type { ItemId, RecipeId, FacilityId, Item, Recipe, Facility } from "@/types";

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

export type FlowData = {
  itemDemands: Map<ItemId, number>;
  recipeFacilityCounts: Map<RecipeId, number>;
  /**
   * SCC IDs whose flow was successfully solved. Under the global LP all
   * detected SCCs are resolved in one solve (no feeder-extension or
   * per-SCC retry phase), so this is simply `new Set(detectedSCCs.map(s => s.id))`
   * when `flowData.feasible === true`. Kept on the data type so mappers
   * can still gate "is this cycle backward-edge-styled?" off it.
   */
  resolvedSCCIds: Set<string>;
};

export type InvalidSCCInfo = {
  sccId: string;
  involvedItems: Set<ItemId>;
  reason: "no_solution" | "no_external_demand";
};
