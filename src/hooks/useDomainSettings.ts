/**
 * Owns user-controlled per-domain settings.
 *
 * # Reach
 *
 * Drives three live calc-layer concerns:
 *   - **AIC research filter**: `aic.unlockedFacilities` + `aic.unlockedModes`
 *     thread into `computeAvailableFacilities` (App.tsx) to narrow the
 *     recipe set the calc sees.
 *   - **Per-facility caps**: `aic.effectiveCaps`, aggregated across
 *     active domains by App.tsx, feeds the Phase 5 MIP packer.
 *   - **Per-(item, region) raw material limits**: `rawLimits.overrides`,
 *     filtered to `currentDomain` by App.tsx, feeds the LP as slack-
 *     based upper-bound constraints AND the post-pack warning surface.
 *
 * Also drives the user's selected factory region (`currentDomain`),
 * which gates the region-aware reachability closure + `Facility.domains`
 * filter in App.tsx.
 *
 * # Architecture
 *
 * The hook is structured as a "domain-settings umbrella": domain-level
 * concerns (which domains are active, which region the user is
 * building in) live at the top of the return value; per-category sub-
 * states are nested under their own keys (`aic`, `rawLimits`). Future
 * categories (power budget, bandwidth limits, etc.) add new peer sub-
 * objects without disturbing existing call sites.
 *
 * ```typescript
 * const {
 *   domains, activeDomains, toggleDomain,
 *   currentDomain, setCurrentDomain,
 *   aic, rawLimits,
 * } = useDomainSettings();
 * aic.researched.has(techId);
 * rawLimits.setRawLimitOverride(itemId, domainId, 30);
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
 *   },
 *   "rawLimits": {
 *     "overrides": [
 *       { "itemId": "...", "domainId": "...", "value": 30 }
 *     ]
 *   },
 *   "structures": {
 *     "disabled": [
 *       { "domainId": "...", "structureId": "..." }
 *     ]
 *   },
 *   "metastorage": {
 *     "routes": [
 *       { "source": "domain_1", "mode": "disabled" }
 *     ]
 *   }
 * }
 * ```
 *
 * `aic.unresearched`, `structures.disabled`, and `metastorage.routes`
 * are **inverted absence-lists / deviations-only** — empty arrays mean
 * "everything researched / enabled in active domains / every capable
 * source on auto". Persistence stores only the user's explicit
 * opt-outs, so a fresh user (no localStorage) loads with everything on.
 *
 * `domains.current` is the user's selected factory region. Invariant:
 * always ∈ `activeDomains` (pinned domains are always active so this
 * holds by construction in the worst case). The loader treats a missing
 * or invalid `current` (unknown id OR known-but-inactive) as the
 * "latest" active region — highest `sortId` in the active set — which
 * doubles as the migration default for payloads written before the
 * region picker landed.
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
 * - `currentDomain` = pinned domain (overridden by onboarding's region
 *   picker on first-visit confirm).
 * - `researched` = for each node: researched iff its domain is active OR
 *   `node.alreadyUnlocked`. Active domains get the "everything
 *   researched" default; inactive domains get the game-default subset.
 * - `rawLimits.overrides` = empty (no caps configured).
 * - `metastorage.routeModes` = `"auto"` for every capable source (no
 *   stored deviations).
 * - `structures.enabled` = every structure in every active domain
 *   (default-active mirror of AIC). Inactive-domain structures are
 *   not enabled. With Valley IV pinned-active and Wuling default-
 *   inactive today, this means structures.enabled = ∅ for a fresh
 *   user until they activate Wuling via onboarding (which bulk-
 *   enables Wuling's full Purification Node chain).
 *
 * # Soft deactivation
 *
 * `toggleDomain` toggles an entry in/out of `inactiveDomains` and
 * leaves `researched` and `structures.enabled` untouched. Re-activating
 * a domain restores prior research / structures state automatically.
 * Pinned domains (Valley IV) refuse deactivation. When the toggle
 * would deactivate `currentDomain`, the setter auto-shifts
 * `currentDomain` to `pickLatestActive` of the post-toggle set
 * (preserving the invariant); SettingsSheet detects the shift and
 * toasts the user.
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
  metastorageSources,
  rawAvailabilityByDomain,
  regionStructures,
} from "@/data";
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
import { parseRawLimitKey, rawLimitKey } from "@/lib/raw-limits-helpers";
import {
  cascadeStructureChain,
  deriveStructuresEnabledFromDisabled,
  diffSettings,
  initialStructuresEnabled,
  structureKey,
  structuresDisabledFromEnabled,
  type SharedSettingsDiff,
} from "@/lib/settings-helpers";
import { markOnboardingSeen } from "@/lib/onboarding-storage";
import { namespaceStorageKey } from "@/lib/storage-namespace";
import type {
  AicGroupId,
  AicLayerId,
  AicNode,
  AicTechId,
} from "@/types/aic";
import { isDomainId, parseDomainId } from "@/types/domain";
import type { Domain, DomainId } from "@/types/domain";
import type { MetastorageRouteMode } from "@/types/metastorage";
import type { FacilityId, ItemId } from "@/types";
import type { RegionStructureId } from "@/types/constants";

const STORAGE_KEY = namespaceStorageKey("endfield-calc:aic-v1");

interface CapOverrideRecord {
  facilityId: FacilityId;
  domainId: DomainId;
  value: number;
}

interface RawLimitOverrideRecord {
  itemId: ItemId;
  domainId: DomainId;
  value: number;
}

interface StructureDisabledRecord {
  domainId: DomainId;
  structureId: RegionStructureId;
}

/**
 * One persisted Metastorage route deviation. Only non-`"auto"` modes
 * are stored (`"auto"` is the default for every capable source);
 * `mode` is either the literal `"disabled"` or the locked destination
 * `DomainId`.
 */
