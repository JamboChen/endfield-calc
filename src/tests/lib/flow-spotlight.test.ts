import { describe, test, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import { getNeighborhood, getChain } from "@/lib/flow-spotlight";
import { getItemEdgeColor } from "@/components/flow/flow-utils";

/**
 * Synthetic graph:
 *
 *   A ──e1──▶ B ──e2──▶ C ──e3──▶ D
 *   X ──e4──────▶ B     C ──e5──▶ Y
 *
 * A and X both feed B; C fans out to D and Y.
 */
const edge = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
});

const EDGES: Edge[] = [
  edge("e1", "A", "B"),
  edge("e2", "B", "C"),
  edge("e3", "C", "D"),
  edge("e4", "X", "B"),
  edge("e5", "C", "Y"),
];

describe("getNeighborhood", () => {
  test("returns the node, incident edges, and far-end nodes only", () => {
    const { nodeIds, edgeIds } = getNeighborhood(EDGES, "B");
    expect([...nodeIds].sort()).toEqual(["A", "B", "C", "X"]);
    expect([...edgeIds].sort()).toEqual(["e1", "e2", "e4"]);
  });

  test("fan-out node includes consumers and supplier", () => {
    const { nodeIds, edgeIds } = getNeighborhood(EDGES, "C");
    expect([...nodeIds].sort()).toEqual(["B", "C", "D", "Y"]);
    expect([...edgeIds].sort()).toEqual(["e2", "e3", "e5"]);
  });

  test("isolated node spotlights only itself", () => {
    const { nodeIds, edgeIds } = getNeighborhood(EDGES, "Z");
    expect([...nodeIds]).toEqual(["Z"]);
    expect(edgeIds.size).toBe(0);
  });
});

describe("getChain", () => {
  test("terminal node: full upstream cone, no unrelated branches", () => {
    const { nodeIds, edgeIds } = getChain(EDGES, ["D"]);
    // Upstream of D: C, B, A, X. Y and e5 are NOT on any path to D.
    expect([...nodeIds].sort()).toEqual(["A", "B", "C", "D", "X"]);
    expect([...edgeIds].sort()).toEqual(["e1", "e2", "e3", "e4"]);
  });

  test("mid-chain node: union of upstream and downstream", () => {
    const { nodeIds, edgeIds } = getChain(EDGES, ["C"]);
    expect([...nodeIds].sort()).toEqual(["A", "B", "C", "D", "X", "Y"]);
    expect([...edgeIds].sort()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  test("source node: downstream only", () => {
    const { nodeIds, edgeIds } = getChain(EDGES, ["X"]);
    // Downstream of X: B, C, D, Y. Upstream of B (A, e1) joins because
    // the chain includes B's full downstream, not B's other suppliers…
    // — it must NOT: A supplies B but is not reachable from X in either
    // direction starting at X.
    expect(nodeIds.has("A")).toBe(false);
    expect(edgeIds.has("e1")).toBe(false);
    expect([...nodeIds].sort()).toEqual(["B", "C", "D", "X", "Y"]);
    expect([...edgeIds].sort()).toEqual(["e2", "e3", "e4", "e5"]);
  });

  test("multi-seed union", () => {
    const { nodeIds, edgeIds } = getChain(EDGES, ["X", "A"]);
    expect([...nodeIds].sort()).toEqual(["A", "B", "C", "D", "X", "Y"]);
    expect([...edgeIds].sort()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  test("terminates on cycles (backward edges form SCCs)", () => {
    const cyclic: Edge[] = [
      edge("c1", "P", "Q"),
      edge("c2", "Q", "P"), // backward edge: cycle
      edge("c3", "Q", "R"),
    ];
    const { nodeIds, edgeIds } = getChain(cyclic, ["P"]);
    expect([...nodeIds].sort()).toEqual(["P", "Q", "R"]);
    expect([...edgeIds].sort()).toEqual(["c1", "c2", "c3"]);
  });

  test("no seeds yields empty sets", () => {
    const { nodeIds, edgeIds } = getChain(EDGES, []);
    expect(nodeIds.size).toBe(0);
    expect(edgeIds.size).toBe(0);
  });
});

describe("getItemEdgeColor", () => {
  test("deterministic oklch string with theme-var lightness/chroma", () => {
    const color = getItemEdgeColor("item_xiranite_powder");
    expect(color).toMatch(
      /^oklch\(var\(--flow-edge-l\) var\(--flow-edge-c\) \d{1,3}\)$/,
    );
    expect(getItemEdgeColor("item_xiranite_powder")).toBe(color);
  });

  test("hue stays in [0, 360)", () => {
    for (const id of ["item_water", "item_iron_ore", "a", "", "item_xiranite_poly"]) {
      const color = getItemEdgeColor(id || undefined);
      if (!id) {
        expect(color).toBe("var(--muted-foreground)");
        continue;
      }
      const hue = Number(color.match(/(\d+)\)$/)?.[1]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  test("distinct items that co-occur in plans get distinct hues", () => {
    // Items frequently adjacent in the same view should not collide.
    const pairs: [string, string][] = [
      ["item_xiranite_powder", "item_xiranite_enr_powder"],
      ["item_water", "item_liquid_sewage"],
      ["item_copper_nugget", "item_iron_nugget"],
    ];
    for (const [a, b] of pairs) {
      expect(getItemEdgeColor(a)).not.toBe(getItemEdgeColor(b));
    }
  });
});
