/**
 * The facility "Custom" cap input: what it accepts, and what it displays.
 *
 * A cap override is a hard facility limit that reaches the LP, so a value
 * the user cannot see is worse than one they cannot set. Two properties
 * are pinned here:
 *
 *   - the field never displays a value the app did not store, including
 *     after a write it did not itself initiate;
 *   - a negative cap is refused, at the input AND at the hook, because
 *     storage already refuses it at rest (`sanitizePersistedShape`) and a
 *     value that applies until the next reload is the worst of both.
 */
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderTab } from "./render-settings";
import { CAP_KEY, CAP_TARGET, SHARED_CAP_VALUE } from "./shared-plan-fixture";

// No `<Toaster />` is mounted, so the warning is observed at its source.
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const { toast } = await import("sonner");

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

  it("refuses a negative cap, reverts the field and warns", async () => {
    const handle = await renderTab(/Limits/, { mode: "own" });

    await userEvent.clear(capField());
    await userEvent.type(capField(), "-5");
    await userEvent.tab();

    // Unchanged, rather than applied now and dropped on the next reload.
    expect(handle.value.aic.capOverrides.get(CAP_KEY)).toBe(SHARED_CAP_VALUE);
    expect(capField()).toHaveValue(SHARED_CAP_VALUE);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("refuses a negative cap at the hook, whatever the caller", async () => {
    // The input is not the only way in: a shared link, a saved file or a
    // future caller all reach `setCapOverride` directly. Storage rejects
    // negatives at rest, so the setter has to agree.
    const handle = await renderTab(/Limits/, { mode: "own" });

    act(() => {
      handle.value.aic.setCapOverride(
        CAP_TARGET.facilityId,
        CAP_TARGET.domainId,
        -5,
      );
    });

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
