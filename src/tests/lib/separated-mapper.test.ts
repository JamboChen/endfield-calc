import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { mapPlanToFlowSeparated } from "@/components/mappers/separated-mapper";
import { createTargetSinkId } from "@/lib/node-keys";
import { ItemId, RecipeId } from "@/types/constants";
import type { Edge } from "@xyflow/react";
import type {
  FlowProductionNode,
  FlowTargetNode,
  FlowDisposalNode,
} from "@/types";
import {
  mockItems,
  mockFacilities,
  simpleRecipes,
  complexRecipes,
  byproductRecipes,
  xirconRecipes,
  byproductSCCRecipes,
} from "./fixtures/test-data";

// ── Helpers ──────────────────────────────────────────────────────────────────

type FlowResult = {
  nodes: (FlowProductionNode | FlowTargetNode | FlowDisposalNode)[];
  edges: Edge[];
};

/** Get all edges where the given node is the source */
function outgoingEdges(result: FlowResult, nodeId: string): Edge[] {
  return result.edges.filter((e) => e.source === nodeId);
}

/** Get all edges where the given node is the target */
function incomingEdges(result: FlowResult, nodeId: string): Edge[] {
  return result.edges.filter((e) => e.target === nodeId);
}

/** Find all flow nodes whose ID starts with a given recipe ID (facility instances) */
function facilityNodes(
  result: FlowResult,
  recipeId: string,
): FlowProductionNode[] {
  return result.nodes.filter(
    (n): n is FlowProductionNode =>
      n.type === "productionNode" && n.id.startsWith(`${recipeId}-f`),
  );
}

/** Check that every production facility node has at least one edge (incoming or outgoing) */
function expectAllFacilitiesConnected(result: FlowResult): void {
  const productionNodes = result.nodes.filter(
    (n) => n.type === "productionNode",
  );

  for (const node of productionNodes) {
    const isRawMaterial = (node.data as { isRawMaterial?: boolean } | undefined)
      ?.isRawMaterial;
    if (isRawMaterial) continue; // Raw material nodes only have outgoing edges

    const out = outgoingEdges(result, node.id);
    const inc = incomingEdges(result, node.id);
    expect(
      out.length + inc.length,
      `Node ${node.id} should have at least one edge`,
    ).toBeGreaterThan(0);
  }
}

// ── Baseline tests: should pass BEFORE and AFTER fix ─────────────────────────

describe("Separated mapper — baseline (non-cycle recipes)", () => {
  test("simple linear chain: all facilities connected", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 30 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
    );

    const result = mapPlanToFlowSeparated(plan, mockItems, mockFacilities);

    // Should have nodes and edges
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);

    // Target sink should exist
    const targetSinkId = createTargetSinkId(ItemId.ITEM_IRON_POWDER);
    expect(result.nodes.some((n) => n.id === targetSinkId)).toBe(true);

    // Target sink should have incoming edges
    expect(incomingEdges(result, targetSinkId).length).toBeGreaterThan(0);

    // All production facilities should be connected
    expectAllFacilitiesConnected(result);
  });

  test("multi-tier dependency: all facilities connected", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 6 }],
      mockItems,
      complexRecipes,
      mockFacilities,
    );

    const result = mapPlanToFlowSeparated(plan, mockItems, mockFacilities);

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);

    const targetSinkId = createTargetSinkId(ItemId.ITEM_PROC_BATTERY_1);
    expect(result.nodes.some((n) => n.id === targetSinkId)).toBe(true);
    expect(incomingEdges(result, targetSinkId).length).toBeGreaterThan(0);

    expectAllFacilitiesConnected(result);
  });

  test("byproduct recipe with disposal: furnace and disposal connected", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    const result = mapPlanToFlowSeparated(plan, mockItems, mockFacilities);

    // Furnace facilities should exist and have outgoing edges
    const furnaceNodes = facilityNodes(
      result,
      RecipeId.FURNANCE_COPPER_NUGGET_1,
    );
    expect(furnaceNodes.length).toBeGreaterThan(0);
    for (const fn of furnaceNodes) {
      expect(
        outgoingEdges(result, fn.id).length,
        `Furnace ${fn.id} should have outgoing edges`,
      ).toBeGreaterThan(0);
    }

    // Disposal sink should exist and have incoming edges
    const disposalNodes = result.nodes.filter(
      (n) => n.type === "disposalSink",
    );
    expect(disposalNodes.length).toBeGreaterThan(0);
    for (const dn of disposalNodes) {
      expect(
        incomingEdges(result, dn.id).length,
        `Disposal ${dn.id} should have incoming edges`,
      ).toBeGreaterThan(0);
    }

    expectAllFacilitiesConnected(result);
  });
});

