import { items } from "./items";
import { facilities } from "./facilities";
import { recipes } from "./recipes";
import type { ItemId } from "@/types";

const forcedRawMaterials = new Set<ItemId>([
  "item_originium_ore",
  "item_quartz_sand",
  "item_iron_ore",
  "item_liquid_water",
]);

const MAX_TARGETS = 12;

export { items, facilities, recipes, forcedRawMaterials, MAX_TARGETS };
