import type { Node, Edge } from "@xyflow/react";

/**
 * Warns when edges reference missing node ids or nodes have no incident edges.
 * Dev-only — mapper bugs often surface as dangling edges or orphaned sinks
 * that the layout silently accepts; surfacing them in console catches
 * regressions before they reach the user.
 */
export function assertFlowIntegrity(
  mapperName: string,
  nodes: Node[],
  edges: Edge[],
): void {
  if (import.meta.env?.PROD) return;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const missing: { edgeId: string; side: "source" | "target"; id: string }[] = [];
  const referenced = new Set<string>();

  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      missing.push({ edgeId: edge.id, side: "source", id: edge.source });
    }
    if (!nodeIds.has(edge.target)) {
      missing.push({ edgeId: edge.id, side: "target", id: edge.target });
    }
    referenced.add(edge.source);
    referenced.add(edge.target);
  }

  const isolated = nodes.filter((n) => !referenced.has(n.id));

  if (missing.length > 0) {
    console.warn(
      `[${mapperName}] ${missing.length} edge endpoint(s) reference missing nodes:`,
      missing,
    );
  }
  if (isolated.length > 0 && nodes.length > 1) {
    console.warn(
      `[${mapperName}] ${isolated.length} node(s) have no incident edges:`,
      isolated.map((n) => n.id),
    );
  }
}
