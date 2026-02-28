import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";

/**
 * Custom edge for backward connections (when target is to the left of source).
 * Creates a wide arc that goes around the source node to avoid overlap.
 */
export default function CustomBackwardEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style = {},
  markerEnd,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps) {
  // Calculate control points for a wide arc that goes up/down to avoid the source node
  // The arc should be large enough to clear the node (nodeHeight ~= 110px)
  const verticalOffset = 180; // How far up/down the arc goes
  const horizontalOffset = 120; // How far right the arc initially goes before curving back

  // Determine if we should arc upward or downward
  // If source is below target (sourceY > targetY), arc downward to go around
  // If source is above target (sourceY <= targetY), arc upward to go around
  const shouldArcUp = sourceY <= targetY;
  const offsetMultiplier = shouldArcUp ? -1 : 1;

  // Create control points for the bezier curve
  // Start from source, go right first, then curve up/down, then back to target
  const controlPoint1X = sourceX + horizontalOffset;
  const controlPoint1Y = sourceY + offsetMultiplier * verticalOffset;

  const controlPoint2X = targetX - horizontalOffset;
  const controlPoint2Y = targetY + offsetMultiplier * verticalOffset;

  // Build SVG path manually for more control
  const path = `
    M ${sourceX},${sourceY}
    C ${controlPoint1X},${controlPoint1Y}
      ${controlPoint2X},${controlPoint2Y}
      ${targetX},${targetY}
  `;

  // Calculate label position (midpoint of the arc)
  const t = 0.5;
  const labelX =
    Math.pow(1 - t, 3) * sourceX +
    3 * Math.pow(1 - t, 2) * t * controlPoint1X +
    3 * (1 - t) * Math.pow(t, 2) * controlPoint2X +
    Math.pow(t, 3) * targetX;
  const labelY =
    Math.pow(1 - t, 3) * sourceY +
    3 * Math.pow(1 - t, 2) * t * controlPoint1Y +
    3 * (1 - t) * Math.pow(t, 2) * controlPoint2Y +
    Math.pow(t, 3) * targetY;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
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
