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

// Items that are mandatory byproducts and must be disposed of (consumed by a disposal recipe).
// When a production recipe generates these as a byproduct, the disposal recipe is automatically included.
const forcedDisposalItems = new Set<ItemId>([
  "item_liquid_sewage",
  "item_liquid_xiranite_lowpoly",
  "item_liquid_xiranite_poly",
]);

export { items, facilities, recipes, forcedRawMaterials, forcedDisposalItems, MAX_TARGETS };
