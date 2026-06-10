import { type Node, type Edge, Position } from "@xyflow/react";
import type { FlowProductionNode } from "@/types";

interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
}

interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  layoutOptions?: Record<string, string>;
}

interface ElkGraph {
  id: string;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  edges?: ElkEdge[];
}

type LayoutEngine = { layout: (graph: ElkGraph) => Promise<ElkNode> };

let elkInstance: LayoutEngine | null = null;
let elkPromise: Promise<LayoutEngine> | null = null;

/**
 * Creates the ELK engine, preferring a Web Worker so layout computation
 * never blocks the main thread (large Facility View plans can take ~1s).
 * Falls back to the main-thread bundled build where Workers are
 * unavailable (vitest/node) or worker construction fails.
 */
async function createLayoutEngine(): Promise<LayoutEngine> {
  if (typeof Worker !== "undefined") {
    try {
      const [{ default: ELK }, { default: ElkWorker }] = await Promise.all([
        import("elkjs/lib/elk-api.js"),
        import("elkjs/lib/elk-worker.min.js?worker"),
      ]);
      // elkjs' own typings return an awkward `Omit<any, ...>` from
      // `layout()`; bridge to our minimal structural type.
      return new ELK({
        workerFactory: () => new ElkWorker(),
      }) as unknown as LayoutEngine;
    } catch (error) {
      console.warn(
        "ELK worker initialisation failed; falling back to main thread:",
        error,
      );
    }
  }
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  return new ELK() as unknown as LayoutEngine;
}

const NODE_DIMENSIONS = {
  RAW_MATERIAL_NODE: { width: 208, height: 125 },
  PRODUCTION_NODE: { width: 208, height: 125 },
  PRODUCTION_NODE_PARTIAL: { width: 208, height: 157 },
  TARGET_NODE: { width: 208, height: 160 },
  DISPOSAL_NODE: { width: 208, height: 160 },
} as const;

/**
 * Initiates the loading of ELKJS.
 * This can be called early to preload the 1.4MB bundle in the background.
 */
export const preloadLayoutEngine = () => {
  if (!elkPromise) {
    elkPromise = createLayoutEngine();
  }
  return elkPromise;
};

// Start preloading immediately when this utility module is imported
preloadLayoutEngine();

/**
 * Determines the appropriate dimensions for a node based on its type and data.
 */
function getNodeDimensions(node: Node): { width: number; height: number } {
  if (node.type === "targetSink") {
    return NODE_DIMENSIONS.TARGET_NODE;
  }

  if (node.type === "disposalSink") {
    return NODE_DIMENSIONS.DISPOSAL_NODE;
  }

  if (node.type === "productionNode") {
    const prodNode = node as FlowProductionNode;

    // Check if it's a raw material node
    if (prodNode.data.productionNode.isRawMaterial) {
      const isPartialLoad =
        "isPartialLoad" in prodNode.data && prodNode.data.isPartialLoad;
      return isPartialLoad
        ? NODE_DIMENSIONS.PRODUCTION_NODE_PARTIAL
        : NODE_DIMENSIONS.RAW_MATERIAL_NODE;
    }

    // Check if it's separated mode with partial load
    const isPartialLoad =
      "isPartialLoad" in prodNode.data && prodNode.data.isPartialLoad;
    return isPartialLoad
      ? NODE_DIMENSIONS.PRODUCTION_NODE_PARTIAL
      : NODE_DIMENSIONS.PRODUCTION_NODE;
  }

  // Fallback
  return NODE_DIMENSIONS.PRODUCTION_NODE;
}

function isRawMaterialNode(node: Node): node is FlowProductionNode {
  return (
    node.type === "productionNode" &&
    (node as FlowProductionNode).data.productionNode.isRawMaterial
  );
}

const VERTICAL_GAP = 100;

/**
 * After x-alignment, some nodes that were in adjacent sub-layers
 * may now share the same x column and overlap vertically.
 * This pass sorts each column by y and redistributes nodes
 * so there is at least VERTICAL_GAP pixels between them.
 */
function resolveVerticalOverlaps(nodes: Node[]): Node[] {
  if (nodes.length <= 1) return nodes;

  const X_TOLERANCE = 2;
  const columns: Node[][] = [];

  for (const node of nodes) {
    const col = columns.find(
      (c) => Math.abs(c[0].position.x - node.position.x) <= X_TOLERANCE,
    );
    if (col) {
      col.push(node);
    } else {
      columns.push([node]);
    }
  }

  const adjustments = new Map<string, number>();

  for (const col of columns) {
    if (col.length <= 1) continue;

    col.sort((a, b) => a.position.y - b.position.y);

    let cursor = col[0].position.y;
    adjustments.set(col[0].id, cursor);

    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1];
      const prevHeight = getNodeDimensions(prev).height;
      const minY = cursor + prevHeight + VERTICAL_GAP;
      cursor = Math.max(col[i].position.y, minY);
      adjustments.set(col[i].id, cursor);
    }
  }

  if (adjustments.size === 0) return nodes;

  return nodes.map((node) => {
    const newY = adjustments.get(node.id);
    if (newY === undefined) return node;
    return { ...node, position: { ...node.position, y: newY } };
  });
}

