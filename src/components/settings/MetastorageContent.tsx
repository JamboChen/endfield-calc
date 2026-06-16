import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Truck } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { metastorageExports, metastorageSources } from "@/data";
import { getDomainName } from "@/lib/i18n-helpers";
import { parseDomainId } from "@/types/domain";
import type { Domain, DomainId } from "@/types/domain";
import type { MetastorageRouteMode } from "@/types/metastorage";

import { SettingsCard, settingsRowClass } from "./SettingsCard";
import { cn } from "@/lib/utils";

interface MetastorageContentProps {
  /** Region being configured — must be a Metastorage-capable SOURCE. */
  domainId: DomainId;
  /** Full domain registry (destination options exclude `domainId`). */
  domains: readonly Domain[];
  /** Route mode per capable source (always materialized; default "auto"). */
  routeModes: ReadonlyMap<DomainId, MetastorageRouteMode>;
  onSetRouteMode: (source: DomainId, mode: MetastorageRouteMode) => void;
}

/**
 * Metastorage Transfer body — the "Metastorage" sub-tab content,
 * rendered only for source-capable regions (today: Valley IV).
 *
 * One control: the region's outbound route mode.
 *   - `auto` (default) — exports to whichever region is being planned.
 *   - `disabled` — no plan imports from this region.
 *   - a specific region — only that region's plans import from here.
 *
 * The transferred item is NOT picked here: the game ships one item type
 * per delivery and the calculator auto-selects whichever most improves
 * the destination plan. Capability numbers (TTV cap, delivery interval,
 * unlock level, eligible item count) come from the generated
 * `metastorageSources` / `metastorageExports` data.
 */
export function MetastorageContent({
  domainId,
  domains,
  routeModes,
  onSetRouteMode,
}: MetastorageContentProps) {
  const { t } = useTranslation(["settings"]);

  const info = metastorageSources.get(domainId);
  const eligibleCount = metastorageExports.get(domainId)?.size ?? 0;
  const mode = routeModes.get(domainId) ?? "auto";

  const destinations = useMemo(
    () =>
      [...domains]
        .filter((d) => d.id !== domainId)
        .sort((a, b) => a.sortId - b.sortId),
    [domains, domainId],
  );

  if (!info) return null;

  const cycleMinutes = info.cycleSeconds / 60;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed px-1">
        {t("metastorage.help", {
          ns: "settings",
          level: info.unlockLosslessLevel,
          ttv: info.ttvCapPerCycle,
          minutes: cycleMinutes,
          defaultValue:
            "Metastorage Transfer ships one item type per delivery to another region — without taking it from this region's depot. Unlocked at Regional Development Lv. {{level}}; each delivery (every {{minutes}} min) carries up to {{ttv}} Total Transfer Value.",
        })}
      </p>
      <p className="text-xs text-muted-foreground leading-relaxed px-1">
        {t("metastorage.autoExplain", {
          ns: "settings",
          count: eligibleCount,
          defaultValue:
            "The calculator picks the transferred item automatically ({{count}} eligible items), choosing whichever most improves the destination plan.",
        })}
      </p>

      <SettingsCard
        title={t("metastorage.cardTitle", {
          ns: "settings",
          defaultValue: "Outbound transfer",
        })}
        icon={<Truck className="size-5 text-cyan-600 dark:text-cyan-400" />}
      >
        <div className={cn(settingsRowClass, "justify-between")}>
          <span className="text-sm min-w-0 truncate">
            {t("metastorage.routeLabel", {
              ns: "settings",
              defaultValue: "Exports to",
            })}
          </span>
          <Select
            value={mode}
            onValueChange={(value: string) => {
              if (value === "auto" || value === "disabled") {
                onSetRouteMode(domainId, value);
                return;
              }
              const dest = parseDomainId(value);
              if (dest) onSetRouteMode(domainId, dest);
            }}
          >
            <SelectTrigger className="h-9 sm:h-7 w-[200px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto" className="text-xs">
                {t("metastorage.modeAuto", {
                  ns: "settings",
                  defaultValue: "Auto (region being planned)",
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
                  {t("metastorage.modeLocked", {
                    ns: "settings",
                    region: getDomainName(d.id),
                    defaultValue: "Only {{region}}",
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsCard>
    </div>
  );
}
