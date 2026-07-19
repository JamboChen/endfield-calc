/**
 * Target-gate model — "which AIC techs must a player research before item
 * X becomes producible *in a given factory region*?"
 *
 * The Add-Target picker greys out items that a player COULD make in their
 * current factory region (`currentDomain`) but currently can't, because a
 * required AIC tech is unresearched. Items that can't be made in the
 * current factory region at all (they need another region's raws) are not
 * greyed — they stay hidden, as before. So a gate is purely a per-region
 * *tech* requirement; there is no region-activation or factory-switch
 * dimension (reachability is per-`currentDomain`, and activating a region
 * in the roster does not bring its raws into another region's factory).
 *
 * The map is derived at runtime, per factory region, by
 * `computeTargetGatesForRegion` (`src/lib/target-gate-helpers.ts`) from
 * committed `src/data` — no game-data dir. The App layer memoizes it on
 * `currentDomain`; `resolveGateAction` then reads the entry for the
 * current factory region and returns the earliest plan-region with
 * unresearched techs, which drives the settings-sheet navigation + flash.
 *
 * "A valid unlocking set", not a provably minimal one: the derivation
 * follows the shallowest-discovered producer chain in the factory region
 * (see `computeTargetGatesForRegion`).
 */
import type { AicTechId } from "./aic";
import type { DomainId } from "./domain";

/**
 * Techs from ONE AIC plan region that contribute to producing a target.
 * `domainId` is the plan's region (where the checkboxes live + get
 * flashed); `techIds` are prereq-closed and omit `alreadyUnlocked`
 * ancestors. Techs can come from a region other than the factory region
 * (facilities placeable anywhere but unlocked by another region's plan).
 */
type TargetGatePlanRegion = {
  readonly domainId: DomainId;
  readonly techIds: readonly AicTechId[];
};

/**
 * The tech requirement to produce a target while a specific region is the
 * player's factory (`currentDomain === factoryDomainId`). `planRegions`
 * are ordered by region `sortId` ascending (earliest first), matching the
 * "open the earliest blocking region" navigation rule.
 *
 * Only present for factory regions where the item is producible when
 * fully unlocked AND needs ≥1 non-default tech there — factory regions
 * where it's producible by default (never lockable) or not producible at
 * all are omitted.
 */
type TargetGateFactory = {
  readonly factoryDomainId: DomainId;
  readonly planRegions: readonly TargetGatePlanRegion[];
};

/**
 * A target's per-factory-region gate. `factories` is ordered by region
 * `sortId`. An item with no entry for the current factory region is not a
 * tech-gap there (either default-producible or not makeable at all) and
 * is not greyed.
 */
type TargetGate = {
  readonly factories: readonly TargetGateFactory[];
};

export type { TargetGate, TargetGateFactory, TargetGatePlanRegion };
