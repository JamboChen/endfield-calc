import type { Recipe } from "@/types";
import { FacilityId, ItemId, RecipeId } from "@/types/constants";

/**
 * Manually-curated recipes — synthetic entries that do NOT appear in
 * the upstream game-data dump (nor in the synthesised `fluid_consume_*`
 * set) and therefore can't be emitted by `scripts/extract-recipes.ts`.
 * Combined with the auto-generated `recipes.ts` array in
 * `data/index.ts` (manual wins over any auto-generated id collision).
 *
 * Each entry below documents in its inline comment WHY it exists.
 */
export const manualRecipes: Recipe[] = [
  // Sewage inlet — BYPRODUCT variant. Active when the Byproduct Outlet
  // structure (`LIQUID_RECYCLE_GATE_1`) is ON. Emits `xiranite_poly` at
  // the in-game 30:1 ratio (4 xiranite_poly/min per building).
  // `amount: 30` / `craftingTime: 15` is the smallest integer pair that
  // preserves BOTH the 30:1 input-to-output ratio AND the inlet's
  // 120 sewage/min per-building throughput (2 sewage/s × 60 s).
  // A smaller cycle (e.g. 0.5s) would require fractional amounts.
  // Paired with the DISPOSAL variant via `facilityRecipeVariants` in
  // `src/data/index.ts` — exactly one runs at a time.
  {
    id: RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT,
    inputs: [{ itemId: ItemId.ITEM_LIQUID_SEWAGE, amount: 30 }],
    outputs: [{ itemId: ItemId.ITEM_LIQUID_XIRANITE_POLY, amount: 1 }],
    facilityId: FacilityId.LIQUID_CLEAN_GATE_1,
    craftingTime: 15,
  },
  // Sewage inlet — DISPOSAL variant. Active when the Byproduct Outlet
  // is OFF. Pure sewage sink: 1 sewage every 0.5s = 120/min per
  // building (matches the in-game per-inlet throughput). Empty
  // `outputs` ⇒ the LP / mapper classify the bin as a disposal sink
  // (`flow-utils:346` + `bin-fused-mapper:222`).
  {
    id: RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL,
    inputs: [{ itemId: ItemId.ITEM_LIQUID_SEWAGE, amount: 1 }],
    outputs: [],
    facilityId: FacilityId.LIQUID_CLEAN_GATE_1,
    craftingTime: 0.5,
  },
];
