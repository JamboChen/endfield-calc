import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { items, recipes, facilities } from "@/data";
import { ItemId, RecipeId } from "@/types/constants";
import type { ProductionDependencyGraph } from "@/types";

const getRecipeNode = (
  graph: ProductionDependencyGraph,
  recipeId: RecipeId,
) => {
  const node = graph.nodes.get(recipeId);
  if (!node || node.type !== "recipe") return null;
  return node;
};

const getItemNode = (graph: ProductionDependencyGraph, itemId: ItemId) => {
  const node = graph.nodes.get(itemId);
  if (!node || node.type !== "item") return null;
  return node;
};

describe("item_xiranite_poly production plan", () => {
  test("should produce a valid plan without FAILED cycles", () => {
    console.log("\n=== Starting xiranite_poly test ===");

    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 60 }],
      items,
      recipes,
      facilities,
    );

    console.log("\n=== Plan result ===");
    console.log("Number of nodes:", plan.nodes.size);
    console.log("Number of edges:", plan.edges.length);
    console.log("Detected cycles:", plan.detectedCycles.length);
    plan.detectedCycles.forEach((c) => {
      console.log("  Cycle:", c.cycleId, "items:", c.involvedItemIds);
    });

    // Check key recipe nodes exist and have reasonable facility counts
    const xiranitePolyRecipe = getRecipeNode(
      plan,
      RecipeId.POOL_XIRANITE_POLY_1,
    );
    console.log(
      "\nPOOL_XIRANITE_POLY_1 facilityCount:",
      xiranitePolyRecipe?.facilityCount,
    );

    const liquidXiranitePoly = getRecipeNode(
      plan,
      RecipeId.POOL_LIQUID_XIRANITE_POLY_1,
    );
    console.log(
      "POOL_LIQUID_XIRANITE_POLY_1 facilityCount:",
      liquidXiranitePoly?.facilityCount,
    );

    // Check item production rates
    const xiranitePolyItem = getItemNode(plan, ItemId.ITEM_XIRANITE_POLY);
    console.log(
      "\nitem_xiranite_poly productionRate:",
      xiranitePolyItem?.productionRate,
    );

    const liquidXiranitePolyItem = getItemNode(
      plan,
      ItemId.ITEM_LIQUID_XIRANITE_POLY,
    );
    console.log(
      "item_liquid_xiranite_poly productionRate:",
      liquidXiranitePolyItem?.productionRate,
    );

    const liquidSewageItem = getItemNode(plan, ItemId.ITEM_LIQUID_SEWAGE);
    console.log(
      "item_liquid_sewage productionRate:",
      liquidSewageItem?.productionRate,
    );

    // Assert: plan must include POOL_XIRANITE_POLY_1 recipe
    expect(xiranitePolyRecipe).not.toBeNull();
    expect(xiranitePolyRecipe!.facilityCount).toBeGreaterThan(0);

    // Assert: plan must include POOL_LIQUID_XIRANITE_POLY_1 recipe
    expect(liquidXiranitePoly).not.toBeNull();
    expect(liquidXiranitePoly!.facilityCount).toBeGreaterThan(0);

    // Assert: xiranite_poly production should match target rate (60/min)
    expect(xiranitePolyItem).not.toBeNull();
    expect(xiranitePolyItem!.productionRate).toBeCloseTo(60, 1);

    // Assert: no "invalid" cycles reported (detectedCycles can exist, but all
    // should have been solved — i.e., all have nonzero facility counts)
    plan.detectedCycles.forEach((cycle) => {
      cycle.cycleNodes.forEach((node) => {
        expect(node.facilityCount).toBeGreaterThan(0);
      });
    });
  });
});
