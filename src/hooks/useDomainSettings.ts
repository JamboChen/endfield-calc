/**
 * Owns user-controlled per-domain settings.
 *
 * Step 1 ships this hook with calc-side behaviour **dormant**: the menu
 * UI persists and reads research state, but `disabledFacilities` is not
 * yet threaded into `calculateProductionPlan`. That wiring lands in Step 2.
 *
 * # Architecture
 *
 * The hook is intentionally structured as a "domain-settings umbrella":
 * domain-level concerns (which domains are active) live at the top of the
 * return value; per-category sub-states (today: just AIC) are nested
 * under their own keys. Future categories (region limits, power budget,
 * etc.) add new peer sub-objects without disturbing today's AIC API.
 *
 * ```typescript
 * const { domains, activeDomains, toggleDomain, aic } = useDomainSettings();
 * aic.researched.has(techId);
 * aic.toggleNode(techId);
 * // future: regionLimits.bandwidthOverride(domainId, value);
 * ```
 *
 * # Persistence
 *
 * Persistence key: `endfield-calc:aic-v1`. The key is the sole version
 * signal — the JSON value has no `v` field. The loader detects shape by
 * the presence of an `aic` sub-object and migrates v1-flat to the nested
 * shape on first read. Writer always emits the nested shape.
 *
 * Current shape:
 * ```json
 * {
 *   "domains": { "inactive": ["domain_2"], "current": "domain_1" },
 *   "aic": {
 *     "unresearched": ["tech_..."],
 *     "capOverrides": [
 *       { "facilityId": "...", "domainId": "...", "value": 5 }
 *     ]
 *   }
 * }
 * ```
 *
 * `domains.current` is the user's selected factory region. Invariant:
 * always ∈ `activeDomains` (pinned domains are always active so this
 * holds by construction in the worst case). The loader treats a missing
 * or invalid `current` as the "latest" active region — highest `sortId`
 * in the active set — which doubles as the migration default for
 * payloads written before the region picker landed.
 *
 * Legacy v1-flat shape (still readable):
 * ```json
 * {
 *   "v": 1,
 *   "unresearched": [...],
 *   "capOverrides": [...],
 *   "inactiveDomains": ["domain_2"]   // optional
 * }
 * ```
 *
 * # Default state (no localStorage)
 *
 * - `inactiveDomains` = `{ d ∈ domains : !d.isPinned }` → today `{ domain_2 }`.
 * - `researched` = for each node: researched iff its domain is active OR
 *   `node.alreadyUnlocked`. Active domains get the Step-1 "everything
 *   researched" default; inactive domains get the game-default subset.
 *
 * # Soft deactivation
 *
 * `toggleDomain` toggles an entry in/out of `inactiveDomains` and leaves
 * `researched` untouched. Re-activating a domain restores prior research
 * state automatically. Pinned domains (Valley IV) refuse deactivation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  aicNodes,
  aicLayers,
  aicGroups,
  domains as domainData,
  facilityBaseCaps,
} from "@/data/aic-plans";
import {
  buildNodeIndex,
  cascadeActivate,
  cascadeDeactivate,
} from "@/lib/aic-cascade";
import {
  capKey,
  computeEffectiveCaps,
  computeUnlockedFacilities,
  computeUnlockedModes,
  isGroupAtDefaults,
} from "@/lib/aic-research-helpers";
import type {
  AicGroupId,
  AicLayerId,
  AicNode,
  AicTechId,
} from "@/types/aic";
import type { Domain, DomainId } from "@/types/domain";
import type { FacilityId } from "@/types";

const STORAGE_KEY = "endfield-calc:aic-v1";

interface CapOverrideRecord {
  facilityId: FacilityId;
  domainId: DomainId;
  value: number;
}

/**
 * Nested persistence shape — what writer emits and current-shape loader expects.
 *
 * `domains.current` may be absent (legacy payload written before the
 * region picker). Loader defaults to the latest active region.
 */
interface PersistedShape {
  domains: { inactive: DomainId[]; current?: DomainId };
  aic: {
    unresearched: AicTechId[];
    capOverrides: CapOverrideRecord[];
  };
}

/**
 * Legacy v1-flat shape — supported by loader for back-compat. Migrated
 * in-memory to `PersistedShape` and re-written on next save.
 */
