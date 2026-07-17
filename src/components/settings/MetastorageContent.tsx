import { useTranslation } from "react-i18next";
import { Truck } from "lucide-react";

import { metastorageExports, metastorageSources } from "@/data";
import type { Domain, DomainId } from "@/types/domain";
import type { MetastorageRouteMode } from "@/types/metastorage";

import { RouteModeSelect } from "./RouteModeSelect";
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
 * the plan. Source capability and the eligible-item count come from the
 * generated `metastorageSources` / `metastorageExports` data.
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

  if (!info) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed px-1">
        {t("metastorage.help", {
          ns: "settings",
          count: eligibleCount,
          defaultValue:
            "The calculator auto-selects the exported item from this region's {{count}} eligible items, choosing whichever most improves the plan.",
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
          <RouteModeSelect
            source={domainId}
            domains={domains}
            mode={mode}
            onSetRouteMode={onSetRouteMode}
            className="h-9 sm:h-7 w-[200px] text-xs"
          />
        </div>
      </SettingsCard>
    </div>
  );
}
