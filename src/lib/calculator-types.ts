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

export type CondensedNode =
  | { type: "item"; itemId: ItemId }
  | { type: "recipe"; recipeId: RecipeId }
  | { type: "scc"; scc: SCCInfo };

export type FlowData = {
  itemDemands: Map<ItemId, number>;
  recipeFacilityCounts: Map<RecipeId, number>;
  /** SCC IDs that were resolved by feeder extension (no longer true cycles) */
  resolvedSCCIds: Set<string>;
};

export type RecipeChoice = {
  itemId: ItemId;
  availableRecipes: RecipeId[];
  currentIndex: number;
};

export type BuildGraphResult = {
  graph: BipartiteGraph;
  recipeChoices: Map<ItemId, RecipeChoice>;
};

export type InvalidSCCInfo = {
  sccId: string;
  involvedItems: Set<ItemId>;
  reason: "no_solution" | "no_external_demand";
};
