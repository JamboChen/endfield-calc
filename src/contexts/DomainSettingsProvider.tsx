/**
 * Provider for `useDomainSettings`.
 *
 * # Why a Context
 *
 * The hook owns user-controlled per-domain settings (AIC research,
 * domain activation, cap overrides). In Step 2 the derived state
 * (`availableRecipes`, `targetableItems`, `facilityCaps`) drives the
 * calc, the picker, and the settings sheet. Without a Context, each
 * consumer of `useDomainSettings()` would get its own `useState`
 * instance — settings made in the sheet wouldn't reach the calc.
 *
 * `DomainSettingsProvider` calls `useDomainSettings()` once at the root
 * and broadcasts the value to all descendants via Context. Consumers
 * read via `useDomainSettingsContext()` from `domain-settings-context.ts`.
 *
 * The returned value from `useDomainSettings` is already memoized
 * internally (each sub-state and the umbrella object are `useMemo`'d),
 * so passing it directly to the provider is fine — re-broadcasts only
 * happen when a relevant slice actually changes.
 *
 * # Shared-plan view
 *
 * At mount the provider resolves whether the URL carries a shared
 * settings snapshot (`s=` blob) that differs from the viewer's own
 * settings. When it does, it seeds `useDomainSettings` from that
 * snapshot in read-only mode (`resolveSharedInit`) so the plan is
 * computed exactly as the sharer intended, without ever overwriting the
 * viewer's localStorage. Identical settings (the sharer reloading their
 * own link, or two default users) fall through to normal editable mode
 * — see `plan-share-codec.ts`.
 *
 * # Onboarding dialog
 *
 * The provider also renders `<AicOnboardingDialog />` as a sibling of
 * `children`. The dialog is self-gating: it checks the
 * `endfield-calc:onboarding-v1` localStorage flag on mount and shows
 * itself only when absent. Co-locating it here keeps the "first-visit
 * AIC choice" UI bound to the same module that owns the per-domain
 * state it mutates. It is suppressed while viewing a shared plan (its
 * bulk-apply would mutate the read-only snapshot).
 */

import { useState, type ReactNode } from "react";

import {
  DEFAULT_PERSISTED_SHAPE,
  loadPersistedShape,
  useDomainSettings,
  type SharedPlanInit,
} from "@/hooks/useDomainSettings";
import {
  decodeSettingsSnapshot,
  readShareBlobFromHash,
  shapesEqual,
} from "@/lib/plan-share-codec";
import { decodeHash } from "@/lib/plan-url";
import { AicOnboardingDialog } from "@/components/onboarding/AicOnboardingDialog";

import { DomainSettingsContext } from "./domain-settings-context";

/**
 * Resolve the shared-plan seed from the URL at mount. Returns a
 * `SharedPlanInit` ONLY when the link carries a settings snapshot that
 * differs from the viewer's own settings; identical settings (or no
 * `s=` blob / a corrupt one) return `undefined` → normal editable mode.
 */
function resolveSharedInit(): SharedPlanInit | undefined {
  if (typeof window === "undefined") return undefined;
  const blob = readShareBlobFromHash(decodeHash(window.location.hash));
  if (!blob) return undefined;
  const snapshot = decodeSettingsSnapshot(blob);
  if (!snapshot) return undefined;
  const own = loadPersistedShape() ?? DEFAULT_PERSISTED_SHAPE;
  return shapesEqual(snapshot, own) ? undefined : { shape: snapshot };
}

export function DomainSettingsProvider({ children }: { children: ReactNode }) {
  // Lazy: resolve the shared-view seed exactly once, from the original
  // URL, before `useProductionPlan`'s write-effect can rewrite the hash.
  const [sharedInit] = useState(resolveSharedInit);
  const value = useDomainSettings(sharedInit);
  return (
    <DomainSettingsContext.Provider value={value}>
      {children}
      {!value.isSharedView && <AicOnboardingDialog />}
    </DomainSettingsContext.Provider>
  );
}
