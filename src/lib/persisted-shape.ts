/**
 * The persisted settings shape — the on-disk / in-URL form of a user's
 * domain settings, and every pure function that produces, validates or
 * normalizes it.
 *
 * Lives here rather than in `useDomainSettings` because three consumers
 * need it and only one of them is a hook: the hook itself seeds React
 * state from it, `plan-share-codec.ts` encodes it into shared links, and
 * saved plan files embed it. A `lib/` module importing a hook to reach
 * this logic was the wrong way round.
 *
 * # The shape
 *
 * A **deviations-only** record: it stores what the user changed, not the
 * full world. AIC research and map structures are stored inverted (the
 * *unresearched* / *disabled* lists) so that content added by a game
 * update is enabled by default rather than silently missing.
 *
 * # The single validation path
 *
 * `sanitizePersistedShape` is the ONLY way a payload becomes a
 * `PersistedShape`, whatever the channel — localStorage, a shared link,
 * a saved file. Every id is checked against the live game data and
 * anything unknown is dropped, so a stale or hand-edited payload
 * degrades instead of reaching the solver. It is also the trust boundary
 * for URL content, which is why it is tested directly against hostile
 * input (`persisted-shape.test.ts`).
 */

import { aicGroups, aicNodes, domains as domainData } from "@/data/aic-plans";
import {
  facilities,
  metastorageSources,
  rawAvailabilityByDomain,
  regionStructures,
} from "@/data";
import { capKey } from "@/lib/aic-research-helpers";
import { parseRawLimitKey, rawLimitKey } from "@/lib/raw-limits-helpers";
import {
  deriveStructuresEnabledFromDisabled,
  initialStructuresEnabled,
  structureKey,
  structuresDisabledFromEnabled,
} from "@/lib/settings-helpers";
import { namespaceStorageKey } from "@/lib/storage-namespace";
import type { AicGroupId, AicTechId } from "@/types/aic";
import { isDomainId, parseDomainId } from "@/types/domain";
import type { DomainId } from "@/types/domain";
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
export const NODE_DOMAIN_BY_GROUP: ReadonlyMap<AicGroupId, DomainId> = (() => {
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
    // Facility-cap overrides. Validated against the live facility
    // registry like every other category: a cap for an unknown facility
    // is unusable, and it would otherwise linger as a phantom entry that
    // `diffSettings` reports as a permanently "changed" setting (which
    // can force read-only shared-view on its own). Negative caps are
    // dropped too — a cap is a physical building count, and only the
    // URL/localStorage channels can produce one, since the setter can't.
    const knownFacilityIds = new Set<string>(facilities.map((f) => f.id));
    const capOverrides = shape.aic.capOverrides.filter(
      (c): c is CapOverrideRecord =>
        c !== null &&
        typeof c === "object" &&
        typeof c.facilityId === "string" &&
        knownFacilityIds.has(c.facilityId) &&
        typeof c.domainId === "string" &&
        isDomainId(c.domainId) &&
        typeof c.value === "number" &&
        Number.isFinite(c.value) &&
        c.value >= 0,
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

export interface PersistableState {
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
export function stateToPersistedShape(state: PersistableState): PersistedShape {
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

export function persistToStorage(state: PersistableState): void {
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
export interface ComposedState {
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
export function composeStateFromShape(persisted: PersistedShape | null): ComposedState {
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