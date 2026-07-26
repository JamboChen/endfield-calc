/**
 * Render helpers shared by the settings DOM tests.
 *
 * Every one of them needs the same two things: a mounted
 * `DomainSettingsProvider` with a handle on the context value, and (for
 * the component-level tests) the sub-tabs for the region that owns the
 * capped facility. Keeping one copy means a change to the provider's
 * wiring is made once rather than in each test file.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RegionConfigTabs } from "@/components/settings/RegionConfigTabs";
import { DomainSettingsProvider } from "@/contexts/DomainSettingsProvider";
import { useDomainSettingsContext } from "@/contexts/domain-settings-context";
import type { DomainSettingsValue } from "@/hooks/useDomainSettings";

import {
  AIC_STORAGE_KEY,
  CAP_TARGET,
  ONBOARDING_STORAGE_KEY,
  SHARED_SHAPE,
  seedShareLink,
} from "./shared-plan-fixture";

/** No-op handlers: the toast-wrapped actions are `SettingsSheet`'s job. */
const noop = () => {};

/** A live handle on the context value, re-assigned on every render. */
export interface SettingsHandle {
  value: DomainSettingsValue;
}

/**
 * Put the app in one of the two settings worlds.
 *
 * `shared` seeds a link carrying the fixture snapshot, so the provider
 * resolves it into read-only shared-view. `own` writes the same snapshot
 * to the viewer's OWN storage instead, so the provider sees no difference
 * and stays editable. Using one snapshot for both keeps the two modes
 * comparing like with like: same region, same cap override, same
 * unresearched cap-raises, only `isSharedView` differs.
 */
export function seedSettings(mode: "shared" | "own"): void {
  if (mode === "shared") {
    seedShareLink(SHARED_SHAPE);
    return;
  }
  window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
  window.localStorage.setItem(AIC_STORAGE_KEY, JSON.stringify(SHARED_SHAPE));
}

/**
 * Mount the provider alone and hand back a handle on the context value.
 *
 * `handle.value` is re-assigned on every render, so read it fresh after
 * each `act()` rather than destructuring once.
 */
export function renderProvider(): SettingsHandle {
  const handle = {} as SettingsHandle;
  function Probe() {
    handle.value = useDomainSettingsContext();
    return null;
  }
  render(
    <DomainSettingsProvider>
      <Probe />
    </DomainSettingsProvider>,
  );
  return handle;
}

/**
 * Mount the region sub-tabs (plus a context probe) and open the named tab.
 *
 * The region is derived from the fixture rather than hardcoded because
 * only regions WITH cap targets render a Limits tab at all.
 */
export async function renderTab(
  name: RegExp,
  { mode = "shared" }: { mode?: "shared" | "own" } = {},
): Promise<SettingsHandle> {
  seedSettings(mode);
  const handle = {} as SettingsHandle;
  function Probe() {
    handle.value = useDomainSettingsContext();
    return null;
  }
  render(
    <DomainSettingsProvider>
      <Probe />
      <RegionConfigTabs
        editingDomain={CAP_TARGET.domainId}
        onToggleNode={noop}
        onActivateLayer={noop}
        onActivateGroup={noop}
        onResetGroup={noop}
      />
    </DomainSettingsProvider>,
  );
  await userEvent.click(screen.getByRole("tab", { name }));
  return handle;
}