interface MetastorageRouteRecord {
  source: DomainId;
  mode: "disabled" | DomainId;
}

/**
 * Nested persistence shape — what writer emits and current-shape loader expects.
 *
 * `domains.current` may be absent (legacy payload written before the
 * region picker). Loader defaults to the latest active region.
 *
 * `rawLimits` may be absent (payload written before raw-material
 * limits landed). Loader defaults to an empty override set.
 *
 * Exported so the shared-plan codec (`src/lib/plan-share-codec.ts`) can
 * encode/decode this exact shape into the URL/file, and the provider
 * can compare a shared snapshot against the viewer's own settings.
 */
export interface PersistedShape {
  domains: { inactive: DomainId[]; current?: DomainId };
  aic: {
    unresearched: AicTechId[];
    capOverrides: CapOverrideRecord[];
  };
  rawLimits?: {
    overrides: RawLimitOverrideRecord[];
  };
  /**
   * Region structures (absent in payloads written before the
   * "Structures" tab). **Default-active**: empty `disabled` list (or
   * a missing `structures` key entirely) means every structure in
   * every active domain is enabled. Persistence stores only the
   * user's explicit opt-outs, mirroring the AIC `unresearched`
   * pattern. Inactive-domain structures don't appear here (their
   * state is preserved in memory across deactivation; see
   * `structuresDisabledFromEnabled` for the writer rule).
   */
  structures?: {
    disabled: StructureDisabledRecord[];
  };
  /**
   * Metastorage Transfer route modes (absent in payloads written
   * before the feature landed). **Default-auto**: an empty `routes`
   * list (or a missing `metastorage` key) means every capable source
   * region exports to whichever region is being planned. Persistence
   * stores only deviations — `"disabled"` or a locked destination.
   */
  metastorage?: {
    routes: MetastorageRouteRecord[];
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
 *
 * Exported so `SettingsSheet` can compute the same fallback target
 * pre-emptively (to surface a toast) without depending on a re-render
 * to read the post-toggle `currentDomain`. Single source of truth for
 * the "latest active" semantic — UI must not re-implement.
 */
export function pickLatestActive(activeDomains: ReadonlySet<DomainId>): DomainId {
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

/**
 * Defensively validate + normalize a parsed persistence payload — from
 * localStorage OR a shared-plan URL blob / saved-file snapshot — into a
 * clean `PersistedShape`. Drops ids that no longer exist in the game
 * data, enforces the `currentDomain ∈ activeDomains` invariant, and
 * migrates the legacy v1-flat shape. Returns `null` for unrecognized or
 * corrupt input.
 *
 * The single validation path shared by every persistence channel
 * (localStorage, `plan-share-codec.ts`, the saved-file settings block)
 * so they can never drift.
 */
export function sanitizePersistedShape(parsed: unknown): PersistedShape | null {
  try {
    const knownTechIds = new Set(aicNodes.map((n) => n.id as string));
    const knownStructureKeys = new Set<string>();
    for (const [domainId, list] of regionStructures) {
      for (const s of list) knownStructureKeys.add(structureKey(domainId, s.id));
    }

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
    const inactive = shape.domains.inactive.filter(isDomainId);
    const capOverrides = shape.aic.capOverrides.filter(
      (c): c is CapOverrideRecord =>
        c !== null &&
        typeof c === "object" &&
        typeof c.facilityId === "string" &&
        typeof c.domainId === "string" &&
        isDomainId(c.domainId) &&
        typeof c.value === "number" &&
        Number.isFinite(c.value),
    );
    // Validate `domains.current` against the post-filter active set
    // (not just known-domain membership). The invariant
    // `currentDomain ∈ activeDomains` is documented at the top of this
    // file and relied on by `App.tsx`'s non-null assertion at the
    // `regionRawMaterials` memo. Treating known-but-inactive as
    // invalid here forces the downstream initializer + the
    // setCurrentDomain setter to converge on the same rule, removing
    // a latent footgun where the loader returns a "valid" current
    // that points to an inactive domain.
    const inactiveSet = new Set<string>(inactive);
    const parsedCurrent = parseDomainId(shape.domains.current);
    const current =
      parsedCurrent && !inactiveSet.has(parsedCurrent)
        ? parsedCurrent
        : undefined;

    // Raw-limit overrides — drop entries whose (itemId, domainId) is
    // not in `rawAvailabilityByDomain` (e.g. game patch removed a raw
    // from a region, or the persisted state predates the data). Also
    // drop negative values and non-finite values defensively (the
    // setter rejects them, but a hand-edited localStorage could carry
    // them through).
    const rawLimitOverrides = Array.isArray(shape.rawLimits?.overrides)
      ? shape.rawLimits.overrides.filter(
          (r): r is RawLimitOverrideRecord => {
            if (
              r === null ||
              typeof r !== "object" ||
              typeof r.itemId !== "string" ||
              typeof r.domainId !== "string" ||
              typeof r.value !== "number" ||
              !Number.isFinite(r.value) ||
              r.value < 0
            )
              return false;
            const domainId = parseDomainId(r.domainId);
            if (!domainId) return false;
            const regionSet = rawAvailabilityByDomain.get(domainId);
            return regionSet?.has(r.itemId as ItemId) ?? false;
          },
        )
      : [];

    // Region structures — absence-list of disabled (domain, structure)
    // pairs (inverted persistence, mirrors AIC `unresearched`). Drop
    // entries whose (domain, structure) pair is not a known structure
    // (e.g. registry changed, or hand-edited state) — an unknown
    // disabled entry is meaningless and gets silently dropped, which
    // effectively re-enables the structure under the default-active
    // rule. That's the desired behavior on registry changes.
    const structuresDisabled = Array.isArray(shape.structures?.disabled)
      ? shape.structures.disabled.filter(
          (r): r is StructureDisabledRecord =>
            r !== null &&
            typeof r === "object" &&
            typeof r.domainId === "string" &&
            typeof r.structureId === "string" &&
            isDomainId(r.domainId) &&
            knownStructureKeys.has(
              structureKey(
                r.domainId,
                r.structureId as RegionStructureId,
              ),
            ),
        )
      : [];

    // Metastorage routes — deviations-only list (absent = every capable
    // source on "auto"). Drop entries whose source isn't a known domain
    // with Metastorage capability, whose mode is neither "disabled" nor
    // a known domain in the registry, or whose locked destination equals
    // the source (self-routes are meaningless). The destination gate
    // (`domainData` membership) is identical to `setMetastorageRouteMode`
    // below, so the load and set paths can't drift. Dropping an entry
    // re-defaults that source to "auto" — the desired behavior when a
    // game patch changes the capable-source set.
    const metastorageRoutes = Array.isArray(shape.metastorage?.routes)
      ? shape.metastorage.routes.filter((r): r is MetastorageRouteRecord => {
          if (r === null || typeof r === "undefined") return false;
          if (typeof r !== "object") return false;
          const source = parseDomainId(r.source);
          if (!source || !metastorageSources.has(source)) return false;
          if (r.mode === "disabled") return true;
          const dest = parseDomainId(r.mode);
          return (
            dest !== undefined &&
            dest !== source &&
            domainData.some((d) => d.id === dest)
          );
        })
      : [];

    return {
      domains: { inactive, current },
      aic: { unresearched, capOverrides },
      rawLimits: { overrides: rawLimitOverrides },
      structures: { disabled: structuresDisabled },
      metastorage: { routes: metastorageRoutes },
    };
  } catch {
    return null;
  }
}

/**
 * Read + sanitize the viewer's own persisted settings from localStorage.
 * `null` when absent / corrupt / SSR. Exported for the provider's
 * shared-vs-own comparison.
 */
export function loadPersistedShape(): PersistedShape | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitizePersistedShape(JSON.parse(raw));
  } catch {
    return null;
  }
}

interface PersistableState {
  researched: ReadonlySet<AicTechId>;
  inactiveDomains: ReadonlySet<DomainId>;
  capOverrides: ReadonlyMap<string, number>;
  currentDomain: DomainId;
  rawLimitOverrides: ReadonlyMap<string, number>;
  structuresEnabled: ReadonlySet<string>;
  metastorageRouteModes: ReadonlyMap<DomainId, "disabled" | DomainId>;
}

/**
 * Build the persisted (deviations-only) shape from live state, without
 * writing it anywhere. Extracted from `persistToStorage` so the same
 * inversion also powers `canonicalizeShape` + `DEFAULT_PERSISTED_SHAPE`
 * — the shared-plan codec's delta baseline.
 */
function stateToPersistedShape(state: PersistableState): PersistedShape {
  // Invert the researched set → unresearched list for storage.
  const unresearched: AicTechId[] = [];
  for (const node of aicNodes) {
    if (!state.researched.has(node.id)) unresearched.push(node.id);
  }
  unresearched.sort();

  const capList: CapOverrideRecord[] = [];
  for (const [key, value] of state.capOverrides) {
    const [facilityId, domainIdRaw] = key.split("\u0000");
    const domainId = parseDomainId(domainIdRaw);
    if (!facilityId || !domainId) continue;
    capList.push({
      facilityId: facilityId as FacilityId,
      domainId,
      value,
    });
  }

  const rawLimitsList: RawLimitOverrideRecord[] = [];
  for (const [key, value] of state.rawLimitOverrides) {
    const parsed = parseRawLimitKey(key);
    if (!parsed) continue;
    rawLimitsList.push({
      itemId: parsed.itemId,
      domainId: parsed.domainId,
      value,
    });
  }

  // Invert the in-memory `enabled` set → persisted `disabled`
  // absence-list. Walks the registry × active domains; structures
  // in inactive domains are skipped (their state stays in memory
  // for soft-deactivation; see `structuresDisabledFromEnabled`
  // JSDoc).
  const activeDomains = new Set<DomainId>();
  for (const d of domainData) {
    if (!state.inactiveDomains.has(d.id)) activeDomains.add(d.id);
  }
  const structuresList = structuresDisabledFromEnabled(
    state.structuresEnabled,
    regionStructures,
    activeDomains,
  );

  // Metastorage deviations (in-memory map already stores only
  // non-"auto" modes; serialize as records sorted by source).
  const metastorageList: MetastorageRouteRecord[] = [];
  for (const [source, mode] of state.metastorageRouteModes) {
    metastorageList.push({ source, mode });
  }
  metastorageList.sort((a, b) => a.source.localeCompare(b.source));

  return {
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
    rawLimits: {
      overrides: rawLimitsList.sort((a, b) => {
        if (a.itemId !== b.itemId) return a.itemId.localeCompare(b.itemId);
        return a.domainId.localeCompare(b.domainId);
      }),
    },
    structures: {
      disabled: structuresList.sort((a, b) => {
        if (a.domainId !== b.domainId)
          return a.domainId.localeCompare(b.domainId);
        return a.structureId.localeCompare(b.structureId);
      }),
    },
    metastorage: {
      routes: metastorageList,
    },
  };
}

function persistToStorage(state: PersistableState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(stateToPersistedShape(state)),
    );
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
   * Generic deactivator — removes the given ids and cascades to every
   * dependent that would lose a prereq (game-default `alreadyUnlocked`
   * nodes are preserved). Peer to `activateNodes`; used by the Facility
   * Limits per-building "Reset to base limit" action to drop every
   * researched cap-raise for one facility in a single cascade-safe pass.
   */
  deactivateNodes: (ids: readonly AicTechId[]) => void;
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

/**
 * Raw-material limits sub-state — peer to `aic` on
 * `DomainSettingsValue`. Models the user's per-(item, domain) upper
 * limit on raw consumption, in **items/min**.
 *
 * Consumed by the calc layer in two places (App.tsx aggregates the
 * overrides filtered to `currentDomain` into a `Map<ItemId, number>`,
 * threaded down):
 *   1. **LP-aware enforcement** — `lp-solver.ts` adds soft upper-bound
 *      constraints `Σ consumption ≤ cap + slack` with `SLACK_PENALTY`.
 *      The LP biases toward recipes that conserve the capped raw.
 *   2. **Post-pack warning surface** — the calculator emits
 *      `raw-over-cap` PlanWarnings at plan assembly
 *      (`computeLimitViolations`, plan-helpers.ts); ProductionStats
 *      applies red tint + tooltip on over-cap raw rows.
 *
 * Storage is per-(item, domain) so the user can pre-configure caps
 * for any region for forward planning, matching how `facilityBaseCaps`
 * works. Aggregation at lookup time uses `currentDomain` only — raw
 * caps are inherently per-region (resource POIs / pump deployability)
 * so summing across active domains is semantically wrong.
 */
export interface RawLimitsSubState {
  /**
   * User-set raw-material limit overrides, in items/min.
   * Keyed by `rawLimitKey(itemId, domainId)`.
   * Absence of a key = uncapped.
   */
  readonly overrides: ReadonlyMap<string, number>;

