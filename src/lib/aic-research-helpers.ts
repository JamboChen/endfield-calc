/**
 * Pure derivation helpers backing `useDomainSettings` (and the AIC
 * sub-state it composes).
 *
 * Split out from the hook file so they can be unit-tested without a DOM
 * environment. The hook composes these with React state, memoisation, and
 * localStorage I/O.
 */

import { aicGroups, aicNodes, facilityBaseCaps, recipesByTech } from "@/data/aic-plans";
import type { AicGroupId, AicNode, AicTechId, FacilityBaseCap } from "@/types/aic";
import type { DomainId } from "@/types/domain";
import type { Facility, FacilityId, Recipe, RecipeId } from "@/types";
import { FacilityId as FacilityIdEnum } from "@/types/constants";

/**
 * Facilities the AIC tree gates via an `unlock` action node. Built once
 * at module load — anything in `FacilityId` NOT in this set is implicitly
 * always-unlocked (e.g. `xiranite_oven_1`, whose upstream unlock node is
 * an action-type-0 placeholder filtered out by `extract:aic`).
 */
export const GATED_FACILITIES: ReadonlySet<FacilityId> = (() => {
  const out = new Set<FacilityId>();
  for (const node of aicNodes) {
    if (node.action.kind !== "unlock") continue;
    out.add(node.action.facilityId);
    for (const extra of node.additionalFacilities) out.add(extra);
  }
  return out;
})();

/**
 * Facilities always available regardless of research, precomputed at
 * module load from the `FacilityId` enum.
 */
export const ALWAYS_UNLOCKED_FACILITIES: ReadonlySet<FacilityId> = (() => {
  const out = new Set<FacilityId>();
  for (const id of Object.values(FacilityIdEnum)) {
    if (!GATED_FACILITIES.has(id)) out.add(id);
  }
  return out;
})();

/**
 * Stable key for `(facilityId, domainId)` cap-override map entries.
 * Uses a NUL delimiter no real id can contain.
 */
export function capKey(facilityId: FacilityId, domainId: DomainId): string {
  return `${facilityId}\u0000${domainId}`;
}

/**
 * Facilities the calc may use given the current research set, optionally
 * filtered by which domains are active.
 *
 * Unlocked iff:
 *   - it's in `ALWAYS_UNLOCKED_FACILITIES` (no unlock node gates it), or
 *   - a researched node has `action.kind === "unlock"` with the facility
 *     id in either `action.facilityId` or `additionalFacilities`, AND that
 *     node's domain is active (if `activeDomains` is provided).
 *
 * When `activeDomains` is `null` (default), no domain filtering is applied
 * — all researched-unlocks contribute. This matches the Step-1-without-
 * domain-toggle behaviour for callers that don't care about activation.
 *
 * Mode unlocks do NOT gate the facility itself — see `computeUnlockedModes`.
 */
export function computeUnlockedFacilities(
  researched: ReadonlySet<AicTechId>,
  activeDomains: ReadonlySet<DomainId> | null = null,
  nodes: readonly AicNode[] = aicNodes,
  groups: readonly { id: AicGroupId; domainId: DomainId }[] = aicGroups,
  alwaysUnlocked: ReadonlySet<FacilityId> = ALWAYS_UNLOCKED_FACILITIES,
): ReadonlySet<FacilityId> {
  // Build groupId → domainId index for O(1) lookup during the per-node scan.
  const groupDomain = new Map<AicGroupId, DomainId>();
  for (const g of groups) groupDomain.set(g.id, g.domainId);

  const out = new Set<FacilityId>(alwaysUnlocked);
  for (const node of nodes) {
    if (node.action.kind !== "unlock") continue;
    if (!researched.has(node.id)) continue;
    if (activeDomains !== null) {
      const domainId = groupDomain.get(node.groupId);
      if (domainId !== undefined && !activeDomains.has(domainId)) continue;
    }
    out.add(node.action.facilityId);
    for (const extra of node.additionalFacilities) out.add(extra);
  }
  return out;
}

/**
 * Per-array facility index cache. WeakMap keyed by the facilities
 * array reference; in production callers always pass the same
 * module-static `@/data` array, so the cache hits on every render.
 * Synthetic test arrays GC normally as their describes complete.
 */
const FACILITY_INDEX_CACHE = new WeakMap<
  readonly Facility[],
  ReadonlyMap<FacilityId, Facility>
>();

function getFacilityIndex(
  facilities: readonly Facility[],
): ReadonlyMap<FacilityId, Facility> {
  let idx = FACILITY_INDEX_CACHE.get(facilities);
  if (!idx) {
    idx = new Map(facilities.map((f) => [f.id, f] as const));
    FACILITY_INDEX_CACHE.set(facilities, idx);
  }
  return idx;
}

