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

type Facility = {
  id: FacilityId;
  powerConsumption: number;
  iconUrl?: string;
  tier: number;
};

export type { Item, Recipe, RecipeItem, Facility };
