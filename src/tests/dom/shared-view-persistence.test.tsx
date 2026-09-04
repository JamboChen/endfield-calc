/**
 * Read-only shared-view: the persistence gate and the two exits.
 *
 * The core promise of a shared plan link is "the viewer's localStorage is
 * never written while they are looking at someone else's settings". Until
 * this file that promise was enforced only by inspection — every mutator
 * in `useDomainSettings` early-returns on `readOnlyRef`, and the persist
 * effect returns on `readOnly` — with nothing to catch a mutator added
 * without the guard.
 *
 * The tests drive the real seam: a URL is built with the production
 * encoders (see `shared-plan-fixture.ts`), `DomainSettingsProvider`
 * resolves it at mount, and the assertions run against the context value
 * the whole app consumes.
 */
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { metastorageSources, regionStructures } from "@/data";
import { DEFAULT_PERSISTED_SHAPE } from "@/lib/persisted-shape";

import { renderProvider } from "./render-settings";
import {
  AIC_STORAGE_KEY,
  CAP_KEY,
  CAP_TARGET,
  ONBOARDING_STORAGE_KEY,
  PINNED_DOMAIN,
  SHARED_CAP_VALUE,
  SHARED_SHAPE,
  SOME_ITEM_ID,
  UNPINNED_DOMAIN,
  seedShareLink,
} from "./shared-plan-fixture";