/**
 * Facilities currently available for placement given the AIC-unlock
 * set and the user's selected factory region (`currentDomain`).
 *
 * The intersection of two filters:
 *   - **AIC**: `unlockedFacilities` (already domain-aware via
 *     `computeUnlockedFacilities`'s `activeDomains` arg).
 *   - **Region**: `Facility.domains` is empty (placeable anywhere) OR
 *     includes `currentDomain` (region-restricted to a set that
 *     contains the player's current factory location).
 *
 * Pure. The intended call site is `App.tsx`'s `availableRecipes` memo,
 * which feeds the filtered set into `computeRecipeAvailability` so the
 * downstream calc / picker pipeline sees only region-appropriate
 * recipes. Facilities NOT in this set still exist in `facilities` and
 * remain visible in informational surfaces (e.g. the AIC tree, where
 * Wuling-only facilities still show their research state when planning
 * a Valley IV factory) — only recipe usability is gated.
 *
 * The `facilities → Map` index is WeakMap-cached per array reference,
 * so the prod call site (always `@/data`'s static export) builds the
 * Map exactly once for the app's lifetime.
 */
export function computeAvailableFacilities(
  unlockedFacilities: ReadonlySet<FacilityId>,
  facilities: readonly Facility[],
  currentDomain: DomainId,
): ReadonlySet<FacilityId> {
  const facilityById = getFacilityIndex(facilities);

  const out = new Set<FacilityId>();
  for (const id of unlockedFacilities) {
    const f = facilityById.get(id);
    if (!f) continue; // defensive: id without a Facility entry
    if (f.domains.length === 0 || f.domains.includes(currentDomain)) {
      out.add(id);
    }
  }
  return out;
}

/**
 * Per-plan default-equality check.
 *
 * Returns true iff every node in the given group satisfies
 * `researched.has(node.id) === node.alreadyUnlocked` — i.e. the group is
 * in exactly its game-default research state.
 *
 * Drives the Reset button visibility in `AicPlanCard`: when at defaults,
 * the Reset action is a no-op so its button hides.
 */
export function isGroupAtDefaults(
  groupId: AicGroupId,
  researched: ReadonlySet<AicTechId>,
  nodes: readonly AicNode[] = aicNodes,
): boolean {
  for (const node of nodes) {
    if (node.groupId !== groupId) continue;
    if (researched.has(node.id) !== node.alreadyUnlocked) return false;
  }
  return true;
}

/**
 * Per-facility set of mode names the player has researched.
 *
 * Recipes in `src/data/recipes.ts` belong to a single mode per facility
 * (the upstream `formulaGroupId` resolves to `<facility>_<mode>`). Step 2
 * will filter recipes by `unlockedModes` membership.
 *
 * The implicit `"normal"` mode is always included for unlocked facilities;
 * researched `modeUnlock` nodes contribute their mode (today only `"liquid"`).
 */
export function computeUnlockedModes(
  researched: ReadonlySet<AicTechId>,
  unlockedFacilities: ReadonlySet<FacilityId>,
  nodes: readonly AicNode[] = aicNodes,
): ReadonlyMap<FacilityId, ReadonlySet<string>> {
  const out = new Map<FacilityId, Set<string>>();
  for (const facilityId of unlockedFacilities) {
    out.set(facilityId, new Set(["normal"]));
  }
  for (const node of nodes) {
    if (node.action.kind !== "modeUnlock") continue;
    if (!researched.has(node.id)) continue;
    if (!unlockedFacilities.has(node.action.facilityId)) continue;
    let bucket = out.get(node.action.facilityId);
    if (!bucket) {
      bucket = new Set(["normal"]);
      out.set(node.action.facilityId, bucket);
    }
    bucket.add(node.action.modeName);
  }
  return out;
}

/**
 * Per-(facility, domain) effective placement cap = base + sum(researched
 * capRaise deltas) — overridden by `overrides` when present.
 *
 * Step 1: informational only (not enforced anywhere). Step 5 (future) would
 * thread these into the LP solver as placement constraints.
 *
 * Handles three classes of cap-bearing (facility, domain) pairs:
 *   - base cap from FactoryBuildingTable: starts at `base`, adds raises,
 *     applies override if set.
 *   - no base but has cap-raise techs: starts at 0, adds raises.
 *   - no base and no raise but user override: surfaced anyway (for users
 *     who pre-emptively set a cap on a facility the game hasn't capped yet).
 */
