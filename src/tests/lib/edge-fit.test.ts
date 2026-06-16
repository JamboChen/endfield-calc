import { describe, test, expect } from "vitest";
import {
  edgeBounds,
  computeEdgeFitView,
  BACKWARD_ARC_VERTICAL,
  BACKWARD_ARC_HORIZONTAL,
} from "@/lib/edge-fit";

const NODE = { width: 208, height: 125 };
const PANE = { width: 1000, height: 800 };

describe("edgeBounds", () => {
  test("forward edge: union of endpoint rects", () => {
    const bounds = edgeBounds(
      { x: 0, y: 0, ...NODE },
      { x: 500, y: 300, ...NODE },
      false,
    );
    expect(bounds).toEqual({ x: 0, y: 0, width: 708, height: 425 });
  });

  test("backward edge: arc allowance expands the box", () => {
    const bounds = edgeBounds(
      { x: 0, y: 0, ...NODE },
      { x: 500, y: 0, ...NODE },
      true,
    );
    expect(bounds.x).toBe(-BACKWARD_ARC_HORIZONTAL);
    expect(bounds.y).toBe(-BACKWARD_ARC_VERTICAL);
    expect(bounds.width).toBe(708 + 2 * BACKWARD_ARC_HORIZONTAL);
    expect(bounds.height).toBe(125 + 2 * BACKWARD_ARC_VERTICAL);
  });
});

describe("computeEdgeFitView", () => {
  test("fully visible edge → null (camera must not move)", () => {
    // Bounds 0..708 x 0..425 at zoom 1 with no offset: inside 1000x800.
    const fit = computeEdgeFitView(
      { x: 0, y: 0, width: 708, height: 425 },
      { x: 50, y: 50, zoom: 1 },
      PANE,
    );
    expect(fit).toBeNull();
  });

  test("partially off-screen → pans without zooming when it fits at current zoom", () => {
    // Same bounds shifted far left of the viewport.
    const fit = computeEdgeFitView(
      { x: 0, y: 0, width: 708, height: 425 },
      { x: -600, y: 50, zoom: 1 },
      PANE,
    );
    expect(fit).not.toBeNull();
    // Fits inside the pane at zoom 1 → zoom stays (only a pan).
    expect(fit!.zoom).toBe(1);
    expect(fit!.centerX).toBeCloseTo(354);
    expect(fit!.centerY).toBeCloseTo(212.5);
  });

  test("edge larger than the viewport → zooms OUT to fit", () => {
    const fit = computeEdgeFitView(
      { x: 0, y: 0, width: 3000, height: 400 },
      { x: 0, y: 0, zoom: 1 },
      PANE,
    );
    expect(fit).not.toBeNull();
    expect(fit!.zoom).toBeLessThan(1);
    // (1000 - 80) / 3000
    expect(fit!.zoom).toBeCloseTo(920 / 3000, 5);
  });

  test("never zooms IN: small off-screen bounds keep the current zoom", () => {
    const fit = computeEdgeFitView(
      { x: 5000, y: 5000, width: 100, height: 50 },
      { x: 0, y: 0, zoom: 0.4 },
      PANE,
    );
    expect(fit).not.toBeNull();
    // fitZoom would be ~9.2 — must be capped at the current 0.4.
    expect(fit!.zoom).toBe(0.4);
  });

  test("zoom never drops below the app minimum", () => {
    const fit = computeEdgeFitView(
      { x: 0, y: 0, width: 100000, height: 100 },
      { x: 0, y: 0, zoom: 1 },
      PANE,
    );
    expect(fit!.zoom).toBe(0.1);
  });
});
