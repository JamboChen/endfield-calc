import { memo } from "react";
import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SectionHeader } from "@/components/SectionHeader";
import type { PowerTarget } from "@/hooks/useProductionPlan";
import { getItemName, getFacilityName } from "@/lib/i18n-helpers";
import { tierClasses } from "@/lib/tier-styles";
import { cn, formatCount, formatNumber } from "@/lib/utils";

type PowerTargetsSectionProps = {
  /** Read-only rows derived in `useProductionPlan.powerTargets`. */
  powerTargets: readonly PowerTarget[];
  ceilMode: boolean;
  /** True when no battery fuel is producible/importable (the plan's
   *  `power-sustain-unavailable` warning) — shown as the empty state. */
  unavailable: boolean;
};

/**
 * The read-only "Power Targets" section of the plan rail: what the LP
 * decided to produce solely to keep the lights on under the
 * self-sustaining-power option. Rendered by `PlanPanel` between the
 * Production Targets and Options sections, only while the option is
 * active. Mirrors the Production Targets row language (tier-accented
 * rows, icon + wrapping name, mono rate) minus every control — these
 * numbers are solver output, not user input.
 *
 * Row anatomy: battery icon · name (wraps) · burn rate `/min`, with a
 * muted subline `Thermal Bank ×banks · watts power`. The header count
 * slot carries the total generation, rhyming with the ticker's
 * `consumption / generation` stat.
 */
const PowerTargetsSection = memo(function PowerTargetsSection({
  powerTargets,
  ceilMode,
  unavailable,
}: PowerTargetsSectionProps) {
  const { t } = useTranslation("targets");

  const totalWatts = powerTargets.reduce((sum, pt) => sum + pt.watts, 0);

  return (
    <section className="p-4 max-sm:p-3">
      <SectionHeader
        label={t("powerTitle")}
        count={
          powerTargets.length > 0
            ? t("powerTotal", { power: formatNumber(totalWatts, 1) })
            : undefined
        }
        action={
          <Zap
            className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400"
            aria-hidden="true"
          />
        }
      />
      {powerTargets.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {unavailable ? t("powerUnavailable") : t("powerEmpty")}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {powerTargets.map((pt) => {
            const tc = tierClasses(pt.item.tier);
            return (
              <div
                key={pt.item.id}
                className={cn(
                  // Same row chrome as TargetItemsGrid, minus the
                  // controls: name wraps, the rate stays inline.
                  "flex items-center gap-1.5 rounded border border-border/40 border-l-2 bg-card px-2 py-1.5",
                  tc.border,
                )}
              >
                {/* Battery icon */}
                <div className="h-8 w-8 max-sm:h-6 max-sm:w-6 flex items-center justify-center shrink-0">
                  {pt.item.iconUrl ? (
                    <img
                      src={pt.item.iconUrl}
                      alt=""
                      aria-hidden="true"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="h-full w-full bg-muted rounded" />
                  )}
                </div>

                {/* Name + banks/watts subline — wraps, never truncates. */}
                <div className="flex-1 min-w-0 leading-tight">
                  <div className="text-xs font-medium break-words">
                    {getItemName(pt.item)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {t("powerRowSub", {
                      facility: getFacilityName(pt.facility),
                      count: formatCount(pt.banks, ceilMode),
                      power: formatNumber(pt.watts, 1),
                    })}
                  </div>
                </div>

                {/* Burn rate — read-only headline in the rate slot. */}
                <div className="flex items-baseline gap-1 shrink-0 ml-auto">
                  <span className="font-mono text-xs font-semibold">
                    {formatNumber(pt.ratePerMinute)}
                  </span>
                  <span className="text-[11px] text-muted-foreground font-mono">
                    /min
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
});

export default PowerTargetsSection;
