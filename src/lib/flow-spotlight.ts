import type { Edge } from "@xyflow/react";

/**
 * Node/edge id sets that stay at full opacity while a spotlight is
 * active; everything else dims. See ProductionDependencyTree.
 */
export interface SpotlightSet {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
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
  return { nodeIds, edgeIds };
}

/**
 * Full production chain through the seed nodes: everything reachable
 * upstream (transitive suppliers) plus everything reachable downstream
 * (transitive consumers), with the edges traversed along the way.
 * Multiple seeds yield the union of their chains.
 *
 * In-game framing: "I'm building this subsystem — show me its entire
 * supply cone and where it delivers" (click-to-pin gesture). Pinning a
 * target sink isolates that product's whole subgraph; pinning a raw
 * pickup shows everything that consumes it.
 *
 * Cycle-safe: production graphs contain cycles (backward edges within
 * SCCs); visited sets bound the BFS.
 */
export function getChain(edges: Edge[], seedIds: string[]): SpotlightSet {
  const bySource = new Map<string, Edge[]>();
  const byTarget = new Map<string, Edge[]>();
  for (const edge of edges) {
    const out = bySource.get(edge.source) ?? [];
    out.push(edge);
    bySource.set(edge.source, out);
    const inn = byTarget.get(edge.target) ?? [];
    inn.push(edge);
    byTarget.set(edge.target, inn);
  }

  const nodeIds = new Set<string>(seedIds);
  const edgeIds = new Set<string>();

  // Directional BFS. `adjacency` maps a node to the edges leaving it in
  // the walk direction; `next` picks the node on the far end.
  const walk = (
    adjacency: Map<string, Edge[]>,
    next: (edge: Edge) => string,
  ) => {
    const visited = new Set<string>(seedIds);
    const queue = [...seedIds];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of adjacency.get(current) ?? []) {
        edgeIds.add(edge.id);
        const far = next(edge);
        nodeIds.add(far);
        if (!visited.has(far)) {
          visited.add(far);
          queue.push(far);
        }
      }
    }
  };

  walk(bySource, (edge) => edge.target); // downstream: consumers
  walk(byTarget, (edge) => edge.source); // upstream: suppliers

  return { nodeIds, edgeIds };
}