// ── Bug reproduction tests: Xircon cycle ─────────────────────────────────────

describe("Separated mapper — Xircon cycle (bug reproduction)", () => {
  const D = 30;

  function buildXirconResult(): FlowResult {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: D }],
      mockItems,
      xirconRecipes,
      mockFacilities,
    );
    return mapPlanToFlowSeparated(plan, mockItems, mockFacilities);
  }

  test("furnace (external sewage source) has outgoing Sewage edges", () => {
    const result = buildXirconResult();

    // Furnace facility nodes should exist
    const furnaceNodes = facilityNodes(
      result,
      RecipeId.FURNANCE_COPPER_NUGGET_1,
    );
    expect(
      furnaceNodes.length,
      "Furnace facility nodes should exist",
    ).toBeGreaterThan(0);

    // At least one furnace facility should have an outgoing edge (Sewage)
    const furnaceNodeIds = furnaceNodes.map((n) => n.id);
    const furnaceOutgoing = result.edges.filter((e) =>
      furnaceNodeIds.includes(e.source),
    );
    expect(
      furnaceOutgoing.length,
      "Furnace should have outgoing Sewage edges to pool_liquid consumers",
    ).toBeGreaterThan(0);
  });

  test("Reactor Crucible (pool_xiranite) connects to target sink", () => {
    const result = buildXirconResult();

    const targetSinkId = createTargetSinkId(ItemId.ITEM_XIRANITE_POLY);

    // Target sink should have incoming edges
    const targetIncoming = incomingEdges(result, targetSinkId);
    expect(
      targetIncoming.length,
      "Target sink should have incoming edges from pool_xiranite or its facilities",
    ).toBeGreaterThan(0);
  });

  test("pool_xiranite primary capacity not depleted by backward Sewage", () => {
    const result = buildXirconResult();

    const targetSinkId = createTargetSinkId(ItemId.ITEM_XIRANITE_POLY);

    // The total Xircon flow rate into the target should match demand (D=30)
    const targetIncoming = incomingEdges(result, targetSinkId);
    const totalXirconToTarget = targetIncoming.reduce(
      (sum, e) =>
        sum + ((e.data as { flowRate?: number } | undefined)?.flowRate ?? 0),
      0,
    );

    // Should be approximately D (30/min) — not 0 (depleted pool)
    expect(totalXirconToTarget).toBeGreaterThan(D * 0.9);
  });

  test("all production facilities are connected", () => {
    const result = buildXirconResult();
    expectAllFacilitiesConnected(result);
  });
});

// ── Bug reproduction: Battery + SCC variant ──────────────────────────────────

describe("Separated mapper — Battery + SCC cycle", () => {
  function buildBatteryResult(): FlowResult {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 30 }],
      mockItems,
      byproductSCCRecipes,
      mockFacilities,
    );
    return mapPlanToFlowSeparated(plan, mockItems, mockFacilities);
  }

  test("furnace has outgoing edges (Sewage to cycle consumers)", () => {
    const result = buildBatteryResult();

    const furnaceNodes = facilityNodes(
      result,
      RecipeId.FURNANCE_COPPER_NUGGET_1,
    );
    expect(furnaceNodes.length).toBeGreaterThan(0);

    const furnaceNodeIds = furnaceNodes.map((n) => n.id);
    const furnaceOutgoing = result.edges.filter((e) =>
      furnaceNodeIds.includes(e.source),
    );
    expect(
      furnaceOutgoing.length,
      "Furnace should have outgoing Sewage edges",
    ).toBeGreaterThan(0);
  });

  test("target sink has incoming edges", () => {
    const result = buildBatteryResult();

    const targetSinkId = createTargetSinkId(ItemId.ITEM_PROC_BATTERY_1);
    const targetIncoming = incomingEdges(result, targetSinkId);
    expect(
      targetIncoming.length,
      "Battery target sink should have incoming edges",
    ).toBeGreaterThan(0);
  });

  test("all production facilities are connected", () => {
    const result = buildBatteryResult();
    expectAllFacilitiesConnected(result);
  });
});
