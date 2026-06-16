/**
 * Viewport math for "click an edge → bring its whole extent into view".
 * Pure functions — testable without React Flow.
 */

export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportLike {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Backward edges arc around their source node (see CustomBackwardEdge,
 * which imports these so the geometry can't drift): the curve bulges up
 * to BACKWARD_ARC_VERTICAL px above/below the endpoints and
 * BACKWARD_ARC_HORIZONTAL px beyond them horizontally.
 */
export const BACKWARD_ARC_VERTICAL = 180;
export const BACKWARD_ARC_HORIZONTAL = 120;

/** App-wide ReactFlow minZoom (mirrors ProductionDependencyTree). */
const MIN_ZOOM = 0.1;

/**
 * Bounding box (flow coordinates) of an edge: the union of its endpoint
 * node rects, expanded by the arc allowance for backward edges.
 */
export function edgeBounds(
  source: FlowRect,
  target: FlowRect,
  isBackward: boolean,
): FlowRect {
  let minX = Math.min(source.x, target.x);
  let minY = Math.min(source.y, target.y);
  let maxX = Math.max(source.x + source.width, target.x + target.width);
  let maxY = Math.max(source.y + source.height, target.y + target.height);

  if (isBackward) {
    minX -= BACKWARD_ARC_HORIZONTAL;
    maxX += BACKWARD_ARC_HORIZONTAL;
    minY -= BACKWARD_ARC_VERTICAL;
    maxY += BACKWARD_ARC_VERTICAL;
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Camera move that brings `bounds` fully into view — or `null` when the
 * bounds are already fully visible (the camera must not move then).
 *
 * The returned zoom is CAPPED at the current zoom: this only ever zooms
 * OUT (or pans); clicking an edge never zooms in. Padding is screen
 * pixels kept free around the bounds after the move.
 *
 * @returns `{ centerX, centerY, zoom }` for `setCenter`, or `null`.
 */
export function computeEdgeFitView(
  bounds: FlowRect,
  viewport: ViewportLike,
  pane: { width: number; height: number },
  padding = 40,
): { centerX: number; centerY: number; zoom: number } | null {
  // Screen-space extent under the current viewport.
  const screenX = bounds.x * viewport.zoom + viewport.x;
  const screenY = bounds.y * viewport.zoom + viewport.y;
  const screenW = bounds.width * viewport.zoom;
  const screenH = bounds.height * viewport.zoom;

  const TOLERANCE = 2; // px — treat hairline overflow as visible
  const fullyVisible =
    screenX >= -TOLERANCE &&
    screenY >= -TOLERANCE &&
    screenX + screenW <= pane.width + TOLERANCE &&
    screenY + screenH <= pane.height + TOLERANCE;
  if (fullyVisible) return null;

  // Zoom that fits the bounds with padding; never above current zoom,
  // never below the app's minZoom.
  const fitZoom = Math.min(
    (pane.width - 2 * padding) / bounds.width,
    (pane.height - 2 * padding) / bounds.height,
  );
  const zoom = Math.max(MIN_ZOOM, Math.min(viewport.zoom, fitZoom));

  return {
    centerX: bounds.x + bounds.width / 2,
    centerY: bounds.y + bounds.height / 2,
    zoom,
  };
}
