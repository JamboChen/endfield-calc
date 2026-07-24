/**
 * Tests for the onboarding seen-flag helper.
 *
 * The node test env has no `window`; `vi.stubGlobal` supplies a fake one
 * with an in-memory localStorage so the round-trip is exercisable, and
 * the un-stubbed cases assert SSR / storage-failure safety.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { hasSeenOnboarding, markOnboardingSeen } from "@/lib/onboarding-storage";

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      store.set(k, v);
    },
    removeItem: (k: string): void => {
      store.delete(k);
    },
    clear: (): void => store.clear(),
  };
}

describe("onboarding-storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("markOnboardingSeen → hasSeenOnboarding round-trips", () => {
    vi.stubGlobal("window", { localStorage: fakeLocalStorage() });
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
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(hasSeenOnboarding()).toBe(false);
    expect(() => markOnboardingSeen()).not.toThrow();
  });
});
