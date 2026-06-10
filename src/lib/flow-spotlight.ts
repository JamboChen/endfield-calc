import type { Edge } from "@xyflow/react";

/**
 * Node/edge id sets that stay at full opacity while a spotlight is
 * active; everything else dims. See ProductionDependencyTree.
 */
export interface SpotlightSet {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  /**
   * Subset of `nodeIds`: the pinned seeds' DIRECT consumers — "the
   * targets of this item". Rendered with an amber ring so they read
   * apart from the upstream production cone. Always empty for hover
   * neighborhoods; never contains a seed (a pinned card keeps its
   * neutral pin ring even in cycles / multi-pin).
   */
  consumerNodeIds: Set<string>;
}

/**
 * Direct neighborhood of a node: the node itself, every edge touching
 * it, and the nodes on the far end of those edges.
 *
 * In-game framing: "I'm wiring this building — which belts/pipes connect
 * to it, from/to which buildings?" (hover gesture).
 */
export function getNeighborhood(edges: Edge[], nodeId: string): SpotlightSet {
  const nodeIds = new Set<string>([nodeId]);
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source === nodeId) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.target);
    } else if (edge.target === nodeId) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.source);
    }
  }
  return { nodeIds, edgeIds, consumerNodeIds: new Set() };
}

/**
 * Pin spotlight: the seeds' full UPSTREAM production cone (transitive
 * suppliers, with the edges traversed along the way) plus their DIRECT
 * consumers (one hop downstream — the edges leaving a seed and the
 * nodes they land on). No transitive downstream: consumers' own
 * consumers stay dimmed.
 *
 * In-game framing: "to run this building, what must I build (supply
 * cone), and where do I route its output (direct consumers)?" Pinning
 * a target sink — which has no consumers — lights everything needed to
 * produce that target. Without the downstream cutoff, pinning e.g. a
 * Dense Carbon Powder grinder would cascade through Stabilized Carbon
 * into the entire Xiranite subgraph and beyond.
 *
 * Multiple seeds yield the union. Cycle-safe: production graphs contain
 * cycles (backward edges within SCCs); a visited set bounds the BFS.
 */
export function getPinnedSpotlight(
  edges: Edge[],
  seedIds: string[],
): SpotlightSet {
  const byTarget = new Map<string, Edge[]>();
  for (const edge of edges) {
    const inn = byTarget.get(edge.target) ?? [];
    inn.push(edge);
    byTarget.set(edge.target, inn);
  }

  const nodeIds = new Set<string>(seedIds);
  const edgeIds = new Set<string>();

  // Upstream BFS: transitive suppliers.
  const visited = new Set<string>(seedIds);
  const queue = [...seedIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of byTarget.get(current) ?? []) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.source);
      if (!visited.has(edge.source)) {
        visited.add(edge.source);
        queue.push(edge.source);
      }
    }
  }

  // Direct consumers: one hop downstream from the seeds only. Seeds are
  // kept out of the consumer set — a pinned card always shows its
  // neutral pin ring, even when it consumes its own output (cycles) or
  // another pinned seed's output (multi-pin).
  const seeds = new Set(seedIds);
  const consumerNodeIds = new Set<string>();
  for (const edge of edges) {
    if (seeds.has(edge.source)) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.target);
      if (!seeds.has(edge.target)) consumerNodeIds.add(edge.target);
    }
  }

  return { nodeIds, edgeIds, consumerNodeIds };
}

/**
 * Union of two spotlights — used when a hover spotlight is active while
 * a pin is held: the pinned set stays lit and the hovered neighborhood
 * adds on top (hover-leave falls back to the pin alone).
 */
export function mergeSpotlights(
  a: SpotlightSet,
  b: SpotlightSet,
): SpotlightSet {
  return {
    nodeIds: new Set([...a.nodeIds, ...b.nodeIds]),
    edgeIds: new Set([...a.edgeIds, ...b.edgeIds]),
    consumerNodeIds: new Set([...a.consumerNodeIds, ...b.consumerNodeIds]),
  };
}