describe("read-only shared-view", () => {
  it("enters shared-view for a link whose settings differ from the viewer's", () => {
    seedShareLink(SHARED_SHAPE);

    const handle = renderProvider();

    expect(handle.value.isSharedView).toBe(true);
    // The sharer's snapshot is what the app computes against.
    expect(handle.value.aic.capOverrides.get(CAP_KEY)).toBe(SHARED_CAP_VALUE);
  });

  it("stays editable when the link's settings match the viewer's own", () => {
    // No stored settings + a link built from the default shape is the
    // "two default users" case `resolveSharedInit` must let through.
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    seedShareLink(DEFAULT_PERSISTED_SHAPE);

    const handle = renderProvider();

    expect(handle.value.isSharedView).toBe(false);
  });

  it("never writes the viewer's localStorage while in shared-view", () => {
    seedShareLink(SHARED_SHAPE);
    const handle = renderProvider();
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    const [structureDomain, structureList] = [...regionStructures.entries()][0];
    const structureKey = `${structureDomain}\u0000${structureList[0].id}`;
    const metastorageSource = [...metastorageSources.keys()][0];

    // A tech the hook would ACTUALLY deactivate: researched, not a
    // cap-raise (those are unresearched in the fixture) and not
    // `alreadyUnlocked` (the cascade preserves those). Without this, a
    // call the hook refuses on its own merits would pass the test with the
    // guard deleted.
    const toggleable = handle.value.aic.nodes.find(
      (n) =>
        n.action.kind !== "capRaise" &&
        !n.alreadyUnlocked &&
        handle.value.aic.researched.has(n.id),
    );
    if (!toggleable) {
      throw new Error("fixture: expected a researched, deactivatable tech");
    }

    // Preconditions that make each call below a real state change.
    expect(handle.value.currentDomain).toBe(PINNED_DOMAIN);
    expect(handle.value.activeDomains.has(UNPINNED_DOMAIN)).toBe(true);
    expect(handle.value.structures.enabled.has(structureKey)).toBe(true);
    expect(handle.value.metastorage.routeModes.get(metastorageSource)).not.toBe(
      "disabled",
    );

    // One call per settings category, so a category whose mutator loses
    // its `readOnlyRef` guard is caught here rather than in review.
    act(() => {
      handle.value.aic.setCapOverride(
        CAP_TARGET.facilityId,
        CAP_TARGET.domainId,
        99,
      );
      handle.value.aic.toggleNode(toggleable.id);
      handle.value.rawLimits.setRawLimitOverride(
        SOME_ITEM_ID,
        CAP_TARGET.domainId,
        42,
      );
      handle.value.structures.toggle(structureDomain, structureList[0].id);
      handle.value.metastorage.setRouteMode(metastorageSource, "disabled");
      handle.value.toggleDomain(UNPINNED_DOMAIN);
      handle.value.setCurrentDomain(UNPINNED_DOMAIN);
    });

    // The invariant, scoped to the app's own namespace: not one key.
    const written = setItem.mock.calls
      .map(([key]) => String(key))
      .filter((key) => key.startsWith("endfield-calc:"));
    expect(written).toEqual([]);

    // And the snapshot is untouched — the guards reject each edit rather
    // than applying it in memory and merely skipping the write.
    expect(handle.value.aic.capOverrides.get(CAP_KEY)).toBe(SHARED_CAP_VALUE);
    expect(handle.value.aic.researched.has(toggleable.id)).toBe(true);
    expect(handle.value.rawLimits.overrides.size).toBe(0);
    expect(handle.value.structures.enabled.has(structureKey)).toBe(true);
    expect(handle.value.metastorage.routeModes.get(metastorageSource)).not.toBe(
      "disabled",
    );
    expect(handle.value.currentDomain).toBe(PINNED_DOMAIN);
    expect(handle.value.activeDomains.has(UNPINNED_DOMAIN)).toBe(true);
    expect(handle.value.isSharedView).toBe(true);
  });

  it("does write for the same edit outside shared-view (control)", () => {
    // Guards the test above against two ways of passing for the wrong
    // reason: a harness that mutates nothing at all writes nothing, and a
    // `Storage.prototype` spy that fails to intercept jsdom's storage
    // records nothing. Same spy, same edit, opposite expectation.
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    const handle = renderProvider();
    expect(handle.value.isSharedView).toBe(false);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    act(() => {
      handle.value.aic.setCapOverride(
        CAP_TARGET.facilityId,
        CAP_TARGET.domainId,
        99,
      );
    });

    const written = setItem.mock.calls
      .map(([key]) => String(key))
      .filter((key) => key.startsWith("endfield-calc:"));
    expect(written).toContain(AIC_STORAGE_KEY);
    expect(handle.value.aic.capOverrides.get(CAP_KEY)).toBe(99);
    expect(window.localStorage.getItem(AIC_STORAGE_KEY)).toContain(
      CAP_TARGET.facilityId,
    );
  });

  it("adopts the snapshot on importSharedPlan, and answers onboarding", () => {
    seedShareLink(SHARED_SHAPE);
    const handle = renderProvider();

    act(() => {
      handle.value.importSharedPlan();
    });

    expect(handle.value.isSharedView).toBe(false);
    // The sharer's override is now the viewer's, on disk.
    expect(window.localStorage.getItem(AIC_STORAGE_KEY)).toContain(
      CAP_TARGET.facilityId,
    );
    expect(handle.value.aic.capOverrides.get(CAP_KEY)).toBe(SHARED_CAP_VALUE);
    // Importing IS the first-visit answer: the onboarding dialog mounts
    // the moment shared-view ends and must not fire over the import.
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();
    expect(handle.value.onboardingPending).toBe(false);
  });

  it("restores the viewer's own settings on exitSharedPlan, leaving onboarding unanswered", () => {
    seedShareLink(SHARED_SHAPE);
    const handle = renderProvider();

    act(() => {
      handle.value.exitSharedPlan();
    });

    expect(handle.value.isSharedView).toBe(false);
    // This viewer stored nothing, so "their own" is the default: the
    // sharer's override is discarded rather than retained.
    expect(handle.value.aic.capOverrides.get(CAP_KEY)).toBeUndefined();
    // Unlike import, discarding clobbers nothing, so a never-onboarded
    // viewer should still get the first-visit prompt.
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
    expect(handle.value.onboardingPending).toBe(true);
  });
});
