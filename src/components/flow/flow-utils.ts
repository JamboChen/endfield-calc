import type {
  EdgeDirection,
  ProductionNode,
  Item,
  Facility,
  FlowProductionNode,
  FlowTargetNode,
} from "@/types";
import { MarkerType, type Edge, type Node, Position } from "@xyflow/react";
import { getBeltCount } from "@/lib/utils";

const formatNumber = (num: number, decimals = 2): string => {
  return num.toFixed(decimals);
};

/**
 * Aggregated production node data.
 * Combines multiple occurrences of the same production step.
 */
export type AggregatedProductionNodeData = {
  /** Representative ProductionNode (from first encounter) */
  node: ProductionNode;
  /** Total production rate across all branches */
  totalRate: number;
  /** Total facility count across all branches */
  totalFacilityCount: number;
};

/**
 * Creates a standardized edge for React Flow with optional pre-computed direction.
 *
 * @param id Unique edge identifier
 * @param source Source node ID
 * @param target Target node ID
 * @param flowRate Flow rate in items per minute
 * @param beltLabel Translated label for belts
 * @param direction Optional pre-computed direction (from markEdgeDirections)
 */
export function createEdge(
  id: string,
  source: string,
  target: string,
  flowRate: number,
  beltLabel: string,
  direction?: EdgeDirection,
  ceilMode = false,
): Edge {
  const beltCount = getBeltCount(flowRate, ceilMode);
  const beltStr = ceilMode ? beltCount.toFixed(0) : formatNumber(beltCount, 1);
  return {
    id,
    source,
    target,
    type: direction === "backward" ? "backwardEdge" : "simplebezier",
    label: `${flowRate.toFixed(2)} /min\n${beltStr} ${beltLabel}`,
    data: {
      flowRate,
      direction,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#64748b",
    },
  };
}

/**
 * Applies dynamic styling to edges based on flow rate and detects backward edges
 * based on actual node positions (when source X > target X).
 *
 * @param edges Array of edges to style
 * @param nodes Array of nodes with positions (after layout)
 * @returns The styled edges array with backward edges using backwardEdge type
 */
export function applyEdgeStyling(edges: Edge[], nodes: Node[]): Edge[] {
  if (edges.length === 0) return edges;

  // Build a position lookup map for O(1) access
  const nodePositions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node) => {
    if (node.position) {
      nodePositions.set(node.id, node.position);
    }
  });

  // Find max flow rate for normalization
  const flowRates: number[] = [];
  edges.forEach((e) => {
    const data = e.data as { flowRate?: number } | undefined;
    if (data?.flowRate !== undefined) {
      flowRates.push(data.flowRate);
    }
  });
  const maxFlowRate = Math.max(...flowRates, 1);

  return edges.map((edge) => {
    const data = edge.data as { flowRate?: number } | undefined;

    if (!data || typeof data.flowRate !== "number") {
      return edge;
    }

    const flowRate = data.flowRate;
    const normalizedRate = flowRate / maxFlowRate;

    // Calculate stroke width based on flow rate (1-4 range)
    const strokeWidth = 1 + normalizedRate * 3;

    // Calculate color based on normalized flow rate
    const strokeColor = getFlowRateColor(normalizedRate);

    // Calculate animation speed based on flow rate
    // Higher rate = faster animation (shorter duration)
    const minDuration = 1.5;
    const maxDuration = 10;
    const animationDuration =
      maxDuration * Math.pow(1 - normalizedRate, 1.5) +
      minDuration * Math.pow(normalizedRate, 0.5);

    // Detect backward edge based on actual node positions
    // If source X > target X, it's a backward edge (goes right to left)
    const sourcePos = nodePositions.get(edge.source);
    const targetPos = nodePositions.get(edge.target);
    const isBackward = sourcePos && targetPos && sourcePos.x > targetPos.x;

    return {
      ...edge,
      type: isBackward ? "backwardEdge" : "simplebezier",
      animated: true,
      style: {
        strokeWidth,
        stroke: strokeColor,
        strokeLinecap: "round" as const,
        animationDuration: `${animationDuration.toFixed(2)}s`,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: strokeColor,
        width: 20,
        height: 20,
      },
      labelBgPadding: [8, 4] as [number, number],
      labelBgBorderRadius: 4,
      labelBgStyle: {
        fill: "var(--card)",
        fillOpacity: 0.9,
      },
      labelStyle: {
        fontSize: 12,
        fill: "var(--foreground)",
        color: "var(--foreground)",
      },
    };
  });
}

