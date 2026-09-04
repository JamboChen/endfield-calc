/**
 * Settings sub-tabs while viewing a shared plan: frozen to edit, still
 * free to navigate.
 *
 * Read-only shared-view is implemented two different ways on purpose, and
 * the difference is the point of this file:
 *
 *   - Tabs whose bodies are FLAT (Resources, Structures, Metastorage) are
 *     wrapped in a `<fieldset disabled>`. Cheap and total.
 *   - Tabs whose bodies are COLLAPSIBLE (Plan, Limits) must not be, and
 *     thread `readOnly` down instead. A disabled `fieldset` disables every
 *     descendant form control per the HTML spec — including the card
 *     header `<button>` that expands and collapses the card. The card
 *     would be frozen shut (or, since the cards default open, frozen
 *     open), which is navigation loss, not read-only.
 *
 * The Limits tab shipped with the fieldset and therefore with dead card
 * headers; the first test below is the regression guard.
 *
 * Why jsdom is enough here: `toBeDisabled` walks the ancestor chain
 * itself, so the primary assertion does not depend on the environment
 * modelling the "actually disabled" concept at all. jsdom does implement
 * it (its `isDisabled` helper checks for a disabled `fieldset` ancestor,
 * and `HTMLElement.click()` honours the result), which is what makes the
 * behavioural half meaningful too.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderTab } from "./render-settings";
import { CAP_TARGET } from "./shared-plan-fixture";

/**
 * The Limits card header. Its accessible name is the facility name, which
 * with the test i18n instance (empty resources) resolves to the facility
 * id — a stabler query target than a translated string.
 */
function capCardHeader(): HTMLElement {
  return screen.getByRole("button", {
    name: new RegExp(CAP_TARGET.facilityId),
  });
}

describe("settings sub-tabs in read-only shared-view", () => {
  it("keeps the Limits card header operable so cards can still be collapsed", async () => {
    await renderTab(/Limits/);

    // Cards default open, so the custom-cap field proves the card's body
    // is mounted.
    expect(screen.getByLabelText(/Custom/)).toBeInTheDocument();

    // The regression guard. A `<fieldset disabled>` ancestor would make
    // this header "actually disabled" even with no `disabled` attribute
    // of its own, and `toBeDisabled` reports exactly that.
    const header = capCardHeader();
    expect(header).not.toBeDisabled();

    await userEvent.click(header);

    // Radix unmounts collapsed content, so the field going away is the
    // collapse actually happening.
    expect(screen.queryByLabelText(/Custom/)).not.toBeInTheDocument();
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("freezes the Limits edit controls", async () => {
    await renderTab(/Limits/);

    // The custom cap override and every cap-raise checkbox: disabled, not
    // hidden — the sharer's values stay legible.
    expect(screen.getByLabelText(/Custom/)).toBeDisabled();
    const checkboxes = screen.getAllByRole("checkbox");
    // Asserted so the loop below can't pass by iterating nothing.
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect(box).toBeDisabled();
    }

    // The two per-card write actions are absent rather than disabled,
    // matching how the Plan tab's own activate/reset actions behave.
    expect(
      screen.queryByRole("button", { name: /Activate all/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reset to base limit/ }),
    ).not.toBeInTheDocument();
  });

  it("still freezes a flat tab through its fieldset", async () => {
    // Removing one fieldset must not quietly unlock the tabs that
    // legitimately still use one.
    await renderTab(/Resources/);

    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input).toBeDisabled();
    }
  });

  it("leaves the Limits tab fully editable when not in shared-view", async () => {
    // The counterpart every read-only assertion needs: without it,
    // hard-coding `disabled` on these controls (or dropping the per-card
    // actions outright) would satisfy the tests above while breaking the
    // ordinary editing path the fix promises is untouched.
    await renderTab(/Limits/, { mode: "own" });

    expect(screen.getByLabelText(/Custom/)).toBeEnabled();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect(box).toBeEnabled();
    }

    // Both per-card write actions are reachable: the fixture leaves the
    // cap-raise techs unresearched (so there is something to activate) and
    // sets a cap override (so there is something to reset).
    expect(
      screen.getByRole("button", { name: /Activate all/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Reset to base limit/ }),
    ).toBeInTheDocument();
  });
});
