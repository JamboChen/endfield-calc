import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getDomainName } from "@/lib/i18n-helpers";
import { parseDomainId } from "@/types/domain";
import type { Domain, DomainId } from "@/types/domain";
import type { MetastorageRouteMode } from "@/types/metastorage";

/**
 * The Metastorage outbound-route mode picker for one SOURCE region:
 * `Auto` (exports to whichever region is being planned) / `Disabled` /
 * a specific destination region (only that region's plans import).
 *
 * SINGLE control for this tri-state — shared by the Settings sheet's
 * Metastorage tab (`MetastorageContent`) and the plan-options imports
 * popover (`OptionsSection`) so the two surfaces cannot drift. The
 * tri-state deliberately mirrors the game's outbound-destination
 * concept; do NOT flatten it to a boolean at a consumer (a route
 * locked to another region is neither "on" nor "off" for the region
 * being planned — see the PR #101 review fallout).
 */
export function RouteModeSelect({
  source,
  domains,
  mode,
  onSetRouteMode,
  className,
}: {
  /** The Metastorage-capable SOURCE region this route belongs to. */
  source: DomainId;
  /** Full domain registry (destination options exclude `source`). */
  domains: readonly Domain[];
  mode: MetastorageRouteMode;
  onSetRouteMode: (source: DomainId, mode: MetastorageRouteMode) => void;
  /** Trigger sizing — callers own their density. */
  className?: string;
}) {
  const { t } = useTranslation(["settings"]);

  const destinations = useMemo(
    () =>
      [...domains]
        .filter((d) => d.id !== source)
        .sort((a, b) => a.sortId - b.sortId),
    [domains, source],
  );

  return (
    <Select
      value={mode}
      onValueChange={(value: string) => {
        if (value === "auto" || value === "disabled") {
          onSetRouteMode(source, value);
          return;
        }
        const dest = parseDomainId(value);
        if (dest) onSetRouteMode(source, dest);
      }}
    >
      <SelectTrigger className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto" className="text-xs">
          {t("metastorage.modeAuto", {
            ns: "settings",
            defaultValue: "Auto",
          })}
        </SelectItem>
        <SelectItem value="disabled" className="text-xs">
          {t("metastorage.modeDisabled", {
            ns: "settings",
            defaultValue: "Disabled",
          })}
        </SelectItem>
        {destinations.map((d) => (
          <SelectItem key={d.id} value={d.id} className="text-xs">
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-full shrink-0"
              style={{ backgroundColor: `#${d.color}` }}
            />
            <span className="truncate">{getDomainName(d.id)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