interface PersistedShapeV1 {
  v?: number;
  unresearched: AicTechId[];
  capOverrides: CapOverrideRecord[];
  inactiveDomains?: DomainId[];
}

// ── Initial state ──────────────────────────────────────────────────────────

/**
 * Group id → domain id index. Built once at module load from `aicGroups`.
 * Used by the initial-state generator to decide "active or inactive
 * domain" per node.
 */
const NODE_DOMAIN_BY_GROUP: ReadonlyMap<AicGroupId, DomainId> = (() => {
  const out = new Map<AicGroupId, DomainId>();
  for (const g of aicGroups) out.set(g.id, g.domainId);
  return out;
})();

/**
 * Default-inactive domains (no localStorage): every non-pinned domain
 * starts inactive. Valley IV (`isPinned: true`) is always active.
 */
function defaultInactiveDomains(): Set<DomainId> {
  const out = new Set<DomainId>();
  for (const d of domainData) {
    if (!d.isPinned) out.add(d.id);
  }
  return out;
}

/**
 * Initial researched set for a first-run user:
 *  - nodes in active domains: all researched (Step 1 default)
 *  - nodes in inactive domains: only `alreadyUnlocked: true` (game default)
 */
function initialResearchedSet(activeDomains: ReadonlySet<DomainId>): Set<AicTechId> {
  const out = new Set<AicTechId>();
  for (const node of aicNodes) {
    const domainId = NODE_DOMAIN_BY_GROUP.get(node.groupId);
    const active = domainId !== undefined && activeDomains.has(domainId);
    if (active || node.alreadyUnlocked) out.add(node.id);
  }
  return out;
}

function deriveResearchedFromUnresearched(
  unresearched: readonly AicTechId[],
): Set<AicTechId> {
  const denied = new Set<AicTechId>(unresearched);
  const out = new Set<AicTechId>();
  for (const node of aicNodes) {
    if (!denied.has(node.id)) out.add(node.id);
  }
  return out;
}

// ── Storage I/O ────────────────────────────────────────────────────────────

function isNestedShape(data: unknown): data is PersistedShape {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.aic === "object" &&
    d.aic !== null &&
    typeof d.domains === "object" &&
    d.domains !== null
  );
}

function isV1FlatShape(data: unknown): data is PersistedShapeV1 {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.unresearched) && Array.isArray(d.capOverrides);
}

function migrateV1ToNested(v1: PersistedShapeV1): PersistedShape {
  return {
    domains: {
      inactive: Array.isArray(v1.inactiveDomains) ? [...v1.inactiveDomains] : [],
      // v1-flat never carried `current`; loader's downstream validation
      // synthesises it from the active set.
    },
    aic: {
      unresearched: [...v1.unresearched],
      capOverrides: [...v1.capOverrides],
    },
  };
}

/**
 * Pick the "latest" active region — highest `sortId` in the active
 * set. Used as the default `currentDomain` when persistence carries no
 * value (migration), the persisted value is invalid (corruption), or
 * the user deactivates the AIC of their current region (auto-fallback).
 *
 * Falls back to the first pinned domain when no active domain exists
 * (pinned domains are always active by construction so this only
 * triggers if `domainData` is empty — defensive).
 */
function pickLatestActive(activeDomains: ReadonlySet<DomainId>): DomainId {
  let best: { id: DomainId; sortId: number } | null = null;
  for (const d of domainData) {
    if (!activeDomains.has(d.id)) continue;
    if (!best || d.sortId > best.sortId) {
      best = { id: d.id, sortId: d.sortId };
    }
  }
  if (best) return best.id;
  const pinned = domainData.find((d) => d.isPinned);
  return (pinned ?? domainData[0]).id;
}

