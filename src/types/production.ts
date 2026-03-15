import type { Item, Recipe, Facility, ItemId, RecipeId } from "@/types";

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
      facility: Facility;
      facilityCount: number;
      isDisposal?: boolean;
    };

export type ProductionDependencyGraph = {
  nodes: Map<string, ProductionGraphNode>;
  edges: Array<{ from: string; to: string }>;
  targets: Set<ItemId>;
  detectedCycles: DetectedCycle[];
};
