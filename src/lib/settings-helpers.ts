import { rawLimitKey } from "@/lib/raw-limits-helpers";
import type { Item, ItemId } from "@/types";
import type { AicGroup, AicNode, AicTechId } from "@/types/aic";
import type { DomainId } from "@/types/domain";

/**
 * Resolve which region the Settings panel should be editing.
 *
 * The Settings "Configuring" context (`editingDomain`) is local UI state,
 * decoupled from the app's factory region. But a region can be
 * deactivated mid-session (via the region nav menu), which would leave
 * `editingDomain` pointing at an inactive region. This collapses that:
 * keep the requested region if it's still active, otherwise fall back to
 * `currentDomain`.
 *
 * `currentDomain` is a safe fallback because the hook guarantees the
 * invariant `currentDomain ∈ activeDomains` at all times (pinned domains
 * are always active, and `toggleDomain` auto-shifts `currentDomain` when
 * the active region is deactivated). Pure + deterministic so it can be
 * unit-tested without rendering.
 */
export function resolveEditingDomain(
  editing: DomainId,
  activeDomains: ReadonlySet<DomainId>,
  currentDomain: DomainId,
): DomainId {
  return activeDomains.has(editing) ? editing : currentDomain;
}

export interface ProgressCount {
  readonly done: number;
  readonly total: number;
}

/**
 * Researched / researchable count for a region's AIC plan(s). Counts
 * only non-capRaise nodes (cap-raises live in the Facility Limits tab
 * and would conflate two unrelated user actions). Drives the "Plan"
 * sub-tab badge.
 */
export function countAicResearched(
  nodes: readonly AicNode[],
  groups: readonly AicGroup[],
  researched: ReadonlySet<AicTechId>,
  domainId: DomainId,
): ProgressCount {
  const groupIds = new Set<string>();
  for (const g of groups) {
    if (g.domainId === domainId) groupIds.add(g.id);
  }
  let done = 0;
  let total = 0;
  for (const node of nodes) {
    if (node.action.kind === "capRaise") continue;
    if (!groupIds.has(node.groupId)) continue;
    total++;
    if (researched.has(node.id)) done++;
  }
  return { done, total };
}

/**
 * Number of facilities with a custom cap override in a region. Drives
 * the "Limits" sub-tab badge ("N customized"). Cap keys are
 * `${facilityId}\u0000${domainId}` (NUL separator, see `capKey` in
 * `useDomainSettings`); we match the segment after the separator.
 */
export function countCustomizedCaps(
  capOverrides: ReadonlyMap<string, number>,
  domainId: DomainId,
): number {
  let count = 0;
  for (const key of capOverrides.keys()) {
    const sep = key.indexOf("\u0000");
    if (sep === -1) continue;
    if (key.slice(sep + 1) === domainId) count++;
  }
  return count;
}

/**
 * Non-liquid raw items available in a region, in stable id order.
 * Liquids are hidden per the locked design (costless in the LP, governed
 * by pump deployability not user caps). Shared by `RawLimitsContent`
 * (which re-sorts by localised name) and the sourced-count derivation.
 */
export function filterRegionRawItems(
  regionRawMaterials: ReadonlySet<ItemId>,
  itemsById: ReadonlyMap<ItemId, Item>,
): Item[] {
  const out: Item[] = [];
  for (const id of regionRawMaterials) {
    const item = itemsById.get(id);
    if (!item) continue;
    if (item.isLiquid === true) continue;
    out.push(item);
  }
  return out;
}

/**
 * Sourced / total raw-material count for a region. `sourced` = rows with
 * a non-null override. Drives the "Raws" sub-tab badge.
 */
export function countRawSourced(
  rowItems: readonly Item[],
  overrides: ReadonlyMap<string, number>,
  domainId: DomainId,
): ProgressCount {
  let done = 0;
  for (const item of rowItems) {
    if (overrides.has(rawLimitKey(item.id, domainId))) done++;
  }
  return { done, total: rowItems.length };
}