function loadFromStorage(): PersistedShape | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const knownTechIds = new Set(aicNodes.map((n) => n.id as string));
    const knownDomainIds = new Set(domainData.map((d) => d.id as string));

    let shape: PersistedShape | null = null;
    if (isNestedShape(parsed)) {
      shape = parsed;
    } else if (isV1FlatShape(parsed)) {
      shape = migrateV1ToNested(parsed);
    } else {
      return null;
    }

    // Defensive filter — drop ids that no longer exist (e.g. after an
    // `extract:aic` run dropped a previously-known node or domain).
    const unresearched = shape.aic.unresearched.filter((id): id is AicTechId =>
      typeof id === "string" && knownTechIds.has(id),
    );
    const inactive = shape.domains.inactive.filter((id): id is DomainId =>
      typeof id === "string" && knownDomainIds.has(id),
    );
    const capOverrides = shape.aic.capOverrides.filter(
      (c): c is CapOverrideRecord =>
        c !== null &&
        typeof c === "object" &&
        typeof c.facilityId === "string" &&
        typeof c.domainId === "string" &&
        typeof c.value === "number" &&
        Number.isFinite(c.value),
    );
    const current =
      typeof shape.domains.current === "string" &&
      knownDomainIds.has(shape.domains.current)
        ? (shape.domains.current as DomainId)
        : undefined;
    return {
      domains: { inactive, current },
      aic: { unresearched, capOverrides },
    };
  } catch {
    return null;
  }
}

