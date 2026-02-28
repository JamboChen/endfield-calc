import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";

/**
 * Custom bezier edge that renders labels as HTML to support multi-line text across all browsers.
 * Standard SVG text doesn't support white-space CSS properties in Chrome.
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
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 12,
              pointerEvents: "all",
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