  /**
   * Set / clear a per-(item, domain) limit. `value === null` (or
   * non-finite) removes the override; otherwise stores the new limit.
   * No validation against `rawAvailabilityByDomain` here — the UI is
   * responsible for only offering inputs for valid items.
   */
  setRawLimitOverride: (
    itemId: ItemId,
    domainId: DomainId,
    value: number | null,
  ) => void;
}

export interface StructuresSubState {
  /**
   * Enabled (domain, structure) pairs, keyed by
   * `structureKey(domainId, structureId)`.
   *
   * **Default-active** (mirrors AIC's `researched` semantics): a
   * fresh user with no localStorage has every structure in every
   * active domain enabled. Persistence stores only the user's
   * explicit opt-outs (`structures.disabled` absence-list); empty
   * disabled list round-trips to the "all enabled in active domains"
   * default.
   *
   * Drives `App.tsx`'s `facilityCaps` aggregation (+1 per enabled
   * `instance` structure) and the `structureVariantExcluded` filter
   * (which variant of `facilityRecipeVariants` is active).
   */
  readonly enabled: ReadonlySet<string>;

  /**
   * Toggle one region structure with a prereq-chain cascade (enabling
   * pulls in prereqs; disabling drops dependents). No-op for unknown
   * `(domain, structure)` pairs.
   */
  toggle: (domainId: DomainId, structureId: RegionStructureId) => void;
}

/**
 * Metastorage Transfer sub-state — peer to `aic` / `rawLimits` /
 * `structures` on `DomainSettingsValue`. Models the per-**source**-
 * region outbound route mode:
 *
 *   - `"auto"` (default) — the source exports to whichever region is
 *     currently being planned.
 *   - `"disabled"` — no plan imports from this source.
 *   - a `DomainId` — locked: only plans for that region import from
 *     this source.
 *
 * Consumed by `App.tsx`, which resolves the routes feeding
 * `currentDomain` (source capable + active + mode ∈ {auto, current})
 * into `MetastorageRouteConfig`s for the calc layer, and seeds the
 * reachability closure with the routes' eligible items.
 */
export interface MetastorageSubState {
  /**
   * Route mode per capable source region (every key of
   * `metastorageSources` is present; unset sources read `"auto"`).
   */
  readonly routeModes: ReadonlyMap<DomainId, MetastorageRouteMode>;

