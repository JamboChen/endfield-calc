/**
 * Context object + consumer hook for the settings-sheet "focus" request.
 *
 * When the Add-Target picker's greyed (locked) item is clicked, App sets a
 * `SettingsFocus` and opens the sheet; the sheet re-provides it to its
 * subtree so `RegionConfigTabs` can force the Plan tab and `AicNodeRow`
 * can flash the tech nodes that must be researched. Split from any
 * component file (non-component exports only) to satisfy
 * `react-refresh/only-export-components`, mirroring
 * `domain-settings-context.ts`.
 */
import { createContext } from "react";

import type { AicTechId } from "@/types/aic";
import type { DomainId } from "@/types/domain";

export interface SettingsFocus {
  /**
   * Bumped on every request so re-focusing the SAME target (identical
   * region + techs) still re-fires the navigation + flash effects.
   */
  readonly nonce: number;
  /** Plan region to open (drives `editingDomain`) + whose nodes to flash. */
  readonly domainId: DomainId;
  /** Tech nodes to flash within that region's AIC plan. */
  readonly techIds: readonly AicTechId[];
}

export const SettingsFocusContext = createContext<SettingsFocus | null>(null);
