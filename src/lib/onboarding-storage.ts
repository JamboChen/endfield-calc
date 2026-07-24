/**
 * First-visit onboarding "seen" flag — single source for the
 * `endfield-calc:onboarding-v1` localStorage key.
 *
 * The flag gates the once-per-browser `AicOnboardingDialog`. It is a
 * DIFFERENT key from the settings state (`endfield-calc:aic-v1`) and must
 * stay separate (see `.claude/rules/domain-settings.md`). This module
 * exists so the two writers of the flag — the dialog itself, and
 * `useDomainSettings.importSharedPlan` (adopting a shared plan's settings
 * counts as completing onboarding) — share one definition instead of
 * duplicating the namespaced key.
 */

import { namespaceStorageKey } from "@/lib/storage-namespace";

const ONBOARDING_STORAGE_KEY = namespaceStorageKey("endfield-calc:onboarding-v1");

/**
 * True once the first-visit onboarding has been completed (or otherwise
 * dismissed / imported-over). `false` on SSR or when localStorage is
 * unavailable — the dialog then defaults to showing, which is the safe
 * fallback.
 */
export function hasSeenOnboarding(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !!window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
  } catch {
    return false;
  }
}

/**
 * Mark onboarding as seen so the first-visit dialog won't fire again.
 * Best-effort: silently no-ops on SSR or when localStorage is
 * disabled/full (the dialog simply re-shows on the next visit).
 */
export function markOnboardingSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
  } catch {
    // localStorage disabled / full — non-fatal.
  }
}
