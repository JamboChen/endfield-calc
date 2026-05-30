import { rawLimitKey } from "@/lib/raw-limits-helpers";
import type { Item, ItemId } from "@/types";
import type { RegionStructureId } from "@/types/constants";
import type { AicGroup, AicNode, AicTechId, FacilityBaseCap } from "@/types/aic";
import type { DomainId } from "@/types/domain";
import type { RegionStructure } from "@/types/structures";

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

/**
 * Number of distinct capped facilities in a region (a facility with a
 * base cap or a cap-raise node). Drives **Limits-tab visibility** —
 * regions with zero targets don't show the tab. Mirrors the `targets`
 * collation in `FacilityLimitsContent` (deduped by facility, domain fixed).
 */
export function countFacilityCapTargets(
  baseCaps: readonly FacilityBaseCap[],
  capRaiseNodes: readonly AicNode[],
  domainId: DomainId,
): number {
  const facilities = new Set<string>();
  for (const b of baseCaps) {
    if (b.domainId === domainId) facilities.add(b.facilityId);
  }
  for (const n of capRaiseNodes) {
    if (n.action.kind === "capRaise" && n.action.domainId === domainId) {
      facilities.add(n.action.facilityId);
    }
  }
  return facilities.size;
}

/** Stable key for an enabled `(domain, structure)` pair (NUL-delimited). */
export function structureKey(
  domainId: DomainId,
  structureId: RegionStructureId,
): string {
  return `${domainId}\u0000${structureId}`;
}

/**
 * Toggle one region structure with a prereq-chain cascade (linear today,
 * but general over `requires`). Enabling a structure pulls in its
 * transitive prereqs; disabling it drops every transitive dependent. Pure
 * over one region's structure set + that region's currently-enabled ids.
 */
export function cascadeStructureChain(
  structures: readonly RegionStructure[],
  enabledIds: ReadonlySet<RegionStructureId>,
  toggleId: RegionStructureId,
): ReadonlySet<RegionStructureId> {
  const byId = new Map<RegionStructureId, RegionStructure>();
  for (const s of structures) byId.set(s.id, s);
  const next = new Set(enabledIds);

  if (enabledIds.has(toggleId)) {
    // Disable: drop toggleId + every structure that (transitively)
    // requires it.
    const doomed = new Set<RegionStructureId>([toggleId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of structures) {
        if (s.requires && doomed.has(s.requires) && !doomed.has(s.id)) {
          doomed.add(s.id);
          changed = true;
        }
      }
    }
    for (const id of doomed) next.delete(id);
  } else {
    // Enable: add toggleId + walk the `requires` chain to the head.
    let cur: RegionStructureId | undefined = toggleId;
    const guard = new Set<RegionStructureId>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      next.add(cur);
      cur = byId.get(cur)?.requires;
    }
  }
  return next;
}

/**
 * Enabled / total structure count for a region. Drives the
 * Structures-tab badge ("N / 4 enabled").
 */
export function countRegionStructuresEnabled(
  enabled: ReadonlySet<string>,
  structures: readonly RegionStructure[],
  domainId: DomainId,
): ProgressCount {
  let done = 0;
  for (const s of structures) {
    if (enabled.has(structureKey(domainId, s.id))) done++;
  }
  return { done, total: structures.length };
}

/**
 * Keep the requested tab if it is still available for the region,
 * otherwise fall back to the first available tab. Pure + deterministic
 * so the variable-tab fallback (a region may lack Limits/Structures) is
 * unit-testable without rendering. `available` is never empty in
 * practice (every region has a Plan).
 */
export function resolveActiveTab(
  requested: string,
  available: readonly string[],
): string {
  if (available.includes(requested)) return requested;
  return available[0] ?? requested;
}
