import type { Item, Recipe, Facility } from "@/types";
import { ItemId, RecipeId, FacilityId } from "@/types/constants";

// Mock items for testing
export const mockItems: Item[] = [
  // Raw materials
  { id: ItemId.ITEM_IRON_ORE, tier: 1 },
  { id: ItemId.ITEM_QUARTZ_SAND, tier: 1 },
  { id: ItemId.ITEM_PLANT_MOSS_SEED_1, tier: 1 },
  { id: ItemId.ITEM_PLANT_GRASS_SEED_1, tier: 1 },
  { id: ItemId.ITEM_PLANT_GRASS_SEED_2, tier: 1 },
  { id: ItemId.ITEM_LIQUID_WATER, tier: 1 },
  { id: ItemId.ITEM_ORIGINIUM_POWDER, tier: 1 },

  // Intermediate products - Iron
  { id: ItemId.ITEM_IRON_NUGGET, tier: 2 },
  { id: ItemId.ITEM_IRON_POWDER, tier: 2 },

  // Intermediate products - Quartz/Glass
  { id: ItemId.ITEM_QUARTZ_GLASS, tier: 2 },
  { id: ItemId.ITEM_QUARTZ_POWDER, tier: 2 },

  // Intermediate products - Plants
  { id: ItemId.ITEM_PLANT_MOSS_1, tier: 2 },
  { id: ItemId.ITEM_PLANT_MOSS_POWDER_1, tier: 2 },
  { id: ItemId.ITEM_PLANT_GRASS_1, tier: 2 },
  { id: ItemId.ITEM_PLANT_GRASS_2, tier: 2 },
  { id: ItemId.ITEM_PLANT_GRASS_POWDER_1, tier: 2 },
  { id: ItemId.ITEM_PLANT_GRASS_POWDER_2, tier: 2 },

  // Components
  { id: ItemId.ITEM_IRON_CMPT, tier: 3 },
  { id: ItemId.ITEM_GLASS_CMPT, tier: 3 },

  // Bottles for cycle testing
  { id: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, tier: 3 },
  { id: ItemId.ITEM_FBOTTLE_IRON_GRASS_1, tier: 3 },
  { id: ItemId.ITEM_FBOTTLE_GLASSENR_GRASS_1, tier: 3 },
  { id: ItemId.ITEM_FBOTTLE_IRONENR_GRASS_1, tier: 3 },

  // Copper chain
  { id: ItemId.ITEM_COPPER_ORE, tier: 1 },
  { id: ItemId.ITEM_COPPER_NUGGET, tier: 2 },
  { id: ItemId.ITEM_COPPER_CMPT, tier: 3 },

  // Xiranite cycle chain
  { id: ItemId.ITEM_LIQUID_XIRANITE_POLY, tier: 2 },
  { id: ItemId.ITEM_LIQUID_XIRANITE_LOWPOLY, tier: 2 },
  { id: ItemId.ITEM_XIRANITE_POLY, tier: 3 },

  // Liquids
  { id: ItemId.ITEM_LIQUID_PLANT_GRASS_1, tier: 2 },
  { id: ItemId.ITEM_LIQUID_PLANT_GRASS_2, tier: 2 },
  { id: ItemId.ITEM_LIQUID_XIRANITE, tier: 2 },
  { id: ItemId.ITEM_LIQUID_SEWAGE, tier: 2 },

  // Final products
  { id: ItemId.ITEM_PROC_BATTERY_1, tier: 4 },
  { id: ItemId.ITEM_BOTTLED_FOOD_1, tier: 4 },
  { id: ItemId.ITEM_BOTTLED_REC_HP_1, tier: 4 },
];

