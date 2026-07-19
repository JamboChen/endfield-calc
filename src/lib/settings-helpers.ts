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
 * Initial enabled-structures set for a first-run user. Mirrors the
 * AIC `initialResearchedSet` semantics: structures in **active**
 * domains are all enabled by default; inactive-domain structures
 * aren't enabled.
 *
 * Persistence stores the inverse (a `disabled` absence-list); this
 * helper is the "fresh user, no localStorage" default and the
 * round-trip identity for the symmetric loader
 * (`deriveStructuresEnabledFromDisabled` with an empty `disabled`
 * array returns the same set).
 */
export function initialStructuresEnabled(
  registry: ReadonlyMap<DomainId, readonly RegionStructure[]>,
  activeDomains: ReadonlySet<DomainId>,
): Set<string> {
  const out = new Set<string>();
  for (const [domainId, list] of registry) {
    if (!activeDomains.has(domainId)) continue;
    for (const s of list) out.add(structureKey(domainId, s.id));
  }
  return out;
}

/**
 * Derive the in-memory enabled set from the persisted absence-list
 * (`disabled`). Symmetric with `deriveResearchedFromUnresearched` in
 * `useDomainSettings.ts`.
 *
 * Rule: a structure is enabled iff its domain is active AND it
 * doesn't appear in `disabled`. Disabled entries for inactive
 * domains or unknown structures are filtered out implicitly (the
 * iteration walks `registry × activeDomains` only).
 *
 * Empty `disabled` round-trips to `initialStructuresEnabled` — that
 * equivalence is the contract pinned by the tests.
 */
export function deriveStructuresEnabledFromDisabled(
  disabled: ReadonlyArray<{
    domainId: DomainId;
    structureId: RegionStructureId;
  }>,
  registry: ReadonlyMap<DomainId, readonly RegionStructure[]>,
  activeDomains: ReadonlySet<DomainId>,
): Set<string> {
  const denied = new Set<string>();
  for (const r of disabled) {
    denied.add(structureKey(r.domainId, r.structureId));
  }
  const out = new Set<string>();
  for (const [domainId, list] of registry) {
    if (!activeDomains.has(domainId)) continue;
    for (const s of list) {
      const key = structureKey(domainId, s.id);
      if (!denied.has(key)) out.add(key);
    }
  }
  return out;
}

/**
 * Compute the persisted absence-list (`disabled`) from the in-memory
 * `enabled` set + the registry. Symmetric inverse of
 * `deriveStructuresEnabledFromDisabled`. Used by the storage writer.
 *
 * Only iterates structures in **active** domains — structures in
 * inactive domains are neither enabled nor "disabled" (their state
 * doesn't ship in the persisted absence-list; AIC soft-deactivation
 * semantics mean re-activation restores the prior in-memory enabled
 * state).
 */
export function structuresDisabledFromEnabled(
  enabled: ReadonlySet<string>,
  registry: ReadonlyMap<DomainId, readonly RegionStructure[]>,
  activeDomains: ReadonlySet<DomainId>,
): Array<{ domainId: DomainId; structureId: RegionStructureId }> {
  const out: Array<{ domainId: DomainId; structureId: RegionStructureId }> = [];
  for (const [domainId, list] of registry) {
    if (!activeDomains.has(domainId)) continue;
    for (const s of list) {
      if (!enabled.has(structureKey(domainId, s.id))) {
        out.push({ domainId, structureId: s.id });
      }
    }
  }
  return out;
}

/**
 * Per-category "this setting differs" flags for the read-only shared
 * plan view. Populated only while viewing someone else's plan; each set
 * holds the row keys whose value differs from the viewer's OWN settings,
 * so the Settings UI can accent exactly those rows. See
 * `useDomainSettings.sharedDiff`.
 */
export interface SharedSettingsDiff {
  /** The selected factory region differs. */
  readonly currentDomainChanged: boolean;
  /** Domains whose active/inactive state differs. */
  readonly domainActivation: ReadonlySet<DomainId>;
  /** AIC nodes whose researched state differs (keyed by node id). */
  readonly researched: ReadonlySet<AicTechId>;
  /** Cap overrides that differ (keyed by `capKey`). */
  readonly capOverrides: ReadonlySet<string>;
  /** Raw-material limits that differ (keyed by `rawLimitKey`). */
  readonly rawLimits: ReadonlySet<string>;
  /** Structures whose enabled state differs (keyed by `structureKey`). */
  readonly structures: ReadonlySet<string>;
  /** Metastorage sources whose route mode differs (keyed by source domain). */
  readonly routes: ReadonlySet<DomainId>;
}

/** One side of the diff — the plan-relevant composed settings atoms. */
export interface DiffableSettings {
  readonly inactiveDomains: ReadonlySet<DomainId>;
  readonly researched: ReadonlySet<AicTechId>;
  readonly capOverrides: ReadonlyMap<string, number>;
  readonly currentDomain: DomainId;
  readonly rawLimitOverrides: ReadonlyMap<string, number>;
  readonly structuresEnabled: ReadonlySet<string>;
  readonly metastorageRouteModes: ReadonlyMap<DomainId, "disabled" | DomainId>;
}

function symmetricSetDiff<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) if (!b.has(x)) out.add(x);
  for (const x of b) if (!a.has(x)) out.add(x);
  return out;
}

/** Keys whose value differs, or that exist on exactly one side. */
function mapValueDiff<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): Set<K> {
  const out = new Set<K>();
  for (const [k, v] of a) if (b.get(k) !== v) out.add(k);
  for (const k of b.keys()) if (!a.has(k)) out.add(k);
  return out;
}

/**
 * Compute the per-category settings diff between a shared plan's snapshot
 * (`shared`) and the viewer's own settings (`own`). Pure; drives the
 * read-only shared-view accents. Symmetric — a setting customized on
 * EITHER side is flagged (the point is to surface every divergence).
 */
export function diffSettings(
  shared: DiffableSettings,
  own: DiffableSettings,
): SharedSettingsDiff {
  return {
    currentDomainChanged: shared.currentDomain !== own.currentDomain,
    domainActivation: symmetricSetDiff(
      shared.inactiveDomains,
      own.inactiveDomains,
    ),
    researched: symmetricSetDiff(shared.researched, own.researched),
    capOverrides: mapValueDiff(shared.capOverrides, own.capOverrides),
    rawLimits: mapValueDiff(shared.rawLimitOverrides, own.rawLimitOverrides),
    structures: symmetricSetDiff(
      shared.structuresEnabled,
      own.structuresEnabled,
    ),
    routes: mapValueDiff(
      shared.metastorageRouteModes,
      own.metastorageRouteModes,
    ),
  };
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
