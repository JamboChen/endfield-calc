/**
 * Layout cache + camera decision (`src/components/flow/layout-cache.ts`):
 * combo-key normalization, plan-identity/targetRates cache guards, and
 * the pure `decideCameraAction` (whose implicit inline predecessor
 * produced a real bug: a same-combo effect re-run under StrictMode
 * nulled a parked fit and stranded the graph at the default camera).
 * `computeFlowLayout` is exercised end-to-end on the bundled ELK engine
 * with a small synthetic plan to pin the mapper-selection rules.
 */
import { describe, test, expect } from "vitest";
import type { Viewport } from "@xyflow/react";
import { calculateProductionPlan } from "@/lib/calculator";
import {
  computeFlowLayout,
  decideCameraAction,
  getCachedLayout,
  layoutComboKey,
  setCachedLayout,
  type LayoutInputs,
} from "@/components/flow/layout-cache";
import { FacilityId, ItemId, RecipeId } from "@/types/constants";
import type {
  Facility,
  Item,
  ItemId as ItemIdType,
  ProductionDependencyGraph,
  Recipe,
} from "@/types";

function mkInputs(overrides: Partial<LayoutInputs> = {}): LayoutInputs {
  return {
    plan: { nodes: new Map() } as unknown as ProductionDependencyGraph,
    items: [],
    recipes: [],
    facilities: [],
    targetRates: undefined,
    visualizationMode: "merged",
    twoEndAlignment: false,
    ceilMode: false,
    binFusion: true,
    ...overrides,
  };
}

describe("layoutComboKey", () => {
  test("binFusion is normalized out for separated mode (always bin-fused)", () => {
    const bf1 = layoutComboKey(mkInputs({ visualizationMode: "separated", binFusion: true }));
    const bf0 = layoutComboKey(mkInputs({ visualizationMode: "separated", binFusion: false }));
    expect(bf1).toBe(bf0);
  });

  test("binFusion distinguishes merged-mode combos", () => {
    const bf1 = layoutComboKey(mkInputs({ binFusion: true }));
    const bf0 = layoutComboKey(mkInputs({ binFusion: false }));
    expect(bf1).not.toBe(bf0);
  });

  test("mode, alignment, and ceil each produce distinct combos", () => {
    const keys = new Set([
      layoutComboKey(mkInputs()),
      layoutComboKey(mkInputs({ visualizationMode: "separated" })),
      layoutComboKey(mkInputs({ twoEndAlignment: true })),
      layoutComboKey(mkInputs({ ceilMode: true })),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe("layout cache", () => {
  const entry = { nodes: [], edges: [] };

  test("roundtrip on the same plan identity + combo", () => {
    const inputs = mkInputs();
    expect(getCachedLayout(inputs)).toBeUndefined();
    setCachedLayout(inputs, entry);
    expect(getCachedLayout(inputs)).toBe(entry);
  });

  test("a different plan object is a different cache generation", () => {
    const a = mkInputs();
    setCachedLayout(a, entry);
    const b = mkInputs(); // fresh plan object
    expect(getCachedLayout(b)).toBeUndefined();
  });

  test("targetRates identity change invalidates the plan's entries", () => {
    const plan = { nodes: new Map() } as unknown as ProductionDependencyGraph;
    const ratesA = new Map<ItemIdType, number>();
    const a = mkInputs({ plan, targetRates: ratesA });
    setCachedLayout(a, entry);
    expect(getCachedLayout(a)).toBe(entry);
    // Same CONTENT, different identity — the transient pre-solve window.
    const b = mkInputs({ plan, targetRates: new Map<ItemIdType, number>() });
    expect(getCachedLayout(b)).toBeUndefined();
  });

  test("combos on the same plan do not collide, and writes overwrite", () => {
    const plan = { nodes: new Map() } as unknown as ProductionDependencyGraph;
    const merged = mkInputs({ plan });
    const separated = mkInputs({ plan, visualizationMode: "separated" });
    setCachedLayout(merged, entry);
    expect(getCachedLayout(separated)).toBeUndefined();
    const newer = { nodes: [], edges: [] };
    setCachedLayout(merged, newer);
    expect(getCachedLayout(merged)).toBe(newer);
  });
});

describe("decideCameraAction", () => {
  const viewport: Viewport = { x: 10, y: 20, zoom: 0.5 };

  test("a stored viewport always wins", () => {
    expect(
      decideCameraAction({ viewport, nodes: [], modeChanged: true, canvasEmpty: true }),
    ).toEqual({ type: "viewport", viewport });
  });

  test("mode change without a viewport is an animated fit", () => {
    expect(
      decideCameraAction({ nodes: [], modeChanged: true, canvasEmpty: false }),
    ).toEqual({ type: "fit", nodes: [], animate: true });
  });

  test("empty canvas without a viewport is an instant fit", () => {
    expect(
      decideCameraAction({ nodes: [], modeChanged: false, canvasEmpty: true }),
    ).toEqual({ type: "fit", nodes: [], animate: false });
  });

  test("same mode on a populated canvas keeps the camera (null)", () => {
    // The StrictMode-regression shape: a same-combo re-run on an EMPTY
    // canvas must NOT hit this branch (covered above) — only genuinely
    // camera-neutral runs do.
    expect(
      decideCameraAction({ nodes: [], modeChanged: false, canvasEmpty: false }),
    ).toBeNull();
  });
});

describe("computeFlowLayout mapper selection", () => {
  const items: Item[] = [
    { id: ItemId.ITEM_IRON_ORE, tier: 1 },
    { id: ItemId.ITEM_IRON_NUGGET, tier: 2 },
  ];
  const facility: Facility = {
    id: FacilityId.FURNANCE_1,
    category: 0,
    buffersIn: { belt: [], pipe: [] },
    buffersOut: { belt: [], pipe: [] },
    domains: [],
    powerConsumption: 10,
    tier: 1,
  };
  const recipe: Recipe = {
    id: RecipeId.FURNANCE_IRON_NUGGET_1,
    inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
    outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
    facilityId: FacilityId.FURNANCE_1,
    craftingTime: 60,
  };

  async function planInputs(
    overrides: Partial<LayoutInputs>,
  ): Promise<LayoutInputs> {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 2.5 }],
      items,
      [recipe],
      [facility],
      { rawMaterials: new Set([ItemId.ITEM_IRON_ORE]) },
    );
    return mkInputs({ plan, items, recipes: [recipe], facilities: [facility], ...overrides });
  }

  test("separated mode emits per-building instances and ignores binFusion", async () => {
    const base = await planInputs({ visualizationMode: "separated" });
    const bf1 = await computeFlowLayout({ ...base, binFusion: true }, "interactive");
    const bf0 = await computeFlowLayout({ ...base, binFusion: false }, "interactive");
    const ids1 = bf1.nodes.map((n) => n.id).sort();
    const ids0 = bf0.nodes.map((n) => n.id).sort();
    expect(ids1).toEqual(ids0);
    expect(ids1.some((id) => /-bldg\d+$/.test(id))).toBe(true);
  });

  test("merged mode emits no per-building instances (both bf settings)", async () => {
    const base = await planInputs({ visualizationMode: "merged" });
    for (const binFusion of [true, false]) {
      const { nodes } = await computeFlowLayout({ ...base, binFusion }, "interactive");
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.some((n) => /-bldg\d+$/.test(n.id))).toBe(false);
    }
  });
});