function persistToStorage(state: {
  researched: ReadonlySet<AicTechId>;
  inactiveDomains: ReadonlySet<DomainId>;
  capOverrides: ReadonlyMap<string, number>;
  currentDomain: DomainId;
}): void {
  if (typeof window === "undefined") return;
  try {
    // Invert the researched set → unresearched list for storage.
    const unresearched: AicTechId[] = [];
    for (const node of aicNodes) {
      if (!state.researched.has(node.id)) unresearched.push(node.id);
    }
    unresearched.sort();

    const capList: CapOverrideRecord[] = [];
    for (const [key, value] of state.capOverrides) {
      const [facilityId, domainId] = key.split("\u0000");
      if (!facilityId || !domainId) continue;
      capList.push({
        facilityId: facilityId as FacilityId,
        domainId: domainId as DomainId,
        value,
      });
    }
    const payload: PersistedShape = {
      domains: {
        inactive: Array.from(state.inactiveDomains).sort(),
        current: state.currentDomain,
      },
      aic: {
        unresearched,
        capOverrides: capList.sort((a, b) => {
          if (a.facilityId !== b.facilityId)
            return a.facilityId.localeCompare(b.facilityId);
          return a.domainId.localeCompare(b.domainId);
        }),
      },
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be full / disabled — silent failure is fine here.
  }
}

// ── Public hook ────────────────────────────────────────────────────────────

/**
 * AIC sub-state — one of N per-domain setting categories. Future
 * categories (region limits, etc.) add their own peer sub-objects on
 * `DomainSettingsValue`.
 */
export interface AicSubState {
  readonly nodes: readonly AicNode[];
  readonly groups: typeof aicGroups;
  readonly layers: typeof aicLayers;
  readonly baseCaps: typeof facilityBaseCaps;

  /** Currently-researched node ids. */
  readonly researched: ReadonlySet<AicTechId>;

  /** Derived: facilities the calc may use given `researched` and active domains. */
  readonly unlockedFacilities: ReadonlySet<FacilityId>;

  /** Derived: per-facility mode names the player has researched. */
  readonly unlockedModes: ReadonlyMap<FacilityId, ReadonlySet<string>>;

  /** Derived: facility cap = base + raises (or override if set). */
  readonly effectiveCaps: ReadonlyMap<
    FacilityId,
    ReadonlyMap<DomainId, number>
  >;

  /** User-set cap overrides. Keyed by `${facilityId}\u0000${domainId}`. */
  readonly capOverrides: ReadonlyMap<string, number>;

  /**
   * Derived: per-plan "at defaults" flag. Drives the Reset button's
   * visibility in `AicPlanCard` — hidden when the corresponding entry
   * is true.
   */
  readonly isAtDefaultsByGroup: ReadonlyMap<AicGroupId, boolean>;

  // Mutators
  toggleNode: (id: AicTechId) => void;
  activateLayer: (id: AicLayerId) => void;
  activateGroup: (id: AicGroupId) => void;
  /**
   * Generic activator — cascades over the given ids and their transitive
   * prereqs. Used by the Facility Limits per-facility Check button to
   * activate every cap-raise upgrade for one facility at once. Reusable
   * for any future "activate this set" UX.
   */
  activateNodes: (ids: readonly AicTechId[]) => void;
  /**
   * Per-plan reset: nodes in this group are set to their game-default
   * state (`researched.has(n.id) === n.alreadyUnlocked`). Other groups
   * are untouched.
   */
  resetGroupToDefaults: (groupId: AicGroupId) => void;
  setCapOverride: (
    facilityId: FacilityId,
    domainId: DomainId,
    value: number | null,
  ) => void;
}

export interface DomainSettingsValue {
  /** First-class domain registry from the data dump. */
  readonly domains: readonly Domain[];
  /** Currently-active domains. Pinned ones are always included. */
  readonly activeDomains: ReadonlySet<DomainId>;
  /**
   * Toggle activation for `id`. Refuses pinned domains silently. Does
   * NOT mutate `aic.researched` (soft preservation — re-activating
   * restores prior state).
   *
   * If `id === currentDomain` and the toggle would deactivate it, the
   * setter also shifts `currentDomain` to `pickLatestActive` of the
   * post-toggle active set. This preserves the invariant
   * `currentDomain ∈ activeDomains`. Callers detect this case via the
   * value change in the next render and toast accordingly.
   */
  toggleDomain: (id: DomainId) => void;

  /**
   * Bulk-apply the first-visit onboarding choices. For each `(domainId,
   * isChecked)` pair:
   *   - Non-pinned + checked → domain active, all nodes researched.
   *   - Non-pinned + unchecked → domain inactive, nodes reset to
   *     `alreadyUnlocked` only.
   *   - Pinned + checked → all nodes researched (domain stays active).
   *   - Pinned + unchecked → nodes reset to `alreadyUnlocked` only
   *     (domain stays active — pinned domains can't deactivate).
   *
   * Domains absent from the map are treated as checked (defensive — the
   * caller defaults to all-checked).
   *
   * `currentDomain` is the user's selected factory region from the
   * onboarding dropdown. Caller is responsible for ensuring it is in
   * the post-confirm active set (the dialog's option list is filtered
   * to `d.isPinned || choices.get(d.id)`).
   *
   * Atomic: one `setInactiveDomains` + one `setResearched` +
   * `setCurrentDomain` call, so the persist effect fires once with all
   * three updates batched by React.
   */
  applyOnboardingChoices: (
    choices: ReadonlyMap<DomainId, boolean>,
    currentDomain: DomainId,
  ) => void;

  /**
   * The user's currently-selected factory region. Used by the
   * `Facility.domains` filter and per-region cap lookup. Invariant:
   * always a member of `activeDomains`.
   */
  readonly currentDomain: DomainId;

  /**
   * Set the current factory region. Silently no-op if `id` is not in
   * `activeDomains` (defensive — the picker UI only exposes active
   * regions, so this guard catches mistakes upstream).
   */
  setCurrentDomain: (id: DomainId) => void;

  /** AIC sub-state (the first category). Future categories sit alongside. */
  readonly aic: AicSubState;
}

export function useDomainSettings(): DomainSettingsValue {
  const [inactiveDomains, setInactiveDomains] = useState<
    ReadonlySet<DomainId>
  >(() => {
    const persisted = loadFromStorage();
    if (persisted) return new Set(persisted.domains.inactive);
    return defaultInactiveDomains();
  });

  const [researched, setResearched] = useState<ReadonlySet<AicTechId>>(() => {
    const persisted = loadFromStorage();
    if (persisted) {
      return deriveResearchedFromUnresearched(persisted.aic.unresearched);
    }
    // First-run: active-domain nodes all researched, inactive-domain
    // nodes only `alreadyUnlocked: true`.
    const initialActive = new Set<DomainId>();
    for (const d of domainData) {
      if (!defaultInactiveDomains().has(d.id)) initialActive.add(d.id);
    }
    return initialResearchedSet(initialActive);
  });

  const [capOverrides, setCapOverrides] = useState<ReadonlyMap<string, number>>(
    () => {
      const persisted = loadFromStorage();
      if (!persisted) return new Map();
      const out = new Map<string, number>();
      for (const c of persisted.aic.capOverrides) {
        out.set(capKey(c.facilityId, c.domainId), c.value);
      }
      return out;
    },
  );

  // `currentDomain` initial value:
  //   - persisted value if valid (∈ active set)
  //   - otherwise `pickLatestActive` of the active set (handles
  //     migration from pre-region-picker payloads + corrupted values)
  const [currentDomain, setCurrentDomainState] = useState<DomainId>(() => {
    const persisted = loadFromStorage();
    const initialActive = new Set<DomainId>();
    const initialInactive = persisted
      ? new Set(persisted.domains.inactive)
      : defaultInactiveDomains();
    for (const d of domainData) {
      if (!initialInactive.has(d.id)) initialActive.add(d.id);
    }
    const fromPersisted = persisted?.domains.current;
    if (fromPersisted && initialActive.has(fromPersisted)) {
      return fromPersisted;
    }
    return pickLatestActive(initialActive);
  });

  // Derived: active domains (allDomains - inactive). Pinned domains
  // can never be in `inactiveDomains` (the toggler refuses) so they're
  // always active here.
  const activeDomains = useMemo<ReadonlySet<DomainId>>(() => {
    const out = new Set<DomainId>();
    for (const d of domainData) {
      if (!inactiveDomains.has(d.id)) out.add(d.id);
    }
    return out;
  }, [inactiveDomains]);

  // Persist on every state change. `useRef` skips the initial cycle
  // (state matches what we just read).
  const isInitial = useRef(true);
  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false;
      return;
    }
    persistToStorage({
      researched,
      inactiveDomains,
      capOverrides,
      currentDomain,
    });
  }, [researched, inactiveDomains, capOverrides, currentDomain]);

  // Derived: AIC selectors (domain-aware where applicable).
  const unlockedFacilities = useMemo(
    () => computeUnlockedFacilities(researched, activeDomains),
    [researched, activeDomains],
  );
  const unlockedModes = useMemo(
    () => computeUnlockedModes(researched, unlockedFacilities),
    [researched, unlockedFacilities],
  );
  const effectiveCaps = useMemo(
    () => computeEffectiveCaps(researched, capOverrides),
    [researched, capOverrides],
  );
  const isAtDefaultsByGroup = useMemo(() => {
    const out = new Map<AicGroupId, boolean>();
    for (const g of aicGroups) {
      out.set(g.id, isGroupAtDefaults(g.id, researched));
    }
    return out;
  }, [researched]);

  // Node index for O(1) lookup in mutators.
  const nodeIndex = useMemo(() => buildNodeIndex(aicNodes), []);

  const toggleDomain = useCallback((id: DomainId) => {
    setInactiveDomains((prev) => {
      const domain = domainData.find((d) => d.id === id);
      if (!domain || domain.isPinned) return prev; // pinned domains never toggle
      const next = new Set(prev);
      const becomesInactive = !next.has(id);
      if (becomesInactive) next.add(id);
      else next.delete(id);

      // Auto-fallback: if this toggle deactivates the user's current
      // factory region, shift `currentDomain` to the next-latest active
      // region. The setter runs in the same render batch as
      // setInactiveDomains so the persist effect sees both updates.
      if (becomesInactive) {
        setCurrentDomainState((prevCurrent) => {
          if (prevCurrent !== id) return prevCurrent;
          const nextActive = new Set<DomainId>();
          for (const d of domainData) {
            if (!next.has(d.id)) nextActive.add(d.id);
          }
          return pickLatestActive(nextActive);
        });
      }
      return next;
    });
  }, []);

  const setCurrentDomain = useCallback((id: DomainId) => {
    setCurrentDomainState((prev) => {
      if (prev === id) return prev;
      // Defensive: the picker UI only exposes active regions, but a
      // stale call (e.g. concurrent toggle that just deactivated `id`)
      // could land here. Silently keep the previous value.
      const domain = domainData.find((d) => d.id === id);
      if (!domain) return prev;
      return id;
    });
  }, []);

  /**
   * First-visit onboarding bulk-apply. See `DomainSettingsValue
   * .applyOnboardingChoices` for semantics. Touches inactive-domains,
   * researched-nodes, and currentDomain in three setter calls; React
   * batches them so the persist effect fires once.
   *
   * `nextCurrentDomain` is validated against the post-confirm active
   * set; if it would land outside, falls back to `pickLatestActive`
   * (defensive — the dialog filters its option list, but a stale
   * staged value could otherwise sneak through).
   */
  const applyOnboardingChoices = useCallback(
    (
      choices: ReadonlyMap<DomainId, boolean>,
      nextCurrentDomain: DomainId,
    ) => {
      const nextInactive = new Set<DomainId>();
      for (const d of domainData) {
        if (d.isPinned) continue; // pinned never enters inactive set
        const isChecked = choices.get(d.id) ?? true;
        if (!isChecked) nextInactive.add(d.id);
      }
      const nextActive = new Set<DomainId>();
      for (const d of domainData) {
        if (!nextInactive.has(d.id)) nextActive.add(d.id);
      }

      setInactiveDomains(nextInactive);

      setResearched(() => {
        const next = new Set<AicTechId>();
        for (const node of aicNodes) {
          const domainId = NODE_DOMAIN_BY_GROUP.get(node.groupId);
          if (!domainId) {
            // Defensive: orphan node — apply game default only.
            if (node.alreadyUnlocked) next.add(node.id);
            continue;
          }
          const isChecked = choices.get(domainId) ?? true;
          if (isChecked) {
            // All nodes researched
            next.add(node.id);
          } else if (node.alreadyUnlocked) {
            // Game default only
            next.add(node.id);
          }
        }
        return next;
      });

      setCurrentDomainState(
        nextActive.has(nextCurrentDomain)
          ? nextCurrentDomain
          : pickLatestActive(nextActive),
      );
    },
    [],
  );

  const toggleNode = useCallback(
    (id: AicTechId) => {
      setResearched((prev) => {
        const node = nodeIndex.get(id);
        if (!node) return prev;
        if (node.alreadyUnlocked) return prev; // immutable
        if (prev.has(id)) return cascadeDeactivate([id], prev, aicNodes);
        // Strict gate: only activate if prereqs met (no cascade for
        // individual clicks).
        for (const pre of node.preNodes) {
          if (!prev.has(pre)) return prev;
        }
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    [nodeIndex],
  );

  const activateLayer = useCallback((layerId: AicLayerId) => {
    setResearched((prev) => {
      const targets = aicNodes
        .filter((n) => n.layerId === layerId)
        .map((n) => n.id);
      if (targets.length === 0) return prev;
      return cascadeActivate(targets, prev, aicNodes);
    });
  }, []);

  const activateGroup = useCallback((groupId: AicGroupId) => {
    setResearched((prev) => {
      const targets = aicNodes
        .filter((n) => n.groupId === groupId)
        .map((n) => n.id);
      if (targets.length === 0) return prev;
      return cascadeActivate(targets, prev, aicNodes);
    });
  }, []);

  /**
   * Generic node activator — cascades over the given ids and their
   * transitive prereqs. Used by the Facility Limits per-facility Check
   * button to bulk-activate cap-raises; reusable for any future "activate
   * this set" UX.
   */
  const activateNodes = useCallback((ids: readonly AicTechId[]) => {
    setResearched((prev) => {
      if (ids.length === 0) return prev;
      return cascadeActivate(ids, prev, aicNodes);
    });
  }, []);

  /**
   * Per-plan Reset: for nodes in this group, set researched-state to
   * `node.alreadyUnlocked`. Other groups untouched.
   */
  const resetGroupToDefaults = useCallback((groupId: AicGroupId) => {
    setResearched((prev) => {
      const next = new Set(prev);
      for (const node of aicNodes) {
        if (node.groupId !== groupId) continue;
        if (node.alreadyUnlocked) next.add(node.id);
        else next.delete(node.id);
      }
      return next;
    });
  }, []);

  const setCapOverride = useCallback(
    (facilityId: FacilityId, domainId: DomainId, value: number | null) => {
      setCapOverrides((prev) => {
        const next = new Map(prev);
        const key = capKey(facilityId, domainId);
        if (value === null || !Number.isFinite(value)) next.delete(key);
        else next.set(key, value);
        return next;
      });
    },
    [],
  );

  const aic: AicSubState = useMemo(
    () => ({
      nodes: aicNodes,
      groups: aicGroups,
      layers: aicLayers,
      baseCaps: facilityBaseCaps,
      researched,
      unlockedFacilities,
      unlockedModes,
      effectiveCaps,
      capOverrides,
      isAtDefaultsByGroup,
      toggleNode,
      activateLayer,
      activateGroup,
      activateNodes,
      resetGroupToDefaults,
      setCapOverride,
    }),
    [
      researched,
      unlockedFacilities,
      unlockedModes,
      effectiveCaps,
      capOverrides,
      isAtDefaultsByGroup,
      toggleNode,
      activateLayer,
      activateGroup,
      activateNodes,
      resetGroupToDefaults,
      setCapOverride,
    ],
  );

  return {
    domains: domainData,
    activeDomains,
    toggleDomain,
    applyOnboardingChoices,
    currentDomain,
    setCurrentDomain,
    aic,
  };
}
