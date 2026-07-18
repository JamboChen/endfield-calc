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

/* ── Mapper conservation helpers ── */

const SINK_ID = `target-sink-${XIRAGEN}`;
type Edgeish = { source: string; target: string; data?: unknown };
type FlowLike = { nodes: { id: string }[]; edges: Edgeish[] };

/** Run all three mappers with an optional Xiragen target rate. */
function mapAll(
  plan: Awaited<ReturnType<typeof calculateProductionPlan>>,
  xiragenTargetRate: number | undefined,
): FlowLike[] {
  const tr =
    xiragenTargetRate === undefined
      ? undefined
      : new Map<ItemIdT, number>([[XIRAGEN, xiragenTargetRate]]);
  return [
    mapPlanToFlowBinFused(plan, items, recipes, facilities, tr),
    mapPlanToFlowBinFusedSeparated(plan, items, recipes, facilities, tr),
    mapPlanToFlowMerged(plan, items, facilities, tr),
  ] as FlowLike[];
}

const edgeRate = (e: Edgeish): number =>
  (e.data as { flowRate?: number } | undefined)?.flowRate ?? 0;
const edgeItemId = (e: Edgeish): string | undefined =>
  (e.data as { itemId?: string } | undefined)?.itemId;
const sumRate = (edges: Edgeish[]): number =>
  edges.reduce((s, e) => s + edgeRate(e), 0);
const edgesInto = (flow: FlowLike, targetId: string): Edgeish[] =>
  flow.edges.filter((e) => e.target === targetId);
/** Vent-pickup edges: source is a Xiragen raw-material pickup node. */
const ventEdges = (edges: Edgeish[]): Edgeish[] =>
  edges.filter((e) => e.source.startsWith(`raw_${XIRAGEN}`));
/** Producer (non-vent) edges — the transmuter's crafted output. */
const craftEdges = (edges: Edgeish[]): Edgeish[] =>
  edges.filter((e) => !e.source.startsWith("raw_"));
const craftEdgesForItem = (edges: Edgeish[], itemId: string): Edgeish[] =>
  edges.filter((e) => edgeItemId(e) === itemId && !e.source.startsWith("raw_"));

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

  test("all mappers render a vent-mined Xiragen target as a conserved sink", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: XIRAGEN, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );
    // assertFlowIntegrity throws in test mode, so a clean map is itself an
    // assertion; then check the sink is present + conserved + vent-fed.
    for (const flow of mapAll(plan, 60)) {
      const into = edgesInto(flow, SINK_ID);
      expect(sumRate(into)).toBeCloseTo(60, 1);
      // Vent-mined ⇒ every inbound edge comes from a vent pickup, none
      // from a transmuter.
      expect(ventEdges(into).length).toBeGreaterThan(0);
      expect(craftEdges(into).length).toBe(0);
    }
  });

  test("all mappers split an over-cap Xiragen target across vent + transmuter", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: XIRAGEN, rate: 200 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS, rawCaps: new Map([[XIRAGEN, 120]]) },
    );
    for (const flow of mapAll(plan, 200)) {
      // Sink is conserved at the requested rate...
      expect(sumRate(edgesInto(flow, SINK_ID))).toBeCloseTo(200, 1);
      // ...and BOTH sources appear in the graph (vent up to cap + craft).
      const ventTotal = sumRate(ventEdges(flow.edges));
      const craftTotal = sumRate(craftEdgesForItem(flow.edges, XIRAGEN));
      expect(ventTotal).toBeGreaterThan(0);
      expect(ventTotal).toBeLessThanOrEqual(120 + 1);
      expect(craftTotal).toBeGreaterThan(0);
    }
  });

  test("all mappers render a zero-vent Xiragen target fed only by the transmuter", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: XIRAGEN, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS, rawCaps: new Map([[XIRAGEN, 0]]) },
    );
    for (const flow of mapAll(plan, 60)) {
      const into = edgesInto(flow, SINK_ID);
      expect(sumRate(into)).toBeCloseTo(60, 1);
      // No vent draw anywhere for this item — the sink is entirely crafted.
      expect(ventEdges(flow.edges).length).toBe(0);
      expect(craftEdges(into).length).toBeGreaterThan(0);
    }
  });

  test("crafted Xiragen consumed downstream is drawn from the transmuter, not the vent", async () => {
    // Xiragen as an INTERMEDIATE (consumed by the copper-jar filler) while
    // the vent cap forces it to be crafted — the transmuter's output must
    // feed the consumer instead of the flow silently attributing it to a
    // (non-existent) vent pickup.
    const JAR = ItemId.ITEM_GASJAR_COPPER_GAS_XIRANITE;
    const plan = await calculateProductionPlan(
      [{ itemId: JAR, rate: 30 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS, rawCaps: new Map([[XIRAGEN, 0]]) },
    );
    expect(producerFc(plan, XIRAGEN)).toBeGreaterThan(0);
    for (const flow of mapAll(plan, undefined)) {
      const xiragenEdges = flow.edges.filter(
        (e) => edgeItemId(e) === XIRAGEN,
      );
      // Some Xiragen flows exist, none sourced from a vent pickup (cap 0),
      // and at least one from a real producer (the transmuter).
      expect(xiragenEdges.length).toBeGreaterThan(0);
      expect(ventEdges(xiragenEdges).length).toBe(0);
      expect(craftEdges(xiragenEdges).length).toBeGreaterThan(0);
    }
  });
});
