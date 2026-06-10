import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";

/** Opacity applied to edges (path + label) outside the spotlight. */
export const EDGE_DIM_OPACITY = 0.08;

/**
 * Custom bezier edge that renders labels as HTML to support multi-line text across all browsers.
 * Standard SVG text doesn't support white-space CSS properties in Chrome.
 *
 * Spotlight dimming is applied here (via `data.dimmed`) rather than a CSS
 * class on the edge group: the label renders in `EdgeLabelRenderer`'s
 * separate HTML layer, which a class on the SVG group cannot reach.
 * Path opacity also covers the arrowhead marker (SVG renders markers as
 * part of the path's group).
 */
export default function CustomBezierEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const dimmed = Boolean((data as { dimmed?: boolean } | undefined)?.dimmed);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          // Internal edges carry their own opacity (0.7); preserve it
          // when not dimmed instead of clobbering with undefined.
          opacity: dimmed ? EDGE_DIM_OPACITY : style.opacity,
          transition: "opacity 0.15s ease",
        }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 12,
              pointerEvents: dimmed ? "none" : "all",
              opacity: dimmed ? EDGE_DIM_OPACITY : 1,
              transition: "opacity 0.15s ease",
              ...labelStyle,
            }}
            className="nodrag nopan"
          >
            <div
              style={{
                background: labelBgStyle?.fill || "var(--card)",
                opacity: labelBgStyle?.fillOpacity || 0.9,
                padding: `${labelBgPadding?.[1] || 4}px ${labelBgPadding?.[0] || 8}px`,
                borderRadius: labelBgBorderRadius || 4,
                whiteSpace: "pre-line",
                textAlign: "center",
                ...labelBgStyle,
              }}
            >
              {label}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
