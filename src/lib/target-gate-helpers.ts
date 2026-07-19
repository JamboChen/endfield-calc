/**
 * Target-gate derivation + runtime resolution.
 *
 * `computeTargetGatesForRegion` is the derivation: for a given factory
 * region and each item producible there when fully unlocked but NOT with
 * the bare-minimum (game-default) research, it records a valid set of AIC
 * techs to research, grouped by the plan region that contains them and
 * ordered earliest-first. It depends only on the factory region + the
 * committed `src/data` (never on live research/roster), so the App layer
 * memoizes it on `currentDomain` alone and recomputes only on a region
 * switch. This runtime-per-region derivation replaced an ahead-of-time
 * generated map: the data it reads is already in the bundle, so
 * serializing the result bought nothing but a drift-guard burden.
 *
 * `resolveGateAction` is the per-interaction read: given a region's gate +
 * the current factory region + live research/roster state, it returns the
 * earliest plan region that still has unresearched techs — the region to
 * open in Settings + the tech nodes to flash. Pure; no data imports.
 *
 * # Model
 *
 * Reachability is per-`currentDomain` (a single factory region's raws +
 * region-available recipes). So a "locked" target is one the player could
 * make in their current factory region if the right techs were researched
 * — purely a tech gap. Items that need another region's raws aren't gated
 * here (they're hidden, not greyed). There is deliberately no
 * region-activation / factory-switch dimension.
 *
 * During the factory region's maximal-unlock reachability fixpoint we
 * record every item's first justifying recipe (grounded in that region's
 * raws → acyclic → the backward walk terminates). The walk stops at items
 * already producible with default research (they need no unlock), yielding
 * a tight, always-sufficient tech set. Techs are grouped by the region
 * whose AIC plan contains them (which may differ from the factory region
 * for facilities placeable anywhere).
 */
import {
  recipes,
  facilities,
  items,
  rawAvailabilityByDomain,
  bootstrapFacilities,
} from "@/data";
import { aicNodes, aicGroups, domains } from "@/data/aic-plans";
import {
  computeUnlockedFacilities,
  computeUnlockedModes,
  computeRecipeAvailability,
  RECIPE_MODE_BY_ID,
} from "@/lib/aic-research-helpers";
import type { AicGroupId, AicNode, AicTechId } from "@/types/aic";
import type { DomainId } from "@/types/domain";
import type { Facility, FacilityId, ItemId, Recipe, RecipeId } from "@/types";
import type {
  TargetGate,
  TargetGateFactory,
  TargetGatePlanRegion,
} from "@/types/target-gates";

/** The earliest plan region + techs to flash for a locked target. */
export type GateAction = { domainId: DomainId; techIds: AicTechId[] };

/**
 * Resolve a locked target's gate against the live state: the earliest
 * plan region (by `sortId`) that still has unresearched techs, or `null`
 * when the item isn't a resolvable in-factory tech gap.
 *
 * Returns `null` unless there's an entry for the current factory region
 * AND every plan region with missing techs is active (so its checkboxes
 * are actually reachable) — an item needing an inactive region's tech
 * isn't a clean "make it here" case and shouldn't have been greyed.
 */
export function resolveGateAction(
  gate: TargetGate,
  currentDomain: DomainId,
  activeDomains: ReadonlySet<DomainId>,
  researched: ReadonlySet<AicTechId>,
): GateAction | null {
  const entry = gate.factories.find((f) => f.factoryDomainId === currentDomain);
  if (!entry) return null;
  const blocking = entry.planRegions.filter((pr) =>
    pr.techIds.some((t) => !researched.has(t)),
  );
  if (blocking.length === 0) return null;
  // A required plan region that isn't in the roster can't be researched
  // here → not a clean in-factory tech gap.
  if (blocking.some((pr) => !activeDomains.has(pr.domainId))) return null;
  const first = blocking[0]; // planRegions are pre-sorted earliest-first
  return {
    domainId: first.domainId,
    techIds: first.techIds.filter((t) => !researched.has(t)),
  };
}

/* ── Derivation (build-time; not called at runtime) ── */

