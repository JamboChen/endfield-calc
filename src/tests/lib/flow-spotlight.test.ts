import { describe, test, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import {
  getNeighborhood,
  getPinnedSpotlight,
  mergeSpotlights,
} from "@/lib/flow-spotlight";
import { getItemEdgeColor } from "@/components/flow/flow-utils";
import { itemIconColors } from "@/data/item-colors";
import { items } from "@/data";

/**
 * Synthetic graph:
 *
 *   A ──e1──▶ B ──e2──▶ C ──e3──▶ D ──e6──▶ E
 *   X ──e4──────▶ B     C ──e5──▶ Y
 *
 * A and X both feed B; C fans out to D and Y; D feeds E (two hops
 * downstream of C — distinguishes "direct consumers" from the old
 * transitive-downstream chain).
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
  edge("e6", "D", "E"),
];

describe("getNeighborhood", () => {
  test("returns the node, incident edges, and far-end nodes only", () => {
    const { nodeIds, edgeIds, consumerNodeIds } = getNeighborhood(EDGES, "B");
    expect([...nodeIds].sort()).toEqual(["A", "B", "C", "X"]);
    expect([...edgeIds].sort()).toEqual(["e1", "e2", "e4"]);
    // Hover neighborhoods never mark consumers.
    expect(consumerNodeIds.size).toBe(0);
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

describe("getPinnedSpotlight", () => {
  test("mid-chain pin: upstream cone + direct consumers, nothing beyond", () => {
    const { nodeIds, edgeIds, consumerNodeIds } = getPinnedSpotlight(EDGES, ["C"]);
    // Upstream of C: B, A, X. Direct consumers: D and Y. E (consumer of
    // a consumer) must stay dimmed — the old transitive chain lit it.
    expect([...nodeIds].sort()).toEqual(["A", "B", "C", "D", "X", "Y"]);
    expect([...edgeIds].sort()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(nodeIds.has("E")).toBe(false);
    expect(edgeIds.has("e6")).toBe(false);
    // Consumers marked; upstream cone is NOT.
    expect([...consumerNodeIds].sort()).toEqual(["D", "Y"]);
  });

  test("early-chain pin: consumers' consumers stay dimmed", () => {
    const { nodeIds, edgeIds, consumerNodeIds } = getPinnedSpotlight(EDGES, ["B"]);
    // Upstream: A, X. Direct consumer: C. D/E/Y are beyond one hop.
    expect([...nodeIds].sort()).toEqual(["A", "B", "C", "X"]);
    expect([...edgeIds].sort()).toEqual(["e1", "e2", "e4"]);
    expect([...consumerNodeIds]).toEqual(["C"]);
  });

  test("terminal pin (target-sink case): full upstream cone, no consumers", () => {
    const { nodeIds, edgeIds, consumerNodeIds } = getPinnedSpotlight(EDGES, ["E"]);
    // Everything needed to produce E lights up; Y/e5 are not on any
    // path to E.
    expect([...nodeIds].sort()).toEqual(["A", "B", "C", "D", "E", "X"]);
    expect([...edgeIds].sort()).toEqual(["e1", "e2", "e3", "e4", "e6"]);
    expect(consumerNodeIds.size).toBe(0);
  });

  test("source pin: no upstream, direct consumers only", () => {
    const { nodeIds, edgeIds, consumerNodeIds } = getPinnedSpotlight(EDGES, ["X"]);
    expect([...nodeIds].sort()).toEqual(["B", "X"]);
    expect([...edgeIds].sort()).toEqual(["e4"]);
    expect([...consumerNodeIds]).toEqual(["B"]);
  });

  test("multi-seed union", () => {
    const { nodeIds, edgeIds, consumerNodeIds } = getPinnedSpotlight(EDGES, ["X", "D"]);
    // X: consumer B. D: upstream C/B/A/X + consumer E.
    expect([...nodeIds].sort()).toEqual(["A", "B", "C", "D", "E", "X"]);
    expect([...edgeIds].sort()).toEqual(["e1", "e2", "e3", "e4", "e6"]);
    expect([...consumerNodeIds].sort()).toEqual(["B", "E"]);
  });

  test("terminates on cycles; seeds never marked as consumers", () => {
    const cyclic: Edge[] = [
      edge("c1", "P", "Q"),
      edge("c2", "Q", "P"), // backward edge: cycle
      edge("c3", "Q", "R"),
    ];
    const { nodeIds, edgeIds, consumerNodeIds } = getPinnedSpotlight(cyclic, ["Q"]);
    // Upstream of Q: P (via c1), whose supplier is Q again (cycle, via
    // c2). Direct consumers: P (c2) and R (c3).
    expect([...nodeIds].sort()).toEqual(["P", "Q", "R"]);
    expect([...edgeIds].sort()).toEqual(["c1", "c2", "c3"]);
    expect([...consumerNodeIds].sort()).toEqual(["P", "R"]);

    // Pin BOTH cycle members: each consumes the other, but seeds keep
    // their neutral pin ring — consumer set must exclude them.
    const both = getPinnedSpotlight(cyclic, ["P", "Q"]);
    expect([...both.consumerNodeIds]).toEqual(["R"]);
  });

  test("no seeds yields empty sets", () => {
    const { nodeIds, edgeIds, consumerNodeIds } = getPinnedSpotlight(EDGES, []);
    expect(nodeIds.size).toBe(0);
    expect(edgeIds.size).toBe(0);
    expect(consumerNodeIds.size).toBe(0);
  });
});

describe("mergeSpotlights", () => {
  test("unions nodes, edges, and consumer marks of pin and hover", () => {
    const pinned = getPinnedSpotlight(EDGES, ["B"]);
    const hovered = getNeighborhood(EDGES, "D");
    const merged = mergeSpotlights(pinned, hovered);
    // Pin(B): A, B, C, X / e1, e2, e4. Hover(D): C, D, E / e3, e6.
    expect([...merged.nodeIds].sort()).toEqual(["A", "B", "C", "D", "E", "X"]);
    expect([...merged.edgeIds].sort()).toEqual(["e1", "e2", "e3", "e4", "e6"]);
    // The pin's consumer mark survives the hover union.
    expect([...merged.consumerNodeIds]).toEqual(["C"]);
    // Inputs unchanged (no mutation).
    expect(pinned.nodeIds.has("E")).toBe(false);
    expect(hovered.nodeIds.has("A")).toBe(false);
  });
});

describe("getItemEdgeColor", () => {
  test("icon-mapped item: theme-var oklch with per-item chroma factor and hue", () => {
    const color = getItemEdgeColor("item_xiranite_powder");
    const entry = itemIconColors["item_xiranite_powder"];
    expect(entry).toBeDefined();
    expect(color).toBe(
      `oklch(var(--flow-edge-l) calc(var(--flow-edge-c) * ${entry.c}) ${entry.h})`,
    );
    // Deterministic across calls.
    expect(getItemEdgeColor("item_xiranite_powder")).toBe(color);
  });

  test("unmapped item: hash fallback with full theme chroma", () => {
    const color = getItemEdgeColor("item_not_a_real_item_zzz");
    expect(color).toMatch(
      /^oklch\(var\(--flow-edge-l\) var\(--flow-edge-c\) \d{1,3}\)$/,
    );
    const hue = Number(color.match(/(\d+)\)$/)?.[1]);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  test("missing id falls back to muted foreground", () => {
    expect(getItemEdgeColor(undefined)).toBe("var(--muted-foreground)");
  });
});

describe("itemIconColors (generated by extract:item-colors)", () => {
  test("covers every item that ships an icon", () => {
    // Every real item id should be colourable from its icon; the only
    // expected miss is the synthetic __multi_target__ pseudo-item.
    const missing = items
      .map((i) => i.id as string)
      .filter((id) => !id.startsWith("__") && !itemIconColors[id]);
    expect(missing).toEqual([]);
  });

  test("hue and chroma factor stay in range", () => {
    const entries = Object.values(itemIconColors);
    expect(entries.length).toBeGreaterThan(100);
    for (const { h, c } of entries) {
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(c).toBeGreaterThanOrEqual(0.25);
      expect(c).toBeLessThanOrEqual(1.25);
    }
  });

  test("no two entries look the same (hue within 2° AND chroma within 0.08)", () => {
    const entries = Object.entries(itemIconColors);
    const collisions: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [idA, a] = entries[i];
        const [idB, b] = entries[j];
        const dh = Math.abs(a.h - b.h);
        const hueDist = Math.min(dh, 360 - dh);
        if (hueDist < 2 && Math.abs(a.c - b.c) < 0.08) {
          collisions.push(`${idA} vs ${idB}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  test("semantic anchors: copper is warm, sewage is muted", () => {
    // Coarse sanity that extraction reads icons, not noise. Copper ore's
    // icon is orange (warm hue, high chroma); sewage's is murky (low
    // chroma factor).
    const copper = itemIconColors["item_copper_ore"];
    expect(copper.h).toBeGreaterThanOrEqual(15);
    expect(copper.h).toBeLessThanOrEqual(90);
    expect(copper.c).toBeGreaterThan(0.5);
    const sewage = itemIconColors["item_liquid_sewage"];
    expect(sewage.c).toBeLessThanOrEqual(0.4);
  });
});
