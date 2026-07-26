/**
 * Tests for the onboarding seen-flag helper.
 *
 * The node test env has no `window`; `vi.stubGlobal` supplies a fake one
 * with an in-memory localStorage so the round-trip is exercisable, and
 * the un-stubbed cases assert SSR / storage-failure safety.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { hasSeenOnboarding, markOnboardingSeen } from "@/lib/onboarding-storage";
import { stubLocalStorage, stubThrowingLocalStorage } from "./fake-storage";

describe("onboarding-storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("markOnboardingSeen → hasSeenOnboarding round-trips", () => {
    stubLocalStorage();
    expect(hasSeenOnboarding()).toBe(false);
    markOnboardingSeen();
    expect(hasSeenOnboarding()).toBe(true);
  });

  test("SSR / no window: reports unseen and mark is a safe no-op", () => {
    // No `window` stubbed → `typeof window === "undefined"` in node.
    expect(hasSeenOnboarding()).toBe(false);
    expect(() => markOnboardingSeen()).not.toThrow();
  });

  test("a throwing localStorage is swallowed (treated as unseen)", () => {
    stubThrowingLocalStorage();
    expect(hasSeenOnboarding()).toBe(false);
    expect(() => markOnboardingSeen()).not.toThrow();
  });
});