function alignTwoEnds(nodes: Node[]): Node[] {
  if (nodes.length === 0) return nodes;

  const rawNodes = nodes.filter(isRawMaterialNode);
  const targetNodes = nodes.filter((node) => node.type === "targetSink");

  if (rawNodes.length === 0 && targetNodes.length === 0) {
    return nodes;
  }

  const leftX =
    rawNodes.length > 0
      ? Math.min(...rawNodes.map((node) => node.position.x))
      : undefined;

  const maxRight =
    targetNodes.length > 0
      ? Math.max(
          ...targetNodes.map((node) => {
            const dimensions = getNodeDimensions(node);
            return node.position.x + dimensions.width;
          }),
        )
      : undefined;

  return nodes.map((node) => {
    if (leftX !== undefined && isRawMaterialNode(node)) {
      return {
        ...node,
        position: {
          ...node.position,
          x: leftX,
        },
      };
    }

    if (maxRight !== undefined && node.type === "targetSink") {
      const dimensions = getNodeDimensions(node);
      return {
        ...node,
        position: {
          ...node.position,
          x: maxRight - dimensions.width,
        },
      };
    }

    return node;
  });
}

/**
 * Above this node count, the greedy-switch crossing-minimization phase is
 * left on ELK's automatic behaviour (deactivated for graphs > 40 nodes)
 * instead of being force-enabled. Greedy switch is roughly quadratic per
 * layer; at ~200 nodes (a large Facility View plan) it costs ~100ms and
 * cuts crossings by ~40%, but on pathological plans the cost would grow
 * unbounded. The layout runs in a Web Worker, so this gate bounds latency,
 * not jank.
 */
const GREEDY_SWITCH_MAX_NODES = 400;

/**
 * Lays out React Flow elements using the ELK algorithm.
 * ELK provides better handling of hierarchy and complex cycles than Dagre.
 * Uses static node dimensions for consistent and immediate layout.
 *
 * @param twoEndAlignment When true (separated mode only), forces raw material
 *   nodes to the leftmost layer and target sink nodes to the rightmost layer.
 */
export const getLayoutedElements = async (
  nodes: Node[],
  edges: Edge[],
  direction = "RIGHT",
  twoEndAlignment = false,
) => {
  // Ensure the engine is loaded
  if (!elkInstance) {
    elkInstance = await preloadLayoutEngine();
  }

  const isHorizontal = direction === "RIGHT" || direction === "LEFT";

  const elkGraph: ElkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.layered.spacing.nodeNodeBetweenLayers": "200",
      "elk.spacing.nodeNode":"100",
      "elk.edgeRouting": "SPLINES",
      "elk.layered.feedbackEdges": "true",
      "elk.layered.nodePlacement.favorStraightEdges": "0.2",
      "elk.layered.unnecessaryBendpoints": "true",
      // Crossing-minimization tuning (issue: unreadable large Facility
      // View graphs). React Flow ignores ELK's routed edge shapes — only
      // node placement survives — so layer-sweep quality is what decides
      // visible edge crossings. Measured on a 180-node Facility View
      // plan: 681 → 391 straight-line crossings, −26% total edge length,
      // +~70ms layout time.
      "elk.layered.thoroughness": "30",
      ...(nodes.length <= GREEDY_SWITCH_MAX_NODES
        ? {
            "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
            "elk.layered.crossingMinimization.greedySwitch.activationThreshold":
              "0",
          }
        : {}),
      "org.eclipse.elk.padding": "[top=40,left=40,bottom=40,right=40]",
    },
    children: nodes.map((node) => {
      const dimensions = getNodeDimensions(node);
      const elkNode: ElkNode = {
        id: node.id,
        width: dimensions.width,
        height: dimensions.height,
      };

      if (twoEndAlignment) {
        if (node.type === "productionNode") {
          const prodNode = node as FlowProductionNode;
          if (prodNode.data.productionNode.isRawMaterial) {
            elkNode.layoutOptions = {
              "org.eclipse.elk.layered.layeringConstraint": "FIRST_SEPARATE",
            };
          }
        } else if (node.type === "targetSink" || node.type === "disposalSink") {
          elkNode.layoutOptions = {
            "org.eclipse.elk.layered.layeringConstraint": "LAST_SEPARATE",
          };
        }
      }

      return elkNode;
    }),
    edges: edges.map((edge) => {
      const isBackward =
        edge.type === "backwardEdge" || edge.data?.direction === "backward";

      // `elk.layered.priority.direction` is an int with lower bound 0
      // (per https://www.eclipse.org/elk/reference/options/org-eclipse-elk-layered-priority-direction.html).
      // Higher values mean "more important to keep this edge pointing in
      // the layout direction" — i.e. less likely to be reversed during
      // cycle breaking. Backward edges get the lowest priority (0) so
      // ELK prefers to reverse them; forward edges get a high priority
      // (10) so ELK avoids reversing them. The previous value of `-10`
      // for backward edges was below the lower bound and silently
      // clamped to 0 — same effective behaviour, but now expressed
      // correctly.
      return {
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
        layoutOptions: {
          "elk.layered.priority.direction": isBackward ? "0" : "10",
        },
      };
    }),
  };

  try {
    const layoutedGraph = await elkInstance!.layout(elkGraph);

    const layoutedNodes = nodes.map((node) => {
      const elkNode = layoutedGraph.children?.find((n) => n.id === node.id);

      if (!elkNode) return node;

      const dimensions = getNodeDimensions(node);
      return {
        ...node,
        position: {
          x: elkNode.x ?? 0,
          y: elkNode.y ?? 0,
        },
        width: dimensions.width,
        height: dimensions.height,
        targetPosition: isHorizontal ? Position.Left : Position.Top,
        sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
      };
    });


    const finalNodes = twoEndAlignment
      ? resolveVerticalOverlaps(alignTwoEnds(layoutedNodes))
      : resolveVerticalOverlaps(layoutedNodes);

    return { nodes: finalNodes, edges };
  } catch (error) {
    console.error("ELK layout failed:", error);
    return { nodes, edges };
  }
};
