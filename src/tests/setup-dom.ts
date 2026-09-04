/**
 * Vitest setup for the `dom` project — runs once per test worker before
 * any file in `src/tests/dom/`.
 *
 * Deliberately does NOT init HiGHS (unlike `setup.ts`, the `node`
 * project's setup): the emscripten wrapper branches on `typeof window`,
 * so under jsdom it would take the browser loader path and try to fetch
 * the WASM over HTTP. Nothing in the DOM suite solves a plan.
 *
 * Wired via the `dom` project's `test.setupFiles` in `vite.config.ts`.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * A bare i18next instance — no http backend, no resources.
 *
 * `src/i18n.ts` loads `public/locales/**` over HTTP, which a test has no
 * server for. Every `t()` call site in this codebase passes a
 * `defaultValue`, so an instance with EMPTY resources resolves each key
 * to that default. Tests therefore read the English strings that live in
 * the component source, with no locale files and no network.
 *
 * Consequence worth knowing when writing assertions: keys that have no
 * `defaultValue` (the game-data namespaces — `item`, `facility`, `aic`)
 * resolve to the key itself, i.e. the raw id. That is a feature here —
 * an id is a stabler query target than a translated name.
 */
i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: {} },
  interpolation: { escapeValue: false },
});

/**
 * jsdom ships no `ResizeObserver`, and Radix's `useSize` (behind
 * `Checkbox`, `Switch`) constructs one on mount. A no-op stub is enough:
 * nothing under test reads an observed size.
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub;

/**
 * Repair `localStorage` / `sessionStorage` when the runtime shadows them.
 *
 * Vitest copies jsdom's window properties onto `globalThis`, but skips any
 * name that already exists there unless it is on vitest's own explicit
 * allow-list — and `localStorage` is not on it. Node ≥ 22 ships an
 * experimental global `localStorage` that is *unavailable* without
 * `--localstorage-file`, so on a modern Node it shadows jsdom's working
 * implementation and `window.localStorage` reads as `undefined`. CI's
 * Node 20 has no such global and is unaffected — precisely the split that
 * makes a suite untrustworthy: green there, broken here.
 *
 * Re-point unconditionally when vitest's `jsdom` handle is available (it
 * always is today) rather than probing first: merely READING the shadowed
 * global emits Node's experimental warning on every worker. Where nothing
 * shadows it, this resolves to the same object jsdom already exposed, so
 * it is a no-op. The probe below exists only to decide whether a missing
 * handle is actually a problem.
 */
const STORAGE_KEYS = ["localStorage", "sessionStorage"] as const;

const jsdomHandle = (
  globalThis as unknown as {
    jsdom?: { window: Record<(typeof STORAGE_KEYS)[number], Storage> };
  }
).jsdom;

if (jsdomHandle) {
  for (const name of STORAGE_KEYS) {
    Object.defineProperty(globalThis, name, {
      value: jsdomHandle.window[name],
      configurable: true,
      writable: true,
    });
  }
} else if (!storageWorks("localStorage")) {
  throw new Error(
    "setup-dom: `localStorage` is unusable and vitest no longer exposes " +
      "the `jsdom` global to repair it from. Check what is shadowing it.",
  );
}

function storageWorks(name: (typeof STORAGE_KEYS)[number]): boolean {
  try {
    const store: Storage | undefined = globalThis[name];
    if (!store) return false;
    // Read back rather than trusting the write: a store whose `setItem`
    // silently no-ops would otherwise pass for working.
    store.setItem("__setup_dom_probe__", "1");
    const echoed = store.getItem("__setup_dom_probe__");
    store.removeItem("__setup_dom_probe__");
    return echoed === "1";
  } catch {
    return false;
  }
}

beforeEach(() => {
  // jsdom keeps one `window` per test FILE, so storage and the URL leak
  // between tests in the same file unless reset. Both are inputs to the
  // shared-view resolution, which is exactly what these tests exercise.
  window.localStorage.clear();
  window.history.replaceState(null, "", window.location.pathname);
});

// RTL's auto-cleanup only registers itself when `globals: true`, which
// this repo does not set (tests import from "vitest" explicitly).
afterEach(cleanup);

// Spies here are usually on shared globals (`Storage.prototype`), so a
// test that fails mid-way must not leak one into the rest of the file.
afterEach(() => {
  vi.restoreAllMocks();
});