// Mock facilities
export const mockFacilities: Facility[] = [
  { id: FacilityId.ITEM_PORT_FURNANCE_1, powerConsumption: 10, tier: 1 },
  { id: FacilityId.ITEM_PORT_GRINDER_1, powerConsumption: 8, tier: 1 },
  { id: FacilityId.ITEM_PORT_CMPT_MC_1, powerConsumption: 12, tier: 1 },
  { id: FacilityId.ITEM_PORT_PLANTER_1, powerConsumption: 5, tier: 1 },
  { id: FacilityId.ITEM_PORT_DISMANTLER_1, powerConsumption: 10, tier: 1 },
  { id: FacilityId.ITEM_PORT_FILLING_PD_MC_1, powerConsumption: 10, tier: 1 },
  { id: FacilityId.ITEM_PORT_MIX_POOL_1, powerConsumption: 6, tier: 1 },
  { id: FacilityId.ITEM_PORT_SHAPER_1, powerConsumption: 10, tier: 1 },
  { id: FacilityId.ITEM_PORT_TOOLS_ASM_MC_1, powerConsumption: 15, tier: 1 },
  { id: FacilityId.ITEM_PORT_LIQUID_CLEANER_1, powerConsumption: 50, tier: 3 },
];

// Simple linear recipes (no cycles)
export const simpleRecipes: Recipe[] = [
  // Iron ore -> Iron nugget (30/min per facility)
  {
    id: RecipeId.FURNANCE_IRON_NUGGET_1,
    inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Iron nugget -> Iron powder (30/min per facility)
  {
    id: RecipeId.GRINDER_IRON_POWDER_1,
    inputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_POWDER, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_GRINDER_1,
    craftingTime: 2,
  },
  // Iron nugget -> Iron component (30/min per facility)
  {
    id: RecipeId.COMPONENT_IRON_CMPT_1,
    inputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_CMPT, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_CMPT_MC_1,
    craftingTime: 2,
  },
];

// Recipes with multiple options for same output
export const multiRecipeItems: Recipe[] = [
  // Iron nugget from ore
  {
    id: RecipeId.FURNANCE_IRON_NUGGET_1,
    inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Iron nugget from powder (alternative recipe)
  {
    id: RecipeId.FURNANCE_IRON_NUGGET_2,
    inputs: [{ itemId: ItemId.ITEM_IRON_POWDER, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Glass from sand
  {
    id: RecipeId.FURNANCE_QUARTZ_GLASS_1,
    inputs: [{ itemId: ItemId.ITEM_QUARTZ_SAND, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_QUARTZ_GLASS, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Glass from powder (alternative recipe)
  {
    id: RecipeId.FURNANCE_QUARTZ_GLASS_2,
    inputs: [{ itemId: ItemId.ITEM_QUARTZ_POWDER, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_QUARTZ_GLASS, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
];

// Cycle recipes: Bottle filling/dismantling cycle
export const cycleRecipes: Recipe[] = [
  // Glass from sand (base material)
  {
    id: RecipeId.FURNANCE_QUARTZ_GLASS_1,
    inputs: [{ itemId: ItemId.ITEM_QUARTZ_SAND, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_QUARTZ_GLASS, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Create bottle from glass
  {
    id: RecipeId.SHAPER_GLASS_BOTTLE_1,
    inputs: [{ itemId: ItemId.ITEM_QUARTZ_GLASS, amount: 2 }],
    outputs: [{ itemId: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_SHAPER_1,
    craftingTime: 2,
  },
  // Grass powder (needed for liquid)
  {
    id: RecipeId.GRINDER_PLANT_GRASS_POWDER_1_1,
    inputs: [{ itemId: ItemId.ITEM_PLANT_GRASS_1, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_PLANT_GRASS_POWDER_1, amount: 2 }],
    facilityId: FacilityId.ITEM_PORT_GRINDER_1,
    craftingTime: 2,
  },
  // Powder + Water -> Liquid
  {
    id: RecipeId.POOL_LIQUID_PLANT_GRASS_1_1,
    inputs: [
      { itemId: ItemId.ITEM_PLANT_GRASS_POWDER_1, amount: 1 },
      { itemId: ItemId.ITEM_LIQUID_WATER, amount: 1 },
    ],
    outputs: [{ itemId: ItemId.ITEM_LIQUID_PLANT_GRASS_1, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_MIX_POOL_1,
    craftingTime: 2,
  },
  // Fill bottle (bottle returns + liquid consumed) - THIS CREATES THE CYCLE
  {
    id: RecipeId.FILLING_BOTTLED_GLASS_GRASS_1,
    inputs: [
      { itemId: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, amount: 1 },
      { itemId: ItemId.ITEM_LIQUID_PLANT_GRASS_1, amount: 1 },
    ],
    outputs: [
      { itemId: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, amount: 1 }, // Bottle returns
    ],
    facilityId: FacilityId.ITEM_PORT_FILLING_PD_MC_1,
    craftingTime: 2,
  },
  // Dismantle bottle (bottle returns + liquid produced) - THIS COMPLETES THE CYCLE
  {
    id: RecipeId.DISMANTLER_GLASS_GRASS_1_1,
    inputs: [{ itemId: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, amount: 1 }],
    outputs: [
      { itemId: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, amount: 1 }, // Bottle returns
      { itemId: ItemId.ITEM_LIQUID_PLANT_GRASS_1, amount: 1 }, // Liquid produced
    ],
    facilityId: FacilityId.ITEM_PORT_DISMANTLER_1,
    craftingTime: 2,
  },
];

// Recipes with byproduct outputs (multi-output)
export const byproductRecipes: Recipe[] = [
  // Copper ore + Water -> Copper nugget + Liquid sewage (byproduct)
  {
    id: RecipeId.FURNANCE_COPPER_NUGGET_1,
    inputs: [
      { itemId: ItemId.ITEM_COPPER_ORE, amount: 1 },
      { itemId: ItemId.ITEM_LIQUID_WATER, amount: 1 },
    ],
    outputs: [
      { itemId: ItemId.ITEM_COPPER_NUGGET, amount: 1 },
      { itemId: ItemId.ITEM_LIQUID_SEWAGE, amount: 1 },
    ],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Copper nugget -> Copper component
  {
    id: RecipeId.COMPONENT_COPPER_CMPT_1,
    inputs: [{ itemId: ItemId.ITEM_COPPER_NUGGET, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_COPPER_CMPT, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_CMPT_MC_1,
    craftingTime: 2,
  },
  // Sewage disposal (Liquid Cleaner) — outputs nothing
  {
    id: RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
    inputs: [{ itemId: ItemId.ITEM_LIQUID_SEWAGE, amount: 1 }],
    outputs: [],
    facilityId: FacilityId.ITEM_PORT_LIQUID_CLEANER_1,
    craftingTime: 2,
  },
];

// Byproduct recipes with SCC cycle
// Models the real-world pattern: Cuprium Component + SC Wuling Battery + Sewage
//
// Graph structure:
//   Copper Ore + Water → [Furnace] → Copper Nugget + SEWAGE (byproduct)
//   Copper Nugget → [Component MC] → Copper Component (target 1)
//
//   SEWAGE + CycleInput → [Pool A] → CycleIntermediate + CycleWaste
//   CycleIntermediate × 2 + Iron Powder → [Pool B] → CycleProduct + SEWAGE
//   CycleProduct → [Assembler] → FinalProduct (target 2)
//
//   SEWAGE is target 3 — produced by Furnace (non-zero) and by Pool B (in SCC, zero)
//   The SCC (Pool A ↔ Pool B via SEWAGE/CycleIntermediate) is a NET CONSUMER of SEWAGE.
//
export const byproductSCCRecipes: Recipe[] = [
  // Copper ore + Water -> Copper nugget + Liquid sewage (byproduct)
  {
    id: RecipeId.FURNANCE_COPPER_NUGGET_1,
    inputs: [
      { itemId: ItemId.ITEM_COPPER_ORE, amount: 1 },
      { itemId: ItemId.ITEM_LIQUID_WATER, amount: 1 },
    ],
    outputs: [
      { itemId: ItemId.ITEM_COPPER_NUGGET, amount: 1 },
      { itemId: ItemId.ITEM_LIQUID_SEWAGE, amount: 1 },
    ],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Copper nugget -> Copper component
  {
    id: RecipeId.COMPONENT_COPPER_CMPT_1,
    inputs: [{ itemId: ItemId.ITEM_COPPER_NUGGET, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_COPPER_CMPT, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_CMPT_MC_1,
    craftingTime: 2,
  },
  // Sewage + Liquid Xiranite -> Liquid Xiranite Poly + Liquid Xiranite Lowpoly
  // (Pool A: consumes sewage, produces intermediate)
  {
    id: RecipeId.POOL_LIQUID_XIRANITE_POLY_1,
    inputs: [
      { itemId: ItemId.ITEM_LIQUID_XIRANITE_POLY, amount: 1 },
      { itemId: ItemId.ITEM_LIQUID_SEWAGE, amount: 1 },
    ],
    outputs: [
      { itemId: ItemId.ITEM_LIQUID_XIRANITE_POLY, amount: 1 },
      { itemId: ItemId.ITEM_LIQUID_XIRANITE_LOWPOLY, amount: 1 },
    ],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Liquid Xiranite Poly × 2 + Iron Powder -> Xiranite Poly + Sewage
  // (Pool B: produces sewage, consumes intermediate — closes the SCC)
  {
    id: RecipeId.POOL_XIRANITE_POLY_1,
    inputs: [
      { itemId: ItemId.ITEM_LIQUID_XIRANITE_POLY, amount: 2 },
      { itemId: ItemId.ITEM_IRON_POWDER, amount: 1 },
    ],
    outputs: [
      { itemId: ItemId.ITEM_XIRANITE_POLY, amount: 1 },
      { itemId: ItemId.ITEM_LIQUID_SEWAGE, amount: 1 },
    ],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Xiranite Poly -> Proc Battery (FinalProduct, target 2)
  {
    id: RecipeId.TOOLS_PROC_BATTERY_1_1,
    inputs: [{ itemId: ItemId.ITEM_XIRANITE_POLY, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_1, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_TOOLS_ASM_MC_1,
    craftingTime: 2,
  },
  // Iron ore -> Iron nugget (for iron powder chain)
  {
    id: RecipeId.FURNANCE_IRON_NUGGET_1,
    inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Iron nugget -> Iron powder
  {
    id: RecipeId.GRINDER_IRON_POWDER_1,
    inputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_POWDER, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_GRINDER_1,
    craftingTime: 2,
  },
];

// Complex multi-tier dependency
export const complexRecipes: Recipe[] = [
  // Battery production
  {
    id: RecipeId.TOOLS_PROC_BATTERY_1_1,
    inputs: [
      { itemId: ItemId.ITEM_GLASS_CMPT, amount: 5 },
      { itemId: ItemId.ITEM_IRON_CMPT, amount: 10 }, // Using iron instead of originium for simplicity
    ],
    outputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_1, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_TOOLS_ASM_MC_1,
    craftingTime: 10,
  },
  // Glass component
  {
    id: RecipeId.COMPONENT_GLASS_CMPT_1,
    inputs: [{ itemId: ItemId.ITEM_QUARTZ_GLASS, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_GLASS_CMPT, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_CMPT_MC_1,
    craftingTime: 2,
  },
  // Iron component
  {
    id: RecipeId.COMPONENT_IRON_CMPT_1,
    inputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_CMPT, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_CMPT_MC_1,
    craftingTime: 2,
  },
  // Glass from sand
  {
    id: RecipeId.FURNANCE_QUARTZ_GLASS_1,
    inputs: [{ itemId: ItemId.ITEM_QUARTZ_SAND, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_QUARTZ_GLASS, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
  // Iron from ore
  {
    id: RecipeId.FURNANCE_IRON_NUGGET_1,
    inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    facilityId: FacilityId.ITEM_PORT_FURNANCE_1,
    craftingTime: 2,
  },
];