const FACILITY_BY_ID: ReadonlyMap<FacilityId, Facility> = new Map(
  facilities.map((f) => [f.id, f]),
);
const NODE_BY_ID: ReadonlyMap<AicTechId, AicNode> = new Map(
  aicNodes.map((n) => [n.id, n]),
);
const GROUP_DOMAIN: ReadonlyMap<AicGroupId, DomainId> = new Map(
  aicGroups.map((g) => [g.id, g.domainId]),
);

/** facility id → the `unlock` tech nodes that grant it (primary or bundled). */
const UNLOCK_TECHS_BY_FACILITY: ReadonlyMap<FacilityId, readonly AicTechId[]> =
  (() => {
    const m = new Map<FacilityId, AicTechId[]>();
    for (const n of aicNodes) {
      if (n.action.kind !== "unlock") continue;
      for (const f of [n.action.facilityId, ...n.additionalFacilities]) {
        const arr = m.get(f) ?? [];
        arr.push(n.id);
        m.set(f, arr);
      }
    }
    return m;
  })();

/** `${facilityId}\0${modeName}` → the `modeUnlock` tech that opens it. */
const MODE_TECH_BY_KEY: ReadonlyMap<string, AicTechId> = (() => {
  const m = new Map<string, AicTechId>();
  for (const n of aicNodes) {
    if (n.action.kind !== "modeUnlock") continue;
    m.set(`${n.action.facilityId}\u0000${n.action.modeName}`, n.id);
  }
  return m;
})();

/**
 * Reachability fixpoint that additionally records each item's first
 * justifying recipe. Mirrors `computeRecipeReachability` (bootstrap pass +
 * input-closure fixpoint) but exposes the justifier map the gate walk
 * needs. Raws stay unjustified (they seed the closure).
 */
