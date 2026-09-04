/**
 * In-memory `window.localStorage` for tests.
 *
 * The node test env has no `window`, so any module guarding on
 * `typeof window === "undefined"` silently takes its SSR path — which
 * makes storage-backed behaviour look like it passes when it was never
 * exercised. Stubbing a window is what actually tests it.
 *
 * Call `vi.unstubAllGlobals()` in `afterEach`.
 */

import { vi } from "vitest";

/** Stub `window` with a working localStorage, optionally pre-seeded. */
export function stubLocalStorage(seed: Record<string, string> = {}): Map<
  string,
  string
> {
  const store = new Map<string, string>(Object.entries(seed));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        store.set(k, v);
      },
      removeItem: (k: string): void => {
        store.delete(k);
      },
      clear: (): void => store.clear(),
    },
    location: { hash: "" },
  });
  return store;
}

/** Stub `window` with a localStorage that throws on every access. */
export function stubThrowingLocalStorage(): void {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
    location: { hash: "" },
  });
}
