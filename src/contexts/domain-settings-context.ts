/**
 * Context object + consumer hook for `useDomainSettings`.
 *
 * Split from the Provider file so this module exports only non-component
 * values, satisfying the `react-refresh/only-export-components` lint
 * rule (the Provider re-mounts on HMR; importing the hook from the same
 * file would trigger spurious remounts of every consumer tree).
 */

import { createContext, useContext } from "react";

import type { DomainSettingsValue } from "@/hooks/useDomainSettings";

export const DomainSettingsContext = createContext<DomainSettingsValue | null>(
  null,
);

/**
 * Consume the domain-settings value. Throws if used outside a
 * `<DomainSettingsProvider>` — that's a wiring bug, not a runtime
 * possibility worth defending against with a fallback.
 */
export function useDomainSettingsContext(): DomainSettingsValue {
  const value = useContext(DomainSettingsContext);
  if (value === null) {
    throw new Error(
      "useDomainSettingsContext must be used within a <DomainSettingsProvider>",
    );
  }
  return value;
}