  /**
   * Set a source's route mode. No-ops for sources without Metastorage
   * capability, self-routes (`mode === source`), and unknown
   * destination ids. Setting `"auto"` clears the stored deviation.
   */
  setRouteMode: (source: DomainId, mode: MetastorageRouteMode) => void;
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
   *   - Non-pinned + checked → domain active, all nodes researched,
   *     all structures enabled.
   *   - Non-pinned + unchecked → domain inactive, nodes reset to
   *     `alreadyUnlocked` only, no structures enabled.
   *   - Pinned + checked → all nodes researched, all structures
   *     enabled (domain stays active).
   *   - Pinned + unchecked → nodes reset to `alreadyUnlocked` only,
   *     no structures enabled (domain stays active — pinned domains
   *     can't deactivate).
   *
   * Domains absent from the map are treated as checked (defensive — the
   * caller defaults to all-checked).
   *
   * `currentDomain` is the user's selected factory region from the
   * onboarding dropdown. Caller is responsible for ensuring it is in
   * the post-confirm active set (the dialog's option list is filtered
   * to `d.isPinned || choices.get(d.id)`).
   *
   * Atomic: one `setInactiveDomains` + one `setResearched` + one
   * `setStructuresEnabled` + `setCurrentDomain` call, so the persist
   * effect fires once with all four updates batched by React.
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

  /**
   * Raw-material limits sub-state. Inputs are persisted and editable,
   * but not yet consumed by the calc layer (warning emission and LP
   * constraints land with the future solver-enforcement workstream).
   */
  readonly rawLimits: RawLimitsSubState;

  /**
   * Region-exclusive special structures sub-state (the "Structures" tab).
   * Opt-in enable flags per `(domain, structure)`; persisted but not yet
   * consumed by the calc (solver wiring is a later workstream).
   */
  readonly structures: StructuresSubState;

  /** Metastorage Transfer route modes (the "Metastorage" tab). */
  readonly metastorage: MetastorageSubState;

  /**
   * True while viewing a shared plan whose embedded settings differ from
   * the viewer's own. Settings editing is read-only in this mode
   * (localStorage is never written); the viewer's own settings are
   * preserved and restored on exit.
   */
  readonly isSharedView: boolean;

  /**
   * The viewer's live settings as a persisted (deviations-only) shape.
   * Threaded to `useProductionPlan` to embed in the shared URL (`s=`)
   * and in saved plan files. In shared-view this is the frozen snapshot.
   */
  readonly currentShape: PersistedShape;

  /**
   * In shared-view: which settings differ from the viewer's own, so the
   * Settings UI can accent exactly those rows. `null` in normal mode.
   */
  readonly sharedDiff: SharedSettingsDiff | null;

  /**
   * Adopt the shared plan's settings as the viewer's own (writes
   * localStorage, leaves shared-view, and marks first-visit onboarding
   * as seen so it can't fire over the import). Destructive — confirm first.
   */
  importSharedPlan: () => void;

  /**
   * Discard the shared plan's settings and restore the viewer's own
   * (leaves shared-view, re-solves against their world).
   */
  exitSharedPlan: () => void;
}

interface ComposedState {
  inactiveDomains: Set<DomainId>;
  researched: Set<AicTechId>;
  capOverrides: Map<string, number>;
  currentDomain: DomainId;
  rawLimitOverrides: Map<string, number>;
  structuresEnabled: Set<string>;
  metastorageRouteModes: Map<DomainId, "disabled" | DomainId>;
}

/**
 * Compose the hook's initial state in a single pass over a persisted
 * payload. Previously each `useState` initializer called the loader
 * independently — 5× JSON parse + 5× defensive filter walks on every
 * mount. This consolidates the work and the filter passes that share
 * the same payload.
 *
 * Side effect of consolidation: every initial-state field is derived
 * from THE SAME persisted snapshot, removing any chance of subtle
 * drift. Parameterizing the source (rather than reading localStorage
 * internally) also lets a shared-plan snapshot seed the hook without
 * touching the viewer's storage, and powers `canonicalizeShape` /
 * `DEFAULT_PERSISTED_SHAPE`.
 */
function composeStateFromShape(persisted: PersistedShape | null): ComposedState {
  // ── inactiveDomains
  const inactiveDomains = persisted
    ? new Set(persisted.domains.inactive)
    : defaultInactiveDomains();

  // ── researched
  const researched = persisted
    ? deriveResearchedFromUnresearched(persisted.aic.unresearched)
    : (() => {
        // First-run: active-domain nodes all researched, inactive-domain
        // nodes only `alreadyUnlocked: true`.
        const initialActive = new Set<DomainId>();
        for (const d of domainData) {
          if (!inactiveDomains.has(d.id)) initialActive.add(d.id);
        }
        return initialResearchedSet(initialActive);
      })();

  // ── capOverrides
  const capOverrides = new Map<string, number>();
  if (persisted) {
    for (const c of persisted.aic.capOverrides) {
      capOverrides.set(capKey(c.facilityId, c.domainId), c.value);
    }
  }

  // ── currentDomain
  //   - persisted value if valid (∈ active set)
  //   - otherwise `pickLatestActive` of the active set (handles
  //     migration from pre-region-picker payloads + corrupted values)
  const initialActive = new Set<DomainId>();
  for (const d of domainData) {
    if (!inactiveDomains.has(d.id)) initialActive.add(d.id);
  }
  const fromPersisted = persisted?.domains.current;
  const currentDomain =
    fromPersisted && initialActive.has(fromPersisted)
      ? fromPersisted
      : pickLatestActive(initialActive);

  // ── rawLimitOverrides
  //   Loader's defensive (item, domain)-validity filter is already
  //   applied; absence of a key here = uncapped.
  const rawLimitOverrides = new Map<string, number>();
  if (persisted?.rawLimits) {
    for (const r of persisted.rawLimits.overrides) {
      rawLimitOverrides.set(rawLimitKey(r.itemId, r.domainId), r.value);
    }
  }

  // ── structuresEnabled (default-active mirror of AIC; persistence
  //    stores an absence-list of explicit opt-outs)
  //
  // First-run user (no persisted payload): every structure in every
  // active domain is enabled.
  //
  // Persisted user: derive the enabled set from `disabled` (loader's
  // defensive unknown-id filter already applied — entries that don't
  // appear in `regionStructures × initialActive` are filtered out
  // implicitly by the derive helper).
  const structuresEnabled = persisted?.structures
    ? deriveStructuresEnabledFromDisabled(
        persisted.structures.disabled,
        regionStructures,
        initialActive,
      )
    : initialStructuresEnabled(regionStructures, initialActive);

  // ── metastorageRouteModes (deviations-only; absence = "auto" for
  //    every capable source — the loader's capability filter already
  //    dropped stale entries)
  const metastorageRouteModes = new Map<DomainId, "disabled" | DomainId>();
  if (persisted?.metastorage) {
    for (const r of persisted.metastorage.routes) {
      metastorageRouteModes.set(r.source, r.mode);
    }
  }

  return {
    inactiveDomains,
    researched,
    capOverrides,
    currentDomain,
    rawLimitOverrides,
    structuresEnabled,
    metastorageRouteModes,
  };
}

/**
 * The canonical first-run default shape — the baseline the shared-plan
 * codec diffs against, so a default user's link carries an (almost)
 * empty settings blob. Computed once from static game data.
 */
export const DEFAULT_PERSISTED_SHAPE: PersistedShape = stateToPersistedShape(
  composeStateFromShape(null),
);

/**
 * Normalize an (already-sanitized) shape to canonical, deterministically
 * -ordered form by round-tripping through the compose→persist pair. Two
 * shapes are "the same settings" iff their canonical JSON matches — used
 * by the codec's shared-vs-own comparison and its delta encoding.
 */
export function canonicalizeShape(shape: PersistedShape): PersistedShape {
  return stateToPersistedShape(composeStateFromShape(shape));
}

/**
 * Optional shared-plan seed. When present, the hook initializes from
 * this snapshot instead of localStorage and enters read-only mode:
 * persistence is suppressed so the viewer's own settings are never
 * overwritten while they view someone else's plan. The provider passes
 * this ONLY when the URL snapshot genuinely differs from the viewer's
 * own settings (identical settings → normal editable mode).
 */
export interface SharedPlanInit {
  shape: PersistedShape;
}

export function useDomainSettings(
  sharedInit?: SharedPlanInit,
): DomainSettingsValue {
  // Compose all initial state from a single persisted snapshot — the
  // shared-plan snapshot when viewing someone else's link, otherwise
  // the viewer's own localStorage. The closure captures `initial` for
  // the duration of the mount; the useState calls below read from it
  // without re-invoking the loader.
  const initial = useMemo(
    () => composeStateFromShape(sharedInit?.shape ?? loadPersistedShape()),
    // Mount-only: `sharedInit` is a stable value the provider resolves
    // once from the URL. Runtime transitions go through the explicit
    // import/exit actions below, not a re-seed on dependency change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Read-only "viewing a shared plan" mode. True while the hook is
  // seeded from a shared snapshot that differs from the viewer's own
  // settings; gates persistence so localStorage is never overwritten.
  // Cleared by `importSharedPlan` / `exitSharedPlan`.
  const [readOnly, setReadOnly] = useState<boolean>(() => !!sharedInit);

  const [inactiveDomains, setInactiveDomains] = useState<
    ReadonlySet<DomainId>
  >(initial.inactiveDomains);

  const [researched, setResearched] = useState<ReadonlySet<AicTechId>>(
    initial.researched,
  );

  const [capOverrides, setCapOverrides] = useState<ReadonlyMap<string, number>>(
    initial.capOverrides,
  );

  const [currentDomain, setCurrentDomainState] = useState<DomainId>(
    initial.currentDomain,
  );

  const [rawLimitOverrides, setRawLimitOverrides] = useState<
    ReadonlyMap<string, number>
  >(initial.rawLimitOverrides);

  const [structuresEnabled, setStructuresEnabled] = useState<
    ReadonlySet<string>
  >(initial.structuresEnabled);

  const [metastorageRouteModes, setMetastorageRouteModes] = useState<
    ReadonlyMap<DomainId, "disabled" | DomainId>
  >(initial.metastorageRouteModes);

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
    // Shared-view (read-only): never write the viewer's localStorage.
    // `importSharedPlan` flips `readOnly` off, which re-fires this
    // effect and persists the (now adopted) snapshot as the viewer's own.
    if (readOnly) return;
    persistToStorage({
      researched,
      inactiveDomains,
      capOverrides,
      currentDomain,
      rawLimitOverrides,
      structuresEnabled,
      metastorageRouteModes,
    });
  }, [
    readOnly,
    researched,
    inactiveDomains,
    capOverrides,
    currentDomain,
    rawLimitOverrides,
    structuresEnabled,
    metastorageRouteModes,
  ]);

