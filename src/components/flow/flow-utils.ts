import type {
  EdgeDirection,
  ProductionNode,
  Item,
  ItemId,
  Facility,
  FacilityId,
  Recipe,
  RecipeId,
  ProductionDependencyGraph,
  FlowProductionNode,
  FlowTargetNode,
  FlowDisposalNode,
  FlowPowerNode,
  FlowEnvNode,
  EnvCoverageEntry,
  EnvCoveredBuilding,
} from "@/types";
import { MarkerType, type Edge, type Node, Position } from "@xyflow/react";
import { getTransportCount, getTransportCountWithFacilities, formatCount } from "@/lib/utils";
import { getTransportLabel, getInternalFlowLabel } from "@/lib/i18n-helpers";
import { itemIconColors } from "@/data/item-colors";
import { facilitySustainDrains } from "@/data/gas-sustain";

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
    // Catalyst self-loops (producer feeds its own upkeep) land on the
    // dedicated top "catalyst" handle so they read as upkeep, not a
    // tangled side loop.
    targetHandle: direction === "self" ? "catalyst" : undefined,
    type: direction === "backward" ? "backwardEdge" : "simplebezier",
    label: `${flowRate.toFixed(2)} /min\n${labelTransport}`,
    // Non-selecting: edge clicks drive hover-emphasis + click-to-fit in
    // the tree; letting them enter React Flow's selection would clear
    // the node selection and drop an active pin.
    selectable: false,
    focusable: false,
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
 * Tailwind classes marking a node's spotlight role. Applied to the node
 * CARD — not the React Flow wrapper — so the ring sits flush against
 * the card's `border-2` and follows its exact corner radius (a
 * wrapper-level outline slices through the port handles and mismatches
 * the radius). Shared by all three custom node components.
 *
 * Precedence: the pinned node itself (React Flow `selected`) gets the
 * theme-neutral `--flow-pin` ring; otherwise a direct consumer of the
 * pinned building (`data.pinConsumer`) gets the amber
 * `--flow-pin-consumer` ring — "the targets of this item" — so
 * consumers read apart from the upstream production cone, which stays
 * ring-less. Both vars live in index.css.
 */
export const nodeRingClasses = (
  selected: boolean | undefined,
  pinConsumer: boolean | undefined,
): string => {
  if (selected) return "ring-2 ring-(--flow-pin)";
  if (pinConsumer) return "ring-2 ring-(--flow-pin-consumer)";
  return "";
};

/**
 * Stable per-item edge colour. Primary source: `itemIconColors` — hue +
 * chroma factor pre-computed from the item's icon by
 * `pnpm run extract:item-colors` (re-run when icons change), so an
 * edge's colour matches the material it carries. Items missing from the
 * map (icon not yet added) fall back to a hash-derived hue.
 *
 * Lightness and base chroma live in theme CSS variables
 * (`--flow-edge-l` / `--flow-edge-c`, see index.css) so every colour
 * stays legible on both the light and dark canvas without recomputing
 * edges on theme switch; the per-item chroma factor scales inside
 * `calc()` (gray icons → gray-ish edges).
 *
 * Items without an id (defensive) fall back to the muted foreground.
 */
export function getItemEdgeColor(itemId?: string): string {
  if (!itemId) return "var(--muted-foreground)";
  const icon = itemIconColors[itemId];
  if (icon) {
    return `oklch(var(--flow-edge-l) calc(var(--flow-edge-c) * ${icon.c}) ${icon.h})`;
  }
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

    // Catalyst self-loops (`direction: "self"`) intentionally fall through
    // to the normal styling below: the connection keeps the item-transported
    // colour like any other edge. The only thing "self" changes is the
    // target handle (`createEdge` routes it to the top "catalyst" port);
    // the catalyst upkeep is surfaced on the node card, not by recolouring
    // the edge.

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
 * The always-on catalyst upkeep for a recipe's facility (1.4 transmuter
 * `facilitySustainDrains`), or `undefined` for non-drain facilities. The
 * calculator folds this drain into `recipe.inputs`; surfacing it on the
 * flow node lets the card + edge layer render it legibly.
 */
function catalystDrainFor(
  recipe: ProductionNode["recipe"],
): { itemId: ItemId; ratePerMinute: number } | undefined {
  if (!recipe) return undefined;
  return facilitySustainDrains.get(recipe.facilityId);
}

/**
 * Map every production flow node that carries a catalyst upkeep to its
 * drained item id. Consumed by `isCatalystSelfLoop` so a self-loop is
 * tagged `"self"` (top "catalyst" handle + upkeep styling) ONLY when the
 * looped item is genuinely that node's catalyst — not any topological
 * producer==consumer edge. Base game data has no non-catalyst self-loops
 * today, but this keeps the coupling robust if that ever changes.
 */
export function buildCatalystItemByNode(
  nodes: readonly FlowProductionNode[],
): Map<string, ItemId> {
  const map = new Map<string, ItemId>();
  for (const n of nodes) {
    const cat = n.data.productionNode.catalyst;
    if (cat) map.set(n.id, cat.itemId);
  }
  return map;
}

