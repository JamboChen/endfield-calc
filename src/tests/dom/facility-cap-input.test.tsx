/**
 * The facility "Custom" cap input: what it accepts, and what it displays.
 *
 * A cap override is a hard facility limit that reaches the LP, so a value
 * the user cannot see is worse than one they cannot set. The property
 * pinned here is that the field never displays a value the app did not
 * store — including after a write it did not itself initiate.
 */
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderTab } from "./render-settings";
import { CAP_KEY, CAP_TARGET, SHARED_CAP_VALUE } from "./shared-plan-fixture";

function capField(): HTMLElement {
  return screen.getByLabelText(/Custom/);
}

describe("facility cap override input", () => {
  it("commits a valid value", async () => {
    const handle = await renderTab(/Limits/, { mode: "own" });
    expect(capField()).toHaveValue(SHARED_CAP_VALUE);

    await userEvent.clear(capField());
    await userEvent.type(capField(), "12");
    await userEvent.tab();

    expect(handle.value.aic.capOverrides.get(CAP_KEY)).toBe(12);
    expect(
      handle.value.aic.effectiveCaps
        .get(CAP_TARGET.facilityId)
        ?.get(CAP_TARGET.domainId),
    ).toBe(12);
  });

  it("clears the override when emptied", async () => {
    const handle = await renderTab(/Limits/, { mode: "own" });

    await userEvent.clear(capField());
    await userEvent.tab();

    expect(handle.value.aic.capOverrides.has(CAP_KEY)).toBe(false);
  });

  it("follows the override when it is changed from outside the field", async () => {
    // No UI affordance does this today, which is exactly why the missing
    // resync was invisible: one bulk action away from writing a stale
    // value back on the next blur.
    const handle = await renderTab(/Limits/, { mode: "own" });
    expect(capField()).toHaveValue(SHARED_CAP_VALUE);

    act(() => {
      handle.value.aic.setCapOverride(
        CAP_TARGET.facilityId,
        CAP_TARGET.domainId,
        42,
      );
    });
    expect(capField()).toHaveValue(42);

    act(() => {
      handle.value.aic.setCapOverride(
        CAP_TARGET.facilityId,
        CAP_TARGET.domainId,
        null,
      );
    });
    expect(capField()).toHaveValue(null);
  });
});
