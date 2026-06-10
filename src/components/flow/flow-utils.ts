import type {
  EdgeDirection,
  ProductionNode,
  Item,
  Facility,
  FlowProductionNode,
  FlowTargetNode,
  FlowDisposalNode,
} from "@/types";
import { MarkerType, type Edge, type Node, Position } from "@xyflow/react";
import { getTransportCount, getTransportCountWithFacilities, formatCount } from "@/lib/utils";
import { getTransportLabel, getInternalFlowLabel } from "@/lib/i18n-helpers";

/**
 * Creates a standardized edge for React Flow with optional pre-computed direction.
 *
 * @param id Unique edge identifier
 * @param source Source node ID
 * @param target Target node ID
 * @param flowRate Flow rate in items per minute
 * @param item The item being transported (used to determine belt vs pipe capacity and label)
 * @param direction Optional pre-computed direction (from markEdgeDirections)
 * @param ceilMode Whether to round up transport counts
 */
export function createEdge(
  id: string,
  source: string,
  target: string,
  flowRate: number,
  item?: Item,
  direction?: EdgeDirection,
  ceilMode = false,
  sourceFacilityCount?: number,
): Edge {
  const throughputCount = getTransportCount(flowRate, item, ceilMode);
  const throughputStr = formatCount(throughputCount, ceilMode);
  const transportLabel = getTransportLabel(item);

  // Show merged notation (e.g., "2→1 pipes") when source facilities need
  // more connections than the throughput requires
  let transportStr: string;
  if (sourceFacilityCount !== undefined) {
    const facilityCount = getTransportCountWithFacilities(
      flowRate, item, ceilMode, sourceFacilityCount,
    );
    if (facilityCount > throughputCount && ceilMode) {
      transportStr = `${formatCount(facilityCount, ceilMode)}→${throughputStr} ${transportLabel}`;
    } else {
      transportStr = `${throughputStr} ${transportLabel}`;
    }
  } else {
    transportStr = `${throughputStr} ${transportLabel}`;
  }

  // Internal flows (co-located in same multi-formula building) skip the
  // transport label entirely — there's no pipe/belt to count.
  const labelTransport =
    direction === "internal" ? getInternalFlowLabel() : transportStr;

  return {
    id,
    source,
    target,
    sourceHandle: item?.id,
    type: direction === "backward" ? "backwardEdge" : "simplebezier",
    label: `${flowRate.toFixed(2)} /min\n${labelTransport}`,
    data: {
      flowRate,
      direction,
      itemId: item?.id,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#64748b",
    },
  };
}

/**
 * Stable per-item edge colour: hashes the item id to an OKLCH hue. The
 * lightness/chroma live in theme CSS variables (`--flow-edge-l` /
 * `--flow-edge-c`, see index.css) so the same hue stays legible on both
 * the light and dark canvas without recomputing edges on theme switch.
 *
 * Items without an id (defensive) fall back to the muted foreground.
 */
export function getItemEdgeColor(itemId?: string): string {
  if (!itemId) return "var(--muted-foreground)";
  // djb2 string hash — deterministic across sessions.
  let hash = 5381;
  for (let i = 0; i < itemId.length; i++) {
    hash = ((hash << 5) + hash + itemId.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `oklch(var(--flow-edge-l) var(--flow-edge-c) ${hue})`;
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
    const data = edge.data as
      | { flowRate?: number; direction?: EdgeDirection; itemId?: string }
      | undefined;

    if (!data || typeof data.flowRate !== "number") {
      return edge;
    }

    const flowRate = data.flowRate;
    const normalizedRate = flowRate / maxFlowRate;

    // Calculate stroke width based on flow rate (1-4 range)
    const strokeWidth = 1 + normalizedRate * 3;

    // Colour encodes the transported item (stable hue per item id) so a
    // material can be traced across the canvas. Rate remains encoded via
    // stroke width, animation speed, and the label.
    const strokeColor = getItemEdgeColor(data.itemId);

    // Calculate animation speed based on flow rate
    // Higher rate = faster animation (shorter duration)
    const minDuration = 1.5;
    const maxDuration = 10;
    const animationDuration =
      maxDuration * Math.pow(1 - normalizedRate, 1.5) +
      minDuration * Math.pow(normalizedRate, 0.5);

    // Internal flows (producer & consumer co-located in the same
    // multi-formula building) get a distinct visual: dashed stroke and
    // muted color, no animation. Internal flows traverse no transport,
    // so the user shouldn't read them as belt/pipe lines.
    const isInternal = data.direction === "internal";

    if (isInternal) {
      return {
        ...edge,
        type: "simplebezier",
        animated: false,
        style: {
          strokeWidth: 1.5,
          stroke: "var(--muted-foreground)",
          strokeDasharray: "4 3",
          opacity: 0.7,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "var(--muted-foreground)",
          width: 16,
          height: 16,
        },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
        labelBgStyle: {
          fill: "var(--card)",
          fillOpacity: 0.9,
        },
        labelStyle: {
          fontSize: 11,
          fill: "var(--muted-foreground)",
          color: "var(--muted-foreground)",
          fontStyle: "italic",
        },
      };
    }

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
 * Helper: Creates production flow node.
 * Shared between separated and merged mappers to ensure visual consistency.
 */
export function createProductionFlowNode(
  nodeId: string,
  node: ProductionNode,
  items: Item[],
  facilities: Facility[],
  ceilMode: boolean,
  options: {
    facilityIndex?: number;
    totalFacilities?: number;
    isPartialLoad?: boolean;
    isDirectTarget?: boolean;
    directTargetRate?: number;
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
      ceilMode,
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

/**
 * Creates a disposal sink flow node for consuming waste byproducts.
 */
export function createDisposalSinkNode(
  nodeId: string,
  item: Item,
  disposalRate: number,
  facility: Facility,
  facilityCount: number,
  items: Item[],
  facilities: Facility[],
  ceilMode = false,
): FlowDisposalNode {
  return {
    id: nodeId,
    type: "disposalSink",
    data: {
      item,
      disposalRate,
      facility,
      facilityCount,
      items,
      facilities,
      ceilMode,
    },
    position: { x: 0, y: 0 },
    targetPosition: Position.Left,
  };
}