function reachabilityWithJustifiers(
  recipePool: readonly Recipe[],
  rawMaterials: ReadonlySet<ItemId>,
  bootstrap: ReadonlySet<FacilityId>,
): { reachable: Set<ItemId>; justifier: Map<ItemId, Recipe> } {
  const reachable = new Set<ItemId>(rawMaterials);
  const justifier = new Map<ItemId, Recipe>();
  const runnable = new Set<RecipeId>();

  for (const r of recipePool) {
    if (!bootstrap.has(r.facilityId)) continue;
    runnable.add(r.id);
    for (const o of r.outputs) {
      if (!reachable.has(o.itemId)) {
        reachable.add(o.itemId);
        justifier.set(o.itemId, r);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const r of recipePool) {
      if (runnable.has(r.id)) continue;
      if (!r.inputs.every((i) => reachable.has(i.itemId))) continue;
      runnable.add(r.id);
      for (const o of r.outputs) {
        if (!reachable.has(o.itemId)) {
          reachable.add(o.itemId);
          justifier.set(o.itemId, r);
          changed = true;
        }
      }
    }
  }
  return { reachable, justifier };
}

/**
 * Reachable set + justifiers for a factory located in `factoryDomain`,
 * with the given research + roster. Mirrors the App layer: facility
 * unlocks gated by `activeDomains`, then region-filtered to the factory
 * region, raws taken from the factory region ONLY (no cross-region raws;
 * Metastorage is not modeled here).
 */
function reachableInFactory(
  factoryDomain: DomainId,
  researchedTechs: ReadonlySet<AicTechId>,
  activeDomains: ReadonlySet<DomainId>,
): { reachable: Set<ItemId>; justifier: Map<ItemId, Recipe> } {
  const unlockedFac = computeUnlockedFacilities(researchedTechs, activeDomains);
  const availFac = new Set<FacilityId>();
  for (const id of unlockedFac) {
    const f = FACILITY_BY_ID.get(id);
    if (!f) continue;
    if (f.domains.length === 0 || f.domains.includes(factoryDomain)) {
      availFac.add(id);
    }
  }
  const modes = computeUnlockedModes(researchedTechs, availFac);
  const availRecipes = computeRecipeAvailability(
    recipes,
    availFac,
    modes,
  ).availableRecipes;
  const rawMats = rawAvailabilityByDomain.get(factoryDomain) ?? new Set();
  return reachabilityWithJustifiers(availRecipes, rawMats, bootstrapFacilities);
}

/** Transitively collect a tech + its prereqs, skipping always-unlocked nodes. */
function collectTechClosure(techId: AicTechId, out: Set<AicTechId>): void {
  const node = NODE_BY_ID.get(techId);
  if (!node) return;
  if (node.alreadyUnlocked) return; // always-on: never a blocker
  if (out.has(techId)) return;
  out.add(techId);
  for (const pre of node.preNodes) collectTechClosure(pre, out);
}

/**
 * Derive the target-gate map for ONE factory region: item → the AIC-tech
 * requirements that gate it there, grouped by plan region and ordered
 * earliest-first. See the module JSDoc for the model.
 *
 * Pure and state-independent (uses the maximal-unlock and game-default
 * reference sets, never live research), so the App layer memoizes it on
 * `currentDomain` alone. Each emitted gate carries a single `factories`
 * entry (this region), preserving the `resolveGateAction` contract.
 */
export function computeTargetGatesForRegion(
  factoryDomain: DomainId,
): Map<ItemId, TargetGate> {
  const allDomains = new Set<DomainId>(domains.map((d) => d.id));
  const domainSortId = new Map<DomainId, number>(
    domains.map((d) => [d.id, d.sortId]),
  );
  const bySortId = (a: DomainId, b: DomainId) =>
    (domainSortId.get(a) ?? 0) - (domainSortId.get(b) ?? 0);

  const allTechs = new Set<AicTechId>(aicNodes.map((n) => n.id));
  const defaultTechs = new Set<AicTechId>(
    aicNodes.filter((n) => n.alreadyUnlocked).map((n) => n.id),
  );

  const producedItems = new Set<ItemId>();
  for (const r of recipes) for (const o of r.outputs) producedItems.add(o.itemId);

  // Maximal producibility here (everything researched, whole roster active)
  // vs. the bare-minimum default (only game-granted techs; a user can't
  // uncheck below this). Items reachable at the minimum are never lockable.
  const max = reachableInFactory(factoryDomain, allTechs, allDomains);
  const def = reachableInFactory(factoryDomain, defaultTechs, allDomains);

  const gates = new Map<ItemId, TargetGate>();

  for (const item of items) {
    if (item.asTarget === false) continue;
    if (!producedItems.has(item.id)) continue; // pure raw: not a target
    if (!max.reachable.has(item.id)) continue; // not makeable here
    if (def.reachable.has(item.id)) continue; // default-producible → never locked

    const techsByPlanRegion = new Map<DomainId, Set<AicTechId>>();
    const visited = new Set<ItemId>();

    const addTech = (techId: AicTechId) => {
      const closed = new Set<AicTechId>();
      collectTechClosure(techId, closed);
      for (const t of closed) {
        const dom = GROUP_DOMAIN.get(NODE_BY_ID.get(t)!.groupId);
        if (!dom) continue;
        let bucket = techsByPlanRegion.get(dom);
        if (!bucket) {
          bucket = new Set();
          techsByPlanRegion.set(dom, bucket);
        }
        bucket.add(t);
      }
    };

    const walk = (itemId: ItemId) => {
      if (visited.has(itemId)) return;
      visited.add(itemId);
      if (def.reachable.has(itemId)) return; // default-producible → no unlock
      const just = max.justifier.get(itemId);
      if (!just) return; // grounded as a (factory-region) raw seed
      const facTechs = UNLOCK_TECHS_BY_FACILITY.get(just.facilityId) ?? [];
      for (const t of facTechs) addTech(t);
      const mode = RECIPE_MODE_BY_ID.get(just.id) ?? "normal";
      if (mode !== "normal") {
        const modeTech = MODE_TECH_BY_KEY.get(`${just.facilityId}\u0000${mode}`);
        if (modeTech) addTech(modeTech);
      }
      for (const inp of just.inputs) walk(inp.itemId);
    };

    walk(item.id);
    if (techsByPlanRegion.size === 0) continue; // defensive

    const planRegions: TargetGatePlanRegion[] = [...techsByPlanRegion.entries()]
      .sort(([a], [b]) => bySortId(a, b))
      .map(([domainId, techs]) => ({ domainId, techIds: [...techs].sort() }));

    const factories: TargetGateFactory[] = [
      { factoryDomainId: factoryDomain, planRegions },
    ];
    gates.set(item.id, { factories });
  }

  return gates;
}