export function computeEffectiveCaps(
  researched: ReadonlySet<AicTechId>,
  overrides: ReadonlyMap<string, number>,
  nodes: readonly AicNode[] = aicNodes,
  baseCaps: readonly FacilityBaseCap[] = facilityBaseCaps,
): ReadonlyMap<FacilityId, ReadonlyMap<DomainId, number>> {
  const raiseDeltas = new Map<string, number>();
  for (const node of nodes) {
    if (node.action.kind !== "capRaise") continue;
    if (!researched.has(node.id)) continue;
    const key = capKey(node.action.facilityId, node.action.domainId);
    raiseDeltas.set(key, (raiseDeltas.get(key) ?? 0) + node.action.delta);
  }

  const perFacility = new Map<FacilityId, Map<DomainId, number>>();
  function set(facilityId: FacilityId, domainId: DomainId, value: number) {
    let inner = perFacility.get(facilityId);
    if (!inner) {
      inner = new Map();
      perFacility.set(facilityId, inner);
    }
    inner.set(domainId, value);
  }

  for (const base of baseCaps) {
    const key = capKey(base.facilityId, base.domainId);
    const effective = base.base + (raiseDeltas.get(key) ?? 0);
    const override = overrides.get(key);
    set(base.facilityId, base.domainId, override ?? effective);
  }

  for (const [key, delta] of raiseDeltas) {
    const [facilityId, domainId] = key.split("\u0000") as [
      FacilityId,
      DomainId,
    ];
    const inner = perFacility.get(facilityId);
    if (inner && inner.has(domainId)) continue;
    const override = overrides.get(key);
    set(facilityId, domainId, override ?? delta);
  }

  for (const [key, value] of overrides) {
    const [facilityId, domainId] = key.split("\u0000") as [
      FacilityId,
      DomainId,
    ];
    const inner = perFacility.get(facilityId);
    if (inner && inner.has(domainId)) continue;
    set(facilityId, domainId, value);
  }

  return perFacility;
}

/**
 * Recipe id → mode name lookup, built once at module load from
 * `recipesByTech` + `aicNodes[].action.modeName`.
 *
 * A recipe listed under a tech whose `action.kind === "modeUnlock"`
 * inherits that node's `modeName` (today only `"liquid"`). All other
 * recipes default to `"normal"`. The default applies to:
 *   - recipes listed under an `unlock` tech (facility-gated but
 *     always in the facility's normal mode)
 *   - recipes NOT in `recipesByTech` at all (always available; e.g.
 *     `xiranite_oven_xiranite_powder_1` whose facility has no unlock
 *     gate in the AIC tree)
 *
 * `RECIPE_MODE_BY_ID.get(recipeId) ?? "normal"` is the read pattern.
 */
export const RECIPE_MODE_BY_ID: ReadonlyMap<RecipeId, string> = (() => {
  const out = new Map<RecipeId, string>();
  for (const node of aicNodes) {
    if (node.action.kind !== "modeUnlock") continue;
    const recipes = recipesByTech.get(node.id);
    if (!recipes) continue;
    for (const rid of recipes) out.set(rid, node.action.modeName);
  }
  return out;
})();

/**
 * Filter the game-data recipe set down to those currently available
 * given the player's AIC research state.
 *
 * A recipe is available iff:
 *   - its host facility is in `unlockedFacilities`, AND
 *   - its mode (per `RECIPE_MODE_BY_ID`, defaulting to `"normal"`) is in
 *     `unlockedModes.get(facilityId)`.
 *
 * Returns the filtered list plus a diagnostic `gatedRecipeIds` set
 * (recipes that exist in `allRecipes` but were filtered out).
 *
 * # Why this lives at the App layer
 *
 * `calculateProductionPlan` operates on whatever recipe set it's given
 * — no AIC awareness inside the calc. Filtering at the App layer
 * (before the calc runs) keeps the algorithm code decoupled from the
 * settings UI and avoids threading `disabledFacilities` / `disabledModes`
 * down through `graph-builder` / `flow-solver` / `multi-formula-packing`.
 */
export function computeRecipeAvailability(
  allRecipes: readonly Recipe[],
  unlockedFacilities: ReadonlySet<FacilityId>,
  unlockedModes: ReadonlyMap<FacilityId, ReadonlySet<string>>,
): {
  availableRecipes: readonly Recipe[];
  gatedRecipeIds: ReadonlySet<RecipeId>;
} {
  const availableRecipes: Recipe[] = [];
  const gatedRecipeIds = new Set<RecipeId>();
  for (const r of allRecipes) {
    if (!unlockedFacilities.has(r.facilityId)) {
      gatedRecipeIds.add(r.id);
      continue;
    }
    const mode = RECIPE_MODE_BY_ID.get(r.id) ?? "normal";
    const modesForFacility = unlockedModes.get(r.facilityId);
    if (!modesForFacility || !modesForFacility.has(mode)) {
      gatedRecipeIds.add(r.id);
      continue;
    }
    availableRecipes.push(r);
  }
  return { availableRecipes, gatedRecipeIds };
}
