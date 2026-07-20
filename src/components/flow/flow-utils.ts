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
import { MIN_VISIBLE_RATE_PER_MIN } from "@/lib/flow-thresholds";

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
/**
 * The two-line edge label (`"<rate> /min\n<transport>"`). Extracted from
 * `createEdge` so the catalyst split (`routeCatalystIntakeToTopHandle`) can
 * relabel a cloned fragment with its carved rate without rebuilding the
 * whole edge — keeping the split lossless (type/direction/marker survive).
 */
function buildEdgeLabel(
  flowRate: number,
  item: Item | undefined,
  ceilMode: boolean,
  direction: EdgeDirection | undefined,
  sourceFacilityCount?: number,
): string {
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

  return `${flowRate.toFixed(2)} /min\n${labelTransport}`;
}

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
  return {
    id,
    source,
    target,
    sourceHandle: item?.id,
    type: direction === "backward" ? "backwardEdge" : "simplebezier",
    label: buildEdgeLabel(flowRate, item, ceilMode, direction, sourceFacilityCount),
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
 * A catalyst node's intake descriptor: the drained item, and the per-minute
 * amount of that item the node consumes as a base INGREDIENT (`0` when the
 * catalyst is a separate/pure catalyst). Everything in the item's intake
 * ABOVE the ingredient portion is catalyst upkeep and re-homes to the top
 * handle.
 */
export interface CatalystIntake {
  itemId: ItemId;
  ingredientRate: number;
}

/**
 * Map every production flow node that carries a catalyst contract to its
 * `{ itemId, ingredientRate }` intake — read STRAIGHT off the node's
 * embedded `CatalystUpkeep` (the plan's authoritative decomposition,
 * scaled by the emitting mapper to the node's own granularity). No game
 * data or base-roster lookups: the mapper output is a pure function of
 * the plan.
 */
export function buildCatalystIntakeByNode(
  nodes: readonly { id: string; data: { productionNode?: ProductionNode } }[],
): Map<string, CatalystIntake> {
  const map = new Map<string, CatalystIntake>();
  for (const n of nodes) {
    const cat = n.data.productionNode?.catalyst;
    if (!cat) continue;
    map.set(n.id, { itemId: cat.itemId, ingredientRate: cat.ingredientPerMin });
  }
  return map;
}

/**
 * Re-home catalyst intake to the top "catalyst" handle. For every catalyst
 * node, the edges delivering its catalyst item are gathered; the catalyst
 * portion (`total − ingredientRate`) is routed to the top handle, any
 * ingredient portion of the same item stays on the default (left) handle.
 *
 * - Pure catalyst (a separate item, or a self-loop): `ingredientRate == 0`,
 *   so every such edge is simply retagged — LOSSLESS, only `targetHandle`
 *   changes.
 * - Merged (the catalyst item is also a base ingredient): the boundary edge
 *   is split into a left remainder (ingredient) + a cloned top fragment
 *   (catalyst). The clone spreads the original edge, so `type`, `direction`
 *   (incl. `"backward"` cycle tags), and marker survive; only the rate and
 *   its label are recomputed.
 *
 * Source-agnostic: runs after ALL edges are emitted, so it catches catalyst
 * arriving via crafted producers, vent pickups, metastorage imports, or a
 * self-loop uniformly.
 */
export function routeCatalystIntakeToTopHandle(
  edges: Edge[],
  catalystIntakeByNode: ReadonlyMap<string, CatalystIntake>,
  itemById: ReadonlyMap<ItemId, Item>,
  ceilMode: boolean,
  nextEdgeId: () => string,
): void {
  if (catalystIntakeByNode.size === 0) return;
  const edgeRate = (e: Edge): number =>
    (e.data as { flowRate?: number } | undefined)?.flowRate ?? 0;

  // One pass: bucket each catalyst node's catalyst-item edges.
  const byNode = new Map<string, Edge[]>();
  for (const e of edges) {
    const intake = catalystIntakeByNode.get(e.target);
    if (!intake) continue;
    if ((e.data as { itemId?: string } | undefined)?.itemId !== intake.itemId) {
      continue;
    }
    const bucket = byNode.get(e.target);
    if (bucket) bucket.push(e);
    else byNode.set(e.target, [e]);
  }

  for (const [nodeId, cEdges] of byNode) {
    const { itemId, ingredientRate } = catalystIntakeByNode.get(nodeId)!;
    const total = cEdges.reduce((s, e) => s + edgeRate(e), 0);
    let remainingTop = total - ingredientRate;
    if (remainingTop <= MIN_VISIBLE_RATE_PER_MIN) continue; // no catalyst here

    // Pure catalyst (this item is not also a base ingredient): retag all.
    if (ingredientRate <= MIN_VISIBLE_RATE_PER_MIN) {
      for (const e of cEdges) e.targetHandle = "catalyst";
      continue;
    }

    // Merged: carve the catalyst portion off the front to the top handle,
    // leaving the ingredient portion on the default (left) handle.
    const item = itemById.get(itemId);
    for (const e of cEdges) {
      if (remainingTop <= MIN_VISIBLE_RATE_PER_MIN) break;
      const rate = edgeRate(e);
      const dir = (e.data as { direction?: EdgeDirection } | undefined)
        ?.direction;
      if (rate <= remainingTop + MIN_VISIBLE_RATE_PER_MIN) {
        e.targetHandle = "catalyst";
        remainingTop -= rate;
        continue;
      }
      // Boundary edge: lossless split (ingredient stays, catalyst clones).
      const topRate = remainingTop;
      const leftRate = rate - topRate;
      edges.push({
        ...e,
        id: nextEdgeId(),
        targetHandle: "catalyst",
        label: buildEdgeLabel(topRate, item, ceilMode, dir),
        data: { ...e.data, flowRate: topRate },
      });
      e.label = buildEdgeLabel(leftRate, item, ceilMode, dir);
      (e.data as { flowRate?: number }).flowRate = leftRate;
      remainingTop = 0;
    }
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