  // The viewer's current settings as a persisted (deviations-only)
  // shape. Threaded to `useProductionPlan` to (a) embed in the shared
  // URL's `s=` blob and (b) save into downloaded plan files. Memoized
  // so it only changes when a setting actually changes.
  const currentShape = useMemo(
    () =>
      stateToPersistedShape({
        researched,
        inactiveDomains,
        capOverrides,
        currentDomain,
        rawLimitOverrides,
        structuresEnabled,
        metastorageRouteModes,
      }),
    [
      researched,
      inactiveDomains,
      capOverrides,
      currentDomain,
      rawLimitOverrides,
      structuresEnabled,
      metastorageRouteModes,
    ],
  );

  // Adopt the shared snapshot as the viewer's own: flip out of
  // read-only so the persist effect writes the current (snapshot) state
  // to localStorage. Destructive to prior settings — the banner
  // confirms before calling.
  //
  // Also mark onboarding as seen: adopting a shared plan's settings is a
  // deliberate configuration choice, so a never-onboarded viewer must
  // NOT get the first-visit dialog afterward — it would override the
  // just-imported settings with the all-checked default. Set the flag
  // before flipping `readOnly` so the dialog (mounted once shared-view
  // ends) reads it as already-seen and stays closed.
  const importSharedPlan = useCallback(() => {
    markOnboardingSeen();
    setReadOnly(false);
  }, []);

