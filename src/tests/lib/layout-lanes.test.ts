/**
 * ELK layout-lane semantics (`src/lib/layout.ts`): per-lane engines,
 * `cancelLayoutLane` → `LayoutCancelledError`, and — critically — that
 * cancellation NEVER throws on the bundled main-thread fallback engine
 * (vitest runs on it: elkjs' fake worker has `postMessage` but no
 * `terminate`, so an unguarded `terminateWorker()` call is a TypeError
 * that would escape into caller effects).
 */
import { describe, test, expect } from "vitest";
import type { Node, Edge } from "@xyflow/react";
import {
  getLayoutedElements,
  cancelLayoutLane,
  LayoutCancelledError,
} from "@/lib/layout";

function mkNodes(count: number): Node[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    position: { x: 0, y: 0 },
    data: {},
  }));
}

function mkChainEdges(count: number): Edge[] {
  return Array.from({ length: count - 1 }, (_, i) => ({
    id: `e${i}`,
    source: `n${i}`,
    target: `n${i + 1}`,
  }));
}

describe("layout lanes", () => {
  test("lays out nodes with real positions (bundled fallback engine)", async () => {
    const { nodes } = await getLayoutedElements(
      mkNodes(4),
      mkChainEdges(4),
      "RIGHT",
      false,
      "interactive",
    );
    expect(nodes).toHaveLength(4);
    // A left-to-right chain must spread horizontally.
    const xs = nodes.map((n) => n.position.x);
    expect(new Set(xs).size).toBeGreaterThan(1);
  });

  test("cancelLayoutLane on a lane with a live engine does not throw (fake-worker terminate)", async () => {
    // Materialise the prefetch lane's engine first — the throw-path is
    // `engine.terminateWorker()` on the bundled fallback.
    await getLayoutedElements(mkNodes(2), mkChainEdges(2), "RIGHT", false, "prefetch");
    expect(() => cancelLayoutLane("prefetch")).not.toThrow();
    // And on an idle (engine-less) lane right after.
    expect(() => cancelLayoutLane("prefetch")).not.toThrow();
  });

  test("cancelLayoutLane mid-job rejects that job with LayoutCancelledError", async () => {
    const pending = getLayoutedElements(
      mkNodes(30),
      mkChainEdges(30),
      "RIGHT",
      false,
      "prefetch",
    );
    cancelLayoutLane("prefetch");
    await expect(pending).rejects.toBeInstanceOf(LayoutCancelledError);
  });

  test("lane is usable again after cancellation (lazy re-create)", async () => {
    const { nodes } = await getLayoutedElements(
      mkNodes(3),
      mkChainEdges(3),
      "RIGHT",
      false,
      "prefetch",
    );
    expect(nodes).toHaveLength(3);
  });

  test("cancelling the prefetch lane leaves an interactive job untouched", async () => {
    const interactive = getLayoutedElements(
      mkNodes(5),
      mkChainEdges(5),
      "RIGHT",
      false,
      "interactive",
    );
    cancelLayoutLane("prefetch");
    const { nodes } = await interactive;
    expect(nodes).toHaveLength(5);
  });
});
