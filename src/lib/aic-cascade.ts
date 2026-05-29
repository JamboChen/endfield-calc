/**
 * Pure helpers for AIC tech-tree cascading.
 *
 * Behaviour contract for the menu UI (Step 1 of the AIC Plan feature):
 *
 *   - **Individual checkbox toggle is strict.** Clicking a node whose
 *     prereqs are unmet is a no-op at the UI level; `canActivate` reports
 *     this. Toggling OFF a node that's a prereq of other researched nodes
 *     also deactivates them (see `cascadeDeactivate`).
 *   - **Bulk "Activate all" actions cascade silently.** Activating a set of
 *     target nodes pulls in every transitive prereq via `cascadeActivate`.
 *     The UI surfaces the resulting count delta in a toast.
 *   - **Default-unlocked nodes (`alreadyUnlocked: true`) cannot be
 *     deactivated.** `cascadeDeactivate` skips them.
 *
 * All helpers are deterministic and side-effect free; UI code wires them
 * to React state.
 */

import type { AicNode, AicTechId } from "@/types/aic";

/**
 * Index nodes by id for O(1) lookup.
 */
export function buildNodeIndex(
  nodes: readonly AicNode[],
): ReadonlyMap<AicTechId, AicNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/**
 * Reverse adjacency: for each node id, the set of node ids that list it
 * as a `preNode`. Used by `cascadeDeactivate` and `findDependents`.
 */
export function buildDependentsIndex(
  nodes: readonly AicNode[],
): ReadonlyMap<AicTechId, ReadonlySet<AicTechId>> {
  const out = new Map<AicTechId, Set<AicTechId>>();
  for (const node of nodes) {
    for (const pre of node.preNodes) {
      let bucket = out.get(pre);
      if (!bucket) {
        bucket = new Set();
        out.set(pre, bucket);
      }
      bucket.add(node.id);
    }
  }
  return out;
}

/**
 * Whether a node's prereqs are all satisfied by `researched`.
 */
export function arePrereqsMet(
  node: AicNode,
  researched: ReadonlySet<AicTechId>,
): boolean {
  for (const pre of node.preNodes) {
    if (!researched.has(pre)) return false;
  }
  return true;
}

/**
 * Whether a node can be activated by the user right now.
 *
 * `alreadyUnlocked` nodes are reported as activatable (they're effectively
 * always on), but the UI marks them non-interactive separately.
 */
export function canActivate(
  node: AicNode,
  researched: ReadonlySet<AicTechId>,
): boolean {
  if (researched.has(node.id)) return true;
  return arePrereqsMet(node, researched);
}

/**
 * Activate `targetIds` and every transitive prereq. Returns a new
 * researched set; never mutates the input.
 *
 * Cycles in the prereq DAG would be a data bug — we defensively guard with
 * `visited` so the function still terminates if one ever slipped through.
 */
export function cascadeActivate(
  targetIds: Iterable<AicTechId>,
  current: ReadonlySet<AicTechId>,
  nodes: readonly AicNode[],
): ReadonlySet<AicTechId> {
  const index = buildNodeIndex(nodes);
  const next = new Set(current);
  const stack: AicTechId[] = [];
  for (const id of targetIds) stack.push(id);

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (next.has(id)) continue;
    const node = index.get(id);
    if (!node) continue; // unknown id — ignore (defensive)
    next.add(id);
    for (const pre of node.preNodes) {
      if (!next.has(pre)) stack.push(pre);
    }
  }
  return next;
}

/**
 * Deactivate `targetIds` and every dependent node that would lose a prereq.
 * `alreadyUnlocked` nodes cannot be deactivated and are preserved.
 *
 * Returns a new researched set; never mutates the input.
 */
export function cascadeDeactivate(
  targetIds: Iterable<AicTechId>,
  current: ReadonlySet<AicTechId>,
  nodes: readonly AicNode[],
): ReadonlySet<AicTechId> {
  const index = buildNodeIndex(nodes);
  const dependents = buildDependentsIndex(nodes);
  const next = new Set(current);
  const stack: AicTechId[] = [];
  for (const id of targetIds) stack.push(id);

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (!next.has(id)) continue;
    const node = index.get(id);
    if (!node) continue;
    if (node.alreadyUnlocked) continue; // cannot deactivate game-defaults
    next.delete(id);
    // Any researched dependent that now has an unmet prereq must also go.
    const deps = dependents.get(id);
    if (deps) {
      for (const depId of deps) {
        if (!next.has(depId)) continue;
        const depNode = index.get(depId);
        if (!depNode) continue;
        if (!arePrereqsMet(depNode, next)) stack.push(depId);
      }
    }
  }
  return next;
}

/**
 * Find all currently-researched dependents (direct or transitive) of
 * `targetIds`, excluding `alreadyUnlocked` nodes. Used by the
 * confirm-dialog in Step 2 to preview what a deactivation would remove.
 */
export function findResearchedDependents(
  targetIds: Iterable<AicTechId>,
  researched: ReadonlySet<AicTechId>,
  nodes: readonly AicNode[],
): ReadonlySet<AicTechId> {
  const index = buildNodeIndex(nodes);
  const dependents = buildDependentsIndex(nodes);
  const out = new Set<AicTechId>();
  const stack: AicTechId[] = [];
  for (const id of targetIds) stack.push(id);

  while (stack.length > 0) {
    const id = stack.pop()!;
    const deps = dependents.get(id);
    if (!deps) continue;
    for (const depId of deps) {
      if (out.has(depId)) continue;
      if (!researched.has(depId)) continue;
      const depNode = index.get(depId);
      if (!depNode || depNode.alreadyUnlocked) continue;
      out.add(depId);
      stack.push(depId);
    }
  }
  return out;
}

/**
 * For a layer or plan's bulk "Activate all": compute the set of ids that
 * `cascadeActivate` would add on top of the current state. Useful for
 * toast strings ("Activated N nodes (M prereqs)").
 */
export function previewActivationDelta(
  targetIds: readonly AicTechId[],
  current: ReadonlySet<AicTechId>,
  nodes: readonly AicNode[],
): {
  /** Ids in `targetIds` that weren't already researched. */
  primary: number;
  /** Additional transitive prereqs pulled in beyond `targetIds`. */
  prereqs: number;
} {
  const next = cascadeActivate(targetIds, current, nodes);
  let primary = 0;
  let prereqs = 0;
  const targetSet = new Set(targetIds);
  for (const id of next) {
    if (current.has(id)) continue;
    if (targetSet.has(id)) primary++;
    else prereqs++;
  }
  return { primary, prereqs };
}