  // Discard the shared snapshot and restore the viewer's own settings
  // from localStorage. Re-seeds all seven atoms in one batch, then
  // leaves read-only; the plan re-solves against the viewer's own world.
  const exitSharedPlan = useCallback(() => {
    const own = composeStateFromShape(loadPersistedShape());
    setInactiveDomains(own.inactiveDomains);
    setResearched(own.researched);
    setCapOverrides(own.capOverrides);
    setCurrentDomainState(own.currentDomain);
    setRawLimitOverrides(own.rawLimitOverrides);
    setStructuresEnabled(own.structuresEnabled);
    setMetastorageRouteModes(own.metastorageRouteModes);
    setReadOnly(false);
  }, []);

  // Per-setting diff of the shared snapshot (the live read-only atoms)
  // vs the viewer's OWN localStorage settings. `null` in normal mode.
  // Drives the read-only shared-view accents so the opener can see
  // exactly which settings the sharer changed. localStorage isn't
  // written in shared-view, so `own` is stable across the session.
  const sharedDiff = useMemo<SharedSettingsDiff | null>(() => {
    if (!readOnly) return null;
    const own = composeStateFromShape(loadPersistedShape());
    return diffSettings(
      {
        inactiveDomains,
        researched,
        capOverrides,
        currentDomain,
        rawLimitOverrides,
        structuresEnabled,
        metastorageRouteModes,
      },
      own,
    );
  }, [
    readOnly,
    inactiveDomains,
    researched,
    capOverrides,
    currentDomain,
    rawLimitOverrides,
    structuresEnabled,
    metastorageRouteModes,
  ]);

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

