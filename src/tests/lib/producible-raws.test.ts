import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { mapPlanToFlowMerged } from "@/components/mappers/merged-mapper";
import {
  mapPlanToFlowBinFused,
  mapPlanToFlowBinFusedSeparated,
} from "@/components/mappers/bin-fused-mapper";
import { items, recipes, facilities, producibleRaws } from "@/data";
import { ItemId, RecipeId } from "@/types/constants";
import type { ItemId as ItemIdT, ProductionGraphNode } from "@/types";
import { ALL_RAWS } from "./utils";

const XIRAGEN = ItemId.ITEM_GAS_XIRANITE;
const TRANSMUTER_XIRAGEN = RecipeId.LIQUID_TRANSMUTER_2_GAS_GAS_XIRANITE_1;

/** Sum of active facility counts of every recipe producing `itemId`. */
function producerFc(
  plan: Awaited<ReturnType<typeof calculateProductionPlan>>,
  itemId: ItemIdT,
): number {
  let fc = 0;
  for (const node of plan.nodes.values()) {
    if (node.type !== "recipe") continue;
    if (node.recipe.outputs.some((o) => o.itemId === itemId)) {
      fc += node.facilityCount;
    }
  }
  return fc;
}

function itemNode(
  plan: Awaited<ReturnType<typeof calculateProductionPlan>>,
  itemId: ItemIdT,
): Extract<ProductionGraphNode, { type: "item" }> | undefined {
  const n = plan.nodes.get(itemId);
  return n && n.type === "item" ? n : undefined;
}

describe("producible raws (Xiragen crafted vs. vent-mined)", () => {
  test("policy set: opt-out of costless raws only", () => {
    expect(producibleRaws.has(XIRAGEN)).toBe(true);
    expect(producibleRaws.has(ItemId.ITEM_GAS_INERT)).toBe(true);
    // Costless liquids are excluded — they stay pure infinite leaves.
    expect(producibleRaws.has(ItemId.ITEM_LIQUID_WATER)).toBe(false);
    expect(producibleRaws.has(ItemId.ITEM_LIQUID_ACID)).toBe(false);
  });

  test("Xiragen as a target is vent-mined by default (consume before craft)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: XIRAGEN, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );
    expect(plan.lpStatus).toBe("ok");
    const x = itemNode(plan, XIRAGEN);
    expect(x).toBeDefined();
    expect(x!.isRawMaterial).toBe(true);
    // Vent supplies the whole target; the transmuter stays idle.
    expect(x!.rawSupplyRate ?? 0).toBeGreaterThanOrEqual(60 - 1e-3);
    expect(plan.nodes.has(TRANSMUTER_XIRAGEN)).toBe(false);
  });

  test("zero vent cap forces the transmuter to craft Xiragen", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: XIRAGEN, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS, rawCaps: new Map([[XIRAGEN, 0]]) },
    );
    expect(plan.lpStatus).toBe("ok");
    const x = itemNode(plan, XIRAGEN);
    expect(x).toBeDefined();
    // No vent draw; a recipe must produce the Xiragen.
    expect(x!.rawSupplyRate ?? 0).toBeLessThan(1e-3);
    expect(producerFc(plan, XIRAGEN)).toBeGreaterThan(0);
    // Total supply still meets the target.
    expect(x!.productionRate).toBeGreaterThanOrEqual(60 - 1e-3);
  });

  test("above the vent cap, the vent fills first and the transmuter covers the overflow", async () => {
    const cap = 120;
    const plan = await calculateProductionPlan(
      [{ itemId: XIRAGEN, rate: 200 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS, rawCaps: new Map([[XIRAGEN, cap]]) },
    );
    expect(plan.lpStatus).toBe("ok");
    const x = itemNode(plan, XIRAGEN);
    expect(x).toBeDefined();
    // Vent is mined up to (but not beyond) its cap...
    expect(x!.rawSupplyRate ?? 0).toBeGreaterThan(0);
    expect(x!.rawSupplyRate ?? 0).toBeLessThanOrEqual(cap + 1e-3);
    // ...and the transmuter crafts the rest.
    expect(producerFc(plan, XIRAGEN)).toBeGreaterThan(0);
    expect(x!.productionRate).toBeGreaterThanOrEqual(200 - 1e-3);
  });

  test("disabling producible raws restores pure-leaf behaviour (no transmuter escape)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: XIRAGEN, rate: 60 }],
      items,
      recipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        rawCaps: new Map([[XIRAGEN, 0]]),
        producibleRaws: new Set(),
      },
    );
    // With no producible raws, Xiragen is a pure leaf again: the target
    // is satisfied by (capped) raw draw, never crafted.
    expect(producerFc(plan, XIRAGEN)).toBe(0);
    expect(plan.nodes.has(TRANSMUTER_XIRAGEN)).toBe(false);
  });

  test("mappers render a vent-mined Xiragen target (visible sink, no integrity violation)", async () => {
    // assertFlowIntegrity throws in test mode, so a clean map is the
    // assertion.
    const plan = await calculateProductionPlan(
      [{ itemId: XIRAGEN, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );
    const targetRates = new Map<ItemIdT, number>([[XIRAGEN, 60]]);
    const flows = [
      mapPlanToFlowBinFused(plan, items, recipes, facilities, targetRates),
      mapPlanToFlowBinFusedSeparated(plan, items, recipes, facilities, targetRates),
      mapPlanToFlowMerged(plan, items, facilities, targetRates),
    ];
    for (const flow of flows) {
      // The Xiragen target must be visible: at least one node references
      // it (a target sink and/or vent pickup).
      const xiragenNodes = flow.nodes.filter((n) => n.id.includes(XIRAGEN));
      expect(xiragenNodes.length).toBeGreaterThan(0);
    }
  });

  test("mappers render a crafted (zero-vent) Xiragen target without integrity violation", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: XIRAGEN, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS, rawCaps: new Map([[XIRAGEN, 0]]) },
    );
    const targetRates = new Map<ItemIdT, number>([[XIRAGEN, 60]]);
    expect(() =>
      mapPlanToFlowBinFused(plan, items, recipes, facilities, targetRates),
    ).not.toThrow();
    expect(() =>
      mapPlanToFlowBinFusedSeparated(plan, items, recipes, facilities, targetRates),
    ).not.toThrow();
    expect(() =>
      mapPlanToFlowMerged(plan, items, facilities, targetRates),
    ).not.toThrow();
  });
});
