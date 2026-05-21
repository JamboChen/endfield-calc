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
 */

import type { ReactNode } from "react";

import { useDomainSettings } from "@/hooks/useDomainSettings";

import { DomainSettingsContext } from "./domain-settings-context";

export function DomainSettingsProvider({ children }: { children: ReactNode }) {
  const value = useDomainSettings();
  return (
    <DomainSettingsContext.Provider value={value}>
      {children}
    </DomainSettingsContext.Provider>
  );
}
