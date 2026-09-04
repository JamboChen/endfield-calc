/**
 * The Share button and the share/copy chain behind it.
 *
 * The behaviour that matters most here is what happens when the user
 * *declines* to share. `navigator.share` rejects with `AbortError` when
 * the share sheet is dismissed, and the tempting reading of "the share
 * didn't happen" is to fall through to the clipboard — which would copy a
 * link the user just chose not to send, and report success for an action
 * they cancelled. That case gets its own test.
 *
 * jsdom implements neither `navigator.share` nor `navigator.clipboard`,
 * so both are installed per test. That is also the honest simulation of
 * desktop Firefox, which ships neither.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AppHeader from "@/components/layout/AppHeader";
import { TooltipProvider } from "@/components/ui/tooltip";

// No `<Toaster />` is mounted, so toasts are observed at their source.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
const { toast } = await import("sonner");

const noop = () => {};

/** Install a `navigator` member jsdom doesn't provide, and undo it after. */
const installed: string[] = [];
function stubNavigator(name: string, value: unknown): void {
  Object.defineProperty(navigator, name, {
    value,
    configurable: true,
    writable: true,
  });
  installed.push(name);
}

afterEach(() => {
  for (const name of installed.splice(0)) {
    delete (navigator as unknown as Record<string, unknown>)[name];
  }
});

function renderHeader() {
  render(
    <TooltipProvider>
      <AppHeader
        onLanguageChange={noop}
        onSavePlan={noop}
        onOpenPlan={noop}
        onOpenSettings={noop}
      />
    </TooltipProvider>,
  );
}

/**
 * The desktop and mobile toolbars are both always mounted (the split is
 * CSS-only), so the button exists twice. Either one drives the same
 * handler; the count is asserted in its own test.
 */
function clickShare(): void {
  screen.getAllByRole("button", { name: /Share Plan/ })[0].click();
}

beforeEach(() => {
  // A plan-bearing URL, so the assertions below are about a real link
  // rather than a bare pathname.
  window.history.replaceState(null, "", `${window.location.pathname}#0dTOKEN`);
});

describe("share button", () => {
  it("renders in both the desktop and mobile toolbars", () => {
    renderHeader();

    // The layouts are `hidden md:flex` / `flex md:hidden`, so both trees
    // are in the DOM at all times and only CSS decides which is seen.
    expect(screen.getAllByRole("button", { name: /Share Plan/ })).toHaveLength(
      2,
    );
  });

  it("hands the current URL to the native share sheet", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubNavigator("share", share);
    renderHeader();

    clickShare();

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({
      url: window.location.href,
      title: expect.any(String),
    });
    expect(window.location.href).toContain("#0dTOKEN");
    // A completed share is its own feedback; the OS already showed a sheet.
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stays silent when the user dismisses the share sheet", async () => {
    const share = vi
      .fn()
      .mockRejectedValue(new DOMException("cancelled", "AbortError"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator("share", share);
    stubNavigator("clipboard", { writeText });
    renderHeader();

    clickShare();

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    // Declining is a decision, not a failure: no error, and above all no
    // consolation copy of the link they just declined to send.
    expect(writeText).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("copies the link when the browser has no share sheet", async () => {
    // Desktop Firefox: `navigator.share` is simply absent.
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator("clipboard", { writeText });
    renderHeader();

    clickShare();

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("copies the link when sharing fails for any other reason", async () => {
    // e.g. a desktop OS with no registered share targets.
    const share = vi
      .fn()
      .mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator("share", share);
    stubNavigator("clipboard", { writeText });
    renderHeader();

    clickShare();

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("reports failure when neither route works", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubNavigator("clipboard", { writeText });
    renderHeader();

    clickShare();

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
