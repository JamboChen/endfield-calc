import type { Node, Edge } from "@xyflow/react";

/**
 * Detect test-mode execution. Vitest sets `import.meta.env.MODE` to
 * "test" by default. When true, `assertFlowIntegrity` throws on any
 * violation instead of merely warning — this elevates "shouldn't
 * happen" runtime warnings to hard test failures, ensuring mapper
 * regressions like the Xiranite Powder isolated-nodes bug can't slip
 * past the test suite again.
 */
const isTestMode = (): boolean => {
  return import.meta.env?.MODE === "test";
};

/**
 * Collect all flow-integrity violations for a mapper output. Returns
 * one or more human-readable messages describing each violation.
 *
 * Checks:
 *   1. **Missing endpoints**: edges referencing node ids that aren't
 *      in the node set.
 *   2. **Isolated nodes**: emitted nodes with no incident edges (only
 *      flagged when the graph has >1 node; a single-node graph is
 *      legitimately edge-less).
 *   3. **Cross-bin internal edges**: any edge tagged
 *      `direction: "internal"` whose source and target recipes live
 *      in different bins. Internal flows must stay within a bin.
 *   4. **Incomplete bin annotations**: production nodes carrying a
 *      non-empty `binSisterRecipeIds` but no `binId` (the two fields
 *      belong together).
 *   5. **Catalyst contract**: every production node carrying a
 *      `catalyst` contract must receive its charged upkeep on the top
 *      "catalyst" handle — Σ top-handle in-edges ≈ `upkeepPerMin`
 *      (small absolute slack for sub-visible dropped edges). Polices
 *      the whole fold → plan contract → mapper split pipeline in
 *      every view.
 */
function findFlowIntegrityIssues(
  mapperName: string,
  nodes: Node[],
  edges: Edge[],
): string[] {
  const issues: string[] = [];
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
    issues.push(
      `[${mapperName}] ${missing.length} edge endpoint(s) reference missing nodes: ${JSON.stringify(missing)}`,
    );
  }
  if (isolated.length > 0 && nodes.length > 1) {
    issues.push(
      `[${mapperName}] ${isolated.length} node(s) have no incident edges: ${JSON.stringify(isolated.map((n) => n.id))}`,
    );
  }

  // Phase 3 bin invariants: internal-direction edges must stay
  // within a bin; nodes carrying sister recipe ids must also carry a
  // binId.
  const binMismatches: string[] = [];
  const incompleteBinAnnotations: string[] = [];

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
    issues.push(
      `[${mapperName}] ${binMismatches.length} 'internal' edge(s) cross bin boundaries: ${JSON.stringify(binMismatches)}`,
    );
  }
  if (incompleteBinAnnotations.length > 0) {
    issues.push(
      `[${mapperName}] ${incompleteBinAnnotations.length} node(s) with sister recipe IDs but no binId: ${JSON.stringify(incompleteBinAnnotations)}`,
    );
  }

  // Catalyst-contract invariant: the plan's authoritative upkeep must
  // arrive on the top handle of the node it belongs to. Slack absorbs
  // sub-MIN_VISIBLE dropped edges + float noise while still catching
  // real attribution bugs (which show up at whole-fraction-of-a-drain
  // scale, e.g. 7.38 vs 6).
  const CATALYST_TOLERANCE = 0.05;
  const topInByNode = new Map<string, number>();
  for (const edge of edges) {
    if (edge.targetHandle !== "catalyst") continue;
    const rate =
      (edge.data as { flowRate?: number } | undefined)?.flowRate ?? 0;
    topInByNode.set(edge.target, (topInByNode.get(edge.target) ?? 0) + rate);
  }
  const catalystViolations: string[] = [];
  for (const node of nodes) {
    if (node.type !== "productionNode") continue;
    const cat = (
      node.data as
        | { productionNode?: { catalyst?: { upkeepPerMin: number } } }
        | undefined
    )?.productionNode?.catalyst;
    if (!cat || cat.upkeepPerMin <= CATALYST_TOLERANCE) continue;
    const got = topInByNode.get(node.id) ?? 0;
    if (Math.abs(got - cat.upkeepPerMin) > CATALYST_TOLERANCE) {
      catalystViolations.push(
        `${node.id}: top-handle ${got.toFixed(3)} ≠ upkeep ${cat.upkeepPerMin.toFixed(3)}`,
      );
    }
  }
  if (catalystViolations.length > 0) {
    issues.push(
      `[${mapperName}] ${catalystViolations.length} node(s) violate the catalyst upkeep contract: ${JSON.stringify(catalystViolations)}`,
    );
  }

  return issues;
}

/**
 * Assert flow-integrity on a mapper's output.
 *
 * - Production: no-op (the checks would be expensive and unactionable
 *   in front of real users).
 * - Test mode (vitest): throws on any violation. Mapper bugs that
 *   produce orphaned sinks, dangling edges, or cross-bin internal
 *   flows become hard test failures rather than silently-warning
 *   console noise.
 * - Dev mode (browser): logs warnings to the console so the developer
 *   can spot graph anomalies without crashing the page.
 */
export function assertFlowIntegrity(
  mapperName: string,
  nodes: Node[],
  edges: Edge[],
): void {
  if (import.meta.env?.PROD) return;

  const issues = findFlowIntegrityIssues(mapperName, nodes, edges);
  if (issues.length === 0) return;

  if (isTestMode()) {
    throw new Error(
      `Flow integrity violation in ${mapperName}:\n${issues.join("\n")}`,
    );
  }

  for (const issue of issues) {
    console.warn(issue);
  }
}
