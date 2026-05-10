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

  // Phase 3 bin invariants:
  //   1. Every internal-direction edge must connect facilities of recipes
  //      sharing the same binId. An internal edge between recipes in
  //      different bins indicates the mapper produced a flow that should
  //      have crossed a transport boundary instead.
  //   2. Every facility node carrying a non-empty binSisterRecipeIds
  //      should also carry a binId — both fields belong together.
  const binMismatches: string[] = [];
  const incompleteBinAnnotations: string[] = [];

  // Build a recipe-id → binId lookup from production node data.
  const recipeBinId = new Map<string, string>();
  for (const node of nodes) {
    const data = node.data as
      | { productionNode?: { recipe?: { id: string }; binId?: string; binSisterRecipeIds?: string[] } }
      | undefined;
    const pn = data?.productionNode;
    if (!pn?.recipe) continue;
    if (pn.binId) recipeBinId.set(pn.recipe.id, pn.binId);
    if ((pn.binSisterRecipeIds?.length ?? 0) > 0 && !pn.binId) {
      incompleteBinAnnotations.push(node.id);
    }
  }

  const recipeIdFromFacilityId = (fid: string): string | null => {
    const m = fid.match(/^(.+)-f\d+$/);
    return m ? m[1] : null;
  };

  for (const edge of edges) {
    const data = edge.data as { direction?: string } | undefined;
    if (data?.direction !== "internal") continue;
    const srcRecipe = recipeIdFromFacilityId(edge.source) ?? edge.source;
    const tgtRecipe = recipeIdFromFacilityId(edge.target) ?? edge.target;
    const srcBin = recipeBinId.get(srcRecipe);
    const tgtBin = recipeBinId.get(tgtRecipe);
    if (!srcBin || !tgtBin || srcBin !== tgtBin) {
      binMismatches.push(`${edge.id}: ${srcRecipe}@${srcBin ?? "?"} → ${tgtRecipe}@${tgtBin ?? "?"}`);
    }
  }

  if (binMismatches.length > 0) {
    console.warn(
      `[${mapperName}] ${binMismatches.length} 'internal' edge(s) cross bin boundaries:`,
      binMismatches,
    );
  }
  if (incompleteBinAnnotations.length > 0) {
    console.warn(
      `[${mapperName}] ${incompleteBinAnnotations.length} node(s) with sister recipe IDs but no binId:`,
      incompleteBinAnnotations,
    );
  }
}