/**
 * Interpolates between two RGB colors based on a factor (0-1).
 */
function interpolateColor(
  color1: string,
  color2: string,
  factor: number,
): string {
  const hex1 = color1.replace("#", "");
  const hex2 = color2.replace("#", "");

  const r1 = parseInt(hex1.substring(0, 2), 16);
  const g1 = parseInt(hex1.substring(2, 4), 16);
  const b1 = parseInt(hex1.substring(4, 6), 16);

  const r2 = parseInt(hex2.substring(0, 2), 16);
  const g2 = parseInt(hex2.substring(2, 4), 16);
  const b2 = parseInt(hex2.substring(4, 6), 16);

  const r = Math.round(r1 + (r2 - r1) * factor);
  const g = Math.round(g1 + (g2 - g1) * factor);
  const b = Math.round(b1 + (b2 - b1) * factor);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Maps a normalized flow rate (0-1) to a color on the heat map gradient.
 * 0.0 → Blue (cold, low flow)
 * 0.5 → Green (medium flow)
 * 1.0 → Red (hot, high flow)
 */
function getFlowRateColor(normalizedRate: number): string {
  const blue = "#3b82f6";
  const green = "#10b981";
  const red = "#ef4444";

  if (normalizedRate <= 0.5) {
    // Interpolate between blue and green
    return interpolateColor(blue, green, normalizedRate * 2);
  } else {
    // Interpolate between green and red
    return interpolateColor(green, red, (normalizedRate - 0.5) * 2);
  }
}

/**
 * Helper: Creates production flow node.
 * Shared between separated and merged mappers to ensure visual consistency.
 */
export function createProductionFlowNode(
  nodeId: string,
  node: ProductionNode,
  items: Item[],
  facilities: Facility[],
  options: {
    facilityIndex?: number;
    totalFacilities?: number;
    isPartialLoad?: boolean;
    isDirectTarget?: boolean;
    directTargetRate?: number;
    ceilMode?: boolean;
  } = {},
): FlowProductionNode {
  return {
    id: nodeId,
    type: "productionNode",
    data: {
      productionNode: node,
      items,
      facilities,
      facilityIndex: options.facilityIndex,
      totalFacilities: options.totalFacilities,
      isPartialLoad: options.isPartialLoad,
      isDirectTarget: options.isDirectTarget,
      directTargetRate: options.directTargetRate,
      ceilMode: options.ceilMode,
    },
    position: { x: 0, y: 0 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  };
}

/**
 * Helper: Creates target sink node.
 * Shared between separated and merged mappers.
 */
export function createTargetSinkNode(
  nodeId: string,
  item: Item,
  targetRate: number,
  items: Item[],
  facilities: Facility[],
  productionInfo?: {
    facility?: Facility | null;
    facilityCount: number;
    recipe?: ProductionNode["recipe"];
  },
  ceilMode = false,
): FlowTargetNode {
  return {
    id: nodeId,
    type: "targetSink",
    data: {
      item,
      targetRate,
      items,
      facilities,
      ceilMode,
      productionInfo: productionInfo
        ? {
            facility: productionInfo.facility ?? null,
            facilityCount: productionInfo.facilityCount,
            recipe: productionInfo.recipe ?? null,
          }
        : undefined,
    },
    position: { x: 0, y: 0 },
    targetPosition: Position.Left,
  };
}
