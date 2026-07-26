/**
 * Shared fixture for the read-only shared-view DOM tests: one settings
 * snapshot that reliably differs from the viewer's own, and the link that
 * carries it.
 *
 * The link is built with the PRODUCTION encoders rather than a
 * hand-written token, so these tests cannot drift from the codec — a hash
 * format change is picked up automatically instead of silently testing a
 * format the app no longer emits.
 */
import { items } from "@/data";
import { aicNodes, domains, facilityBaseCaps } from "@/data/aic-plans";
import { type PersistedShape } from "@/lib/persisted-shape";
import { DEFAULT_PLAN_OPTIONS } from "@/lib/plan-options-storage";
import { encodeSettingsSnapshot } from "@/lib/plan-share-codec";
import { encodeHashToken, serializeHash } from "@/lib/plan-url";

/**
 * The localStorage keys these tests assert on, spelled out rather than
 * imported: they are a persistence CONTRACT with every existing browser,
 * so a rename is a migration and should break a test loudly rather than
 * quietly follow along.
 */
export const AIC_STORAGE_KEY = "endfield-calc:aic-v1";
export const ONBOARDING_STORAGE_KEY = "endfield-calc:onboarding-v1";

/**
 * Any real item. The hash needs at least one target — `serializeHash`
 * emits "" for a target-less plan — and no test cares which item it is.
 */
export const SOME_ITEM_ID = items[0].id;

/**
 * A real capped (facility, region) pair. It must be real: a shared link's
 * cap overrides are validated against the live game data on the way in,
 * so an invented pair would be dropped, the snapshot would collapse back
 * to the default, and shared-view would never engage — silently defeating
 * every test that depends on it.
 */
export const CAP_TARGET = facilityBaseCaps[0];
export const CAP_KEY = `${CAP_TARGET.facilityId}\u0000${CAP_TARGET.domainId}`;
export const SHARED_CAP_VALUE = 7;

/** The always-active region, and the one that is inactive by default. */
export const PINNED_DOMAIN = domains.filter((d) => d.isPinned)[0].id;
export const UNPINNED_DOMAIN = domains.filter((d) => !d.isPinned)[0].id;

/**
 * The sharer's settings: a late-game player with everything unlocked and
 * both regions active, minus the cap-raise techs, plus one cap override.
 *
 * Every clause is load-bearing for making the mutator probes NON-VACUOUS,
 * which is the hard part of testing a guard: a call the hook would refuse
 * anyway proves nothing about whether the guard is there.
 *
 *   - `inactive: []` — both regions active, so `toggleDomain` and
 *     `setCurrentDomain` have somewhere to go. Under the first-run default
 *     the second region is inactive, which makes `setCurrentDomain` refuse
 *     it and `toggleNode` refuse its techs for unmet prereqs.
 *   - `current` pinned — so switching to the other region is a change.
 *   - `unresearched` = the cap-raise techs only — everything else is
 *     researched, giving `toggleNode` a node it will actually deactivate,
 *     while leaving the per-card "Activate all" action something to do
 *     (asserting on a button that would be absent anyway proves nothing).
 *   - one cap override — the per-card "Reset to base limit" action, and a
 *     value the read-only tests can watch for tampering.
 *
 * It also differs from `DEFAULT_PERSISTED_SHAPE` several ways over, which
 * is what makes `shapesEqual` false and puts the provider into read-only
 * shared-view in the first place.
 */
export const SHARED_SHAPE: PersistedShape = {
  domains: { inactive: [], current: PINNED_DOMAIN },
  aic: {
    unresearched: aicNodes
      .filter((n) => n.action.kind === "capRaise")
      .map((n) => n.id),
    capOverrides: [
      {
        facilityId: CAP_TARGET.facilityId,
        domainId: CAP_TARGET.domainId,
        value: SHARED_CAP_VALUE,
      },
    ],
  },
};

/** Put a shareable link for `shape` in the address bar, as a paste would. */
export function seedShareLink(shape: PersistedShape): void {
  const hash = serializeHash(
    {
      targets: [{ itemId: SOME_ITEM_ID, rate: 1 }],
      recipeOverrides: new Map(),
      manualRawMaterials: new Set(),
      ...DEFAULT_PLAN_OPTIONS,
    },
    encodeSettingsSnapshot(shape),
  );
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}#${encodeHashToken(hash)}`,
  );
}
