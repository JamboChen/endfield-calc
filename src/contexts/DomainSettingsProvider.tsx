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
 * # Onboarding dialog
 *
 * The provider also renders `<AicOnboardingDialog />` as a sibling of
 * `children`. The dialog is self-gating: it checks the
 * `endfield-calc:onboarding-v1` localStorage flag on mount and shows
 * itself only when absent. Co-locating it here keeps the "first-visit
 * AIC choice" UI bound to the same module that owns the per-domain
 * state it mutates.
 */

import type { ReactNode } from "react";

import { useDomainSettings } from "@/hooks/useDomainSettings";
import { AicOnboardingDialog } from "@/components/onboarding/AicOnboardingDialog";

import { DomainSettingsContext } from "./domain-settings-context";

export function DomainSettingsProvider({ children }: { children: ReactNode }) {
  const value = useDomainSettings();
  return (
    <DomainSettingsContext.Provider value={value}>
      {children}
      <AicOnboardingDialog />
    </DomainSettingsContext.Provider>
  );
}