/**
 * True when an allocated edge is a catalyst self-loop: producer and
 * consumer are the same node AND the flowing item is that node's catalyst
 * (from `buildCatalystItemByNode`). Such edges re-home to the top
 * "catalyst" handle; every other self-loop stays a normal edge.
 */
export function isCatalystSelfLoop(
  producerId: string,
  consumerId: string,
  itemId: ItemId,
  catalystItemByNode: ReadonlyMap<string, ItemId>,
): boolean {
  return (
    producerId === consumerId && catalystItemByNode.get(consumerId) === itemId
  );
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
  // Surface transmuter catalyst upkeep (folded into `recipe.inputs` by the
  // calculator) so the card can show it like an internal item and the edge
  // layer can re-home the self-loop to the top "catalyst" handle.
  const catalyst = node.catalyst ?? catalystDrainFor(node.recipe);
  return {
    id: nodeId,
    type: "productionNode",
    data: {
      productionNode: catalyst ? { ...node, catalyst } : node,
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

/**
 * Creates a power-generation sink flow node (Thermal Bank burning
 * batteries). Flow-wise identical to a disposal sink — only the
 * rendering differs (amber "Power Generation" card).
 */
export function createPowerSinkNode(
  nodeId: string,
  item: Item,
  burnRate: number,
  facility: Facility,
  facilityCount: number,
  powerGeneration: number,
  items: Item[],
  facilities: Facility[],
  ceilMode = false,
): FlowPowerNode {
  return {
    id: nodeId,
    type: "powerSink",
    data: {
      item,
      burnRate,
      facility,
      facilityCount,
      powerGeneration,
      items,
      facilities,
      ceilMode,
    },
    position: { x: 0, y: 0 },
    targetPosition: Position.Left,
  };
}

/**
 * Buffed machines for a gas environment, grouped by (facility, formula).
 * The buff attaches to the RECIPE (`recipe.gasEnv === env`), not the
 * facility — so this returns one entry per env-gated ACTIVE recipe, with
 * `buildings` = the ceiled physical count running that formula. Shared by
 * all three mappers so the Recipe-View aggregate node and the
 * Facility-View per-unit partition start from the same set.
 */
export function envBuffedMachines(
  plan: ProductionDependencyGraph,
  env: number,
  facilityById: Map<FacilityId, Facility>,
  recipeById: Map<RecipeId, Recipe>,
): EnvCoverageEntry[] {
  const out: EnvCoverageEntry[] = [];
  for (const node of plan.nodes.values()) {
    if (node.type !== "recipe" || !(node.facilityCount > 0)) continue;
    if (node.recipe.gasEnv !== env) continue;
    const facility = facilityById.get(node.recipe.facilityId);
    const recipe = recipeById.get(node.recipeId) ?? node.recipe;
    if (!facility) continue;
    out.push({
      facility,
      recipe,
      buildings: Math.max(1, Math.ceil(node.facilityCount)),
    });
  }
  // Stable order: facility id, then recipe id (deterministic partition).
  out.sort(
    (a, b) =>
      a.facility.id.localeCompare(b.facility.id) ||
      a.recipe.id.localeCompare(b.recipe.id),
  );
  return out;
}

/**
 * Partition the flat buffed-BUILDING list across `unitCount` Gas
 * Dispersing Units as a representative BALANCED split: the first
 * `total % unitCount` units get `ceil(total / unitCount)` buildings, the
 * rest get `floor` — so no unit is ever left empty (a fixed-chunk split
 * can strand the last unit). The SET of buffed buildings is exact (from
 * `gasEnv`); only the which-unit-covers-which grouping is representative
 * (the calculator has no spatial model). Returns one `EnvCoveredBuilding[]`
 * per unit (length === `unitCount`).
 */
export function partitionBuffedBuildings(
  buildings: EnvCoveredBuilding[],
  unitCount: number,
): EnvCoveredBuilding[][] {
  if (unitCount <= 1) return [buildings];
  const base = Math.floor(buildings.length / unitCount);
  const extra = buildings.length % unitCount;
  const units: EnvCoveredBuilding[][] = [];
  let cursor = 0;
  for (let u = 0; u < unitCount; u++) {
    const size = base + (u < extra ? 1 : 0);
    units.push(buildings.slice(cursor, cursor + size));
    cursor += size;
  }
  return units;
}

/**
 * Creates a gas-environment sink flow node (1.4 Gas Dispersing Unit).
 * Flow-wise identical to a disposal sink (consumes the env gas) — only
 * the rendering differs (teal "Gaseous Environment" card that names the
 * buff and lists the buffed machines by formula).
 */
export function createEnvSinkNode(
  nodeId: string,
  item: Item,
  intakeRate: number,
  facility: Facility,
  facilityCount: number,
  vaporizeRecipeId: RecipeId,
  env: number,
  covered: EnvCoverageEntry[],
  coveredBuildings: EnvCoveredBuilding[],
  items: Item[],
  facilities: Facility[],
  ceilMode = false,
): FlowEnvNode {
  return {
    id: nodeId,
    type: "envSink",
    data: {
      item,
      intakeRate,
      facility,
      facilityCount,
      vaporizeRecipeId,
      env,
      covered,
      coveredBuildings,
      items,
      facilities,
      ceilMode,
    },
    position: { x: 0, y: 0 },
    targetPosition: Position.Left,
  };
}
