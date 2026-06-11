import type { CSSProperties } from "react";

/** Opacity applied to edges (path + label) outside the spotlight. */
const EDGE_DIM_OPACITY = 0.08;
/** Stroke-width bump for the hovered (emphasized) edge. */
const EDGE_EMPHASIS_EXTRA_WIDTH = 2;

/** Spotlight/hover flags threaded through edge `data` by the tree. */
interface EdgeSpotlightData {
  dimmed?: boolean;
  /** Edge is inside an active spotlight — its label survives low-zoom fading. */
  lit?: boolean;
  /** Edge is hovered — thicker stroke, label forced visible, un-dimmed. */
  emphasis?: boolean;
}

/**
 * Shared per-edge presentation derived from the spotlight/hover flags.
 * Used by both the bezier and backward edge components. Lives outside
 * the component files so fast-refresh keeps working there.
 */
export function edgePresentation(
  data: unknown,
  style: CSSProperties,
): {
  pathStyle: CSSProperties;
  labelOpacity: number;
  labelPointerEvents: "all" | "none";
  labelClassName: string;
} {
  const flags = (data ?? {}) as EdgeSpotlightData;
  const emphasis = Boolean(flags.emphasis);
  const dimmed = Boolean(flags.dimmed) && !emphasis; // hover un-dims
  const baseWidth =
    typeof style.strokeWidth === "number" ? style.strokeWidth : 1.5;

  return {
    pathStyle: {
      ...style,
      strokeWidth: emphasis ? baseWidth + EDGE_EMPHASIS_EXTRA_WIDTH : baseWidth,
      // Internal edges carry their own opacity (0.7); preserve it when
      // not dimmed instead of clobbering with undefined.
      opacity: dimmed ? EDGE_DIM_OPACITY : style.opacity,
      // Perf: dimmed edges stop their dash animation (invisible motion is
      // pure compositing cost); the hovered edge forces "running", which
      // also overrides the low-zoom pause in index.css (inline beats the
      // class rule). Everything else leaves the CSS in control.
      animationPlayState: dimmed ? "paused" : emphasis ? "running" : undefined,
      transition: "opacity 0.15s ease, stroke-width 0.15s ease",
    },
    labelOpacity: dimmed ? EDGE_DIM_OPACITY : 1,
    labelPointerEvents: dimmed ? "none" : "all",
    // `edge-label` participates in the low-zoom fade (index.css);
    // `edge-label-keep` exempts spotlit/hovered edges from it.
    labelClassName: `nodrag nopan edge-label${flags.lit || emphasis ? " edge-label-keep" : ""}`,
  };
}