  // Mirror `readOnly` into a ref so the event-handler mutators below can
  // short-circuit in shared-view without re-creating their stable
  // `useCallback` identities. Belt-and-suspenders with the persist gate
  // (which already protects localStorage): NO settings mutation reaches
  // state while viewing a shared plan, via any call path.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // Node index for O(1) lookup in mutators.
  const nodeIndex = useMemo(() => buildNodeIndex(aicNodes), []);

  const toggleDomain = useCallback((id: DomainId) => {
    if (readOnlyRef.current) return;
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

  const setCurrentDomain = useCallback(
    (id: DomainId) => {
      if (readOnlyRef.current) return;
      setCurrentDomainState((prev) => {
        if (prev === id) return prev;
        // Validate that the target is a known domain AND is currently
        // active. The picker UI only exposes active regions, but a
        // stale call (e.g. concurrent toggle that just deactivated
        // `id`, or a programmatic caller that bypasses the UI) could
        // land here. Silently keep the previous value rather than
        // breaking the `currentDomain ∈ activeDomains` invariant —
        // App.tsx's `regionRawMaterials.get(currentDomain)!` and the
        // `Facility.domains` filter both rely on this.
        const domain = domainData.find((d) => d.id === id);
        if (!domain) return prev;
        if (inactiveDomains.has(id)) return prev;
        return id;
      });
    },
    [inactiveDomains],
  );

  /**
   * First-visit onboarding bulk-apply. See `DomainSettingsValue
   * .applyOnboardingChoices` for semantics. Touches inactive-domains,
   * researched-nodes, structures-enabled, and currentDomain in four
   * setter calls; React batches them so the persist effect fires once.
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
      if (readOnlyRef.current) return;
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

      // Structures mirror the researched semantics: checked domain →
      // every structure enabled; unchecked → none enabled. There's no
      // `alreadyUnlocked` equivalent for structures (no game default
      // forces any to be on), so unchecked simply means "empty".
      setStructuresEnabled(
        initialStructuresEnabled(regionStructures, nextActive),
      );

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
      if (readOnlyRef.current) return;
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
    if (readOnlyRef.current) return;
    setResearched((prev) => {
      const targets = aicNodes
        .filter((n) => n.layerId === layerId)
        .map((n) => n.id);
      if (targets.length === 0) return prev;
      return cascadeActivate(targets, prev, aicNodes);
    });
  }, []);

  const activateGroup = useCallback((groupId: AicGroupId) => {
    if (readOnlyRef.current) return;
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
    if (readOnlyRef.current) return;
    setResearched((prev) => {
      if (ids.length === 0) return prev;
      return cascadeActivate(ids, prev, aicNodes);
    });
  }, []);

  /**
   * Generic node deactivator — cascades over the given ids and their
   * transitive dependents in a single pure pass (see `cascadeDeactivate`).
   * Atomic: avoids the re-activation bug that looping single-node
   * `toggleNode` calls would hit on a cap-raise chain. Used by the
   * Facility Limits per-building "Reset to base limit" action.
   */
  const deactivateNodes = useCallback((ids: readonly AicTechId[]) => {
    if (readOnlyRef.current) return;
    setResearched((prev) => {
      if (ids.length === 0) return prev;
      return cascadeDeactivate(ids, prev, aicNodes);
    });
  }, []);

  /**
   * Per-plan Reset: for nodes in this group, set researched-state to
   * `node.alreadyUnlocked`. Other groups untouched.
   */
  const resetGroupToDefaults = useCallback((groupId: AicGroupId) => {
    if (readOnlyRef.current) return;
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
      if (readOnlyRef.current) return;
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

  const setRawLimitOverride = useCallback(
    (itemId: ItemId, domainId: DomainId, value: number | null) => {
      if (readOnlyRef.current) return;
      setRawLimitOverrides((prev) => {
        const next = new Map(prev);
        const key = rawLimitKey(itemId, domainId);
        // Reject null, non-finite (NaN / Infinity), and negative values.
        // The UI also rejects these at input time; this is the hook-
        // layer safety net so any caller (URL load, programmatic set,
        // etc.) hits the same gate.
        if (value === null || !Number.isFinite(value) || value < 0) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        return next;
      });
    },
    [],
  );

  /**
   * Toggle one region structure (opt-in), enforcing the prereq chain via
   * `cascadeStructureChain`: enabling pulls in prereqs, disabling drops
   * dependents. No-op for unknown (domain, structure) pairs.
   */
  const toggleStructure = useCallback(
    (domainId: DomainId, structureId: RegionStructureId) => {
      if (readOnlyRef.current) return;
      const structures = regionStructures.get(domainId);
      if (!structures || !structures.some((s) => s.id === structureId)) return;
      setStructuresEnabled((prev) => {
        const domainEnabled = new Set<RegionStructureId>();
        for (const s of structures) {
          if (prev.has(structureKey(domainId, s.id))) domainEnabled.add(s.id);
        }
        const nextDomainEnabled = cascadeStructureChain(
          structures,
          domainEnabled,
          structureId,
        );
        // Clear this domain's keys, then re-add the cascaded enabled set.
        const next = new Set(prev);
        for (const s of structures) next.delete(structureKey(domainId, s.id));
        for (const id of nextDomainEnabled) {
          next.add(structureKey(domainId, id));
        }
        return next;
      });
    },
    [],
  );

  /**
   * Set a source region's Metastorage route mode. The in-memory map
   * stores only deviations from the `"auto"` default, so `"auto"`
   * deletes the entry. Validation mirrors the loader: source must have
   * Metastorage capability; a locked destination must be a known
   * domain different from the source.
   */
  const setMetastorageRouteMode = useCallback(
    (source: DomainId, mode: MetastorageRouteMode) => {
      if (readOnlyRef.current) return;
      if (!metastorageSources.has(source)) return;
      if (mode !== "auto" && mode !== "disabled") {
        if (mode === source) return;
        if (!domainData.some((d) => d.id === mode)) return;
      }
      setMetastorageRouteModes((prev) => {
        const next = new Map(prev);
        if (mode === "auto") next.delete(source);
        else next.set(source, mode);
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
      deactivateNodes,
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
      deactivateNodes,
      resetGroupToDefaults,
      setCapOverride,
    ],
  );

  const rawLimits: RawLimitsSubState = useMemo(
    () => ({
      overrides: rawLimitOverrides,
      setRawLimitOverride,
    }),
    [rawLimitOverrides, setRawLimitOverride],
  );

  const structures: StructuresSubState = useMemo(
    () => ({
      enabled: structuresEnabled,
      toggle: toggleStructure,
    }),
    [structuresEnabled, toggleStructure],
  );

  const metastorage: MetastorageSubState = useMemo(() => {
    // Materialize a mode for every capable source so consumers never
    // need the "absent = auto" rule.
    const routeModes = new Map<DomainId, MetastorageRouteMode>();
    for (const source of metastorageSources.keys()) {
      routeModes.set(source, metastorageRouteModes.get(source) ?? "auto");
    }
    return { routeModes, setRouteMode: setMetastorageRouteMode };
  }, [metastorageRouteModes, setMetastorageRouteMode]);

  return {
    domains: domainData,
    activeDomains,
    toggleDomain,
    applyOnboardingChoices,
    currentDomain,
    setCurrentDomain,
    aic,
    rawLimits,
    structures,
    metastorage,
    isSharedView: readOnly,
    currentShape,
    sharedDiff,
    importSharedPlan,
    exitSharedPlan,
  };
}
