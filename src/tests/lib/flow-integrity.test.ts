import { describe, test, expect, beforeAll } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { mapPlanToFlowMerged } from "@/components/mappers/merged-mapper";
import { mapPlanToFlowSeparated } from "@/components/mappers/separated-mapper";
import { items, recipes, facilities } from "@/data";
import type { ItemId, ProductionDependencyGraph } from "@/types";
import type { Edge, Node } from "@xyflow/react";

function checkIntegrity(nodes: Node[], edges: Edge[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const dangling: string[] = [];
  const referenced = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e.source)) dangling.push(`edge ${e.id} source ${e.source} missing`);
    if (!ids.has(e.target)) dangling.push(`edge ${e.id} target ${e.target} missing`);
    referenced.add(e.source);
    referenced.add(e.target);
  }
  const isolated = nodes.filter((n) => !referenced.has(n.id)).map((n) => n.id);
  return { dangling, isolated };
}

const cases: { name: string; targetId: ItemId; rate: number }[] = [
  { name: "copper_nugget with sewage byproduct", targetId: "item_copper_nugget" as ItemId, rate: 6 },
  { name: "iron_nugget", targetId: "item_iron_nugget" as ItemId, rate: 10 },
  { name: "xiranite_poly", targetId: "item_xiranite_poly" as ItemId, rate: 5 },
];

describe("flow mapper integrity", () => {
  const plans = new Map<string, { plan: ProductionDependencyGraph; targetRates: Map<ItemId, number> }>();

  beforeAll(() => {
    for (const c of cases) {
      const plan = calculateProductionPlan(
        [{ itemId: c.targetId, rate: c.rate }],
        items,
        recipes,
        facilities,
      );
      plans.set(c.name, { plan, targetRates: new Map([[c.targetId, c.rate]]) });
    }
  });

  for (const c of cases) {
    test(`${c.name}: merged has no dangling edges or isolated nodes`, () => {
      const { plan, targetRates } = plans.get(c.name)!;
      const flow = mapPlanToFlowMerged(plan, items, facilities, targetRates);
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
    });

    test(`${c.name}: separated has no dangling edges or isolated nodes`, () => {
      const { plan, targetRates } = plans.get(c.name)!;
      const flow = mapPlanToFlowSeparated(plan, items, facilities, targetRates);
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
    });
  }
});

describe("Phase 3 bin-aware integrity", () => {
  test("xircon plan: every recipe node has a binId after Phase 3", () => {
    // Phase 3 should annotate every active recipe in the plan with a
    // binId (singleton or grouped). Recipes lacking a binId would render
    // as if Phase 3 didn't run, which breaks downstream amortization
    // logic in the production table and node tooltips.
    const plan = calculateProductionPlan(
      [{ itemId: "item_xiranite_poly" as ItemId, rate: 5 }],
      items,
      recipes,
      facilities,
    );
    for (const node of plan.nodes.values()) {
      if (node.type !== "recipe") continue;
      if (node.isDisposal) continue;
      if (node.facilityCount <= 1e-9) continue;
      expect(node.binId).toBeDefined();
    }
  });

  test("internal-flow edges only between same-bin recipes (and Xircon plan emits at least one)", () => {
    // Sanity invariant: an edge tagged direction='internal' must connect
    // two facility instances whose recipes are in the same bin.
    //
    // Positive assertion: the Xircon plan groups LX/XE/X into Expanded
    // Crucibles, so the separated mapper MUST emit at least one
    // internal edge (LX → XE, since Liquid Xiranite is fully internal
    // to the {LX, XE, X} bin). A regression that breaks the
    // co-location detection (e.g. id-vs-signature mismatch) would
    // produce zero internal edges and the test should catch it.
    const plan = calculateProductionPlan(
      [{ itemId: "item_xiranite_poly" as ItemId, rate: 5 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowSeparated(plan, items, facilities, new Map());

    // Build a bin-membership lookup keyed by recipe id.
    const recipeToBin = new Map<string, string | undefined>();
    for (const node of plan.nodes.values()) {
      if (node.type === "recipe") recipeToBin.set(node.recipeId, node.binId);
    }

    const recipeIdFromFacilityId = (fid: string): string | null => {
      const m = fid.match(/^(.+)-f\d+$/);
      return m ? m[1] : null;
    };

    let internalCount = 0;
    for (const edge of flow.edges) {
      const data = edge.data as { direction?: string } | undefined;
      if (data?.direction !== "internal") continue;
      internalCount += 1;
      const srcRecipe = recipeIdFromFacilityId(edge.source);
      const tgtRecipe = recipeIdFromFacilityId(edge.target);
      if (!srcRecipe || !tgtRecipe) continue;
      const srcBin = recipeToBin.get(srcRecipe);
      const tgtBin = recipeToBin.get(tgtRecipe);
      // Internal edges should connect recipes in the same bin (and
      // grouped, since singleton bins have no internal pairs).
      expect(srcBin).toBeDefined();
      expect(tgtBin).toBeDefined();
      expect(srcBin).toBe(tgtBin);
    }

    // Positive assertion: at least one internal edge exists in the
    // grouped Xircon plan. Catches regressions where co-location
    // detection silently fails (e.g. demand-vs-physical id mismatch).
    expect(internalCount).toBeGreaterThan(0);
  });
});
