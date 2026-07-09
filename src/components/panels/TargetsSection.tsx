import { memo, type ReactNode } from "react";
import { Loader2, Shrink } from "lucide-react";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/ui/button";
import TargetItemsGrid, { type ProductionTarget } from "./TargetItemsGrid";
import type { Item, ItemId } from "@/types";
import { useTranslation } from "react-i18next";
import { MAX_TARGETS } from "@/data";

type TargetsSectionProps = {
  targets: ProductionTarget[];
  items: Item[];
  maxEnabledByTarget: ReadonlyMap<ItemId, boolean>;
  onTargetChange: (index: number, rate: number) => void;
  onTargetRemove: (index: number) => void;
  onTargetLockToggle: (index: number) => void;
  onMaximizeTarget: (index: number) => void;
  maximizingIndex: number | null;
  optimizerBusy: boolean;
  /** Amber "Fit to limits" pill in the header — visible when the plan
   *  is over its limits and unlocked targets exist (hidden while
   *  auto-fit owns the job; see `useProductionPlan.showFitPill`). */
  showFitPill: boolean;
  fitRunning: boolean;
  onFitToLimits: () => void;
  onAddClick: () => void;
  /** Optional header-right node (e.g. LeftPanel's collapse button). */
  headerAction?: ReactNode;
};

/**
 * The "Production Targets" section of the plan rail: gold-tick header
 * with the mono count in the dock-grammar slot, then the target rows.
 * Renders as a plain section — `PlanPanel` owns the surface chrome
 * (border/bg/dividers), mirroring how the dock hosts its zones.
 */
const TargetsSection = memo(function TargetsSection({
  targets,
  items,
  maxEnabledByTarget,
  onTargetChange,
  onTargetRemove,
  onTargetLockToggle,
  onMaximizeTarget,
  maximizingIndex,
  optimizerBusy,
  showFitPill,
  fitRunning,
  onFitToLimits,
  onAddClick,
  headerAction,
}: TargetsSectionProps) {
  const { t } = useTranslation("targets");

  // Warning-family chrome (amber, like the dock's warning rows) — this
  // affordance only exists because the plan currently exceeds a limit.
  const fitPill = (showFitPill || fitRunning) && (
    <Button
      variant="outline"
      size="sm"
      // Explicit zero-arg call: the upstream handler takes an optional
      // `excludeIndex` — a bare `onClick={onFitToLimits}` would feed it
      // the MouseEvent.
      onClick={() => onFitToLimits()}
      disabled={optimizerBusy}
      className="h-6 gap-1 px-2 text-[11px] border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 hover:text-amber-700 dark:hover:text-amber-300"
    >
      {fitRunning ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Shrink className="h-3 w-3" />
      )}
      {t("fitToLimits")}
    </Button>
  );

  return (
    <section className="p-4 max-sm:p-3">
      <SectionHeader
        label={t("title")}
        count={t("count", { current: targets.length, max: MAX_TARGETS })}
        action={
          fitPill || headerAction ? (
            <span className="flex items-center gap-1.5">
              {fitPill}
              {headerAction}
            </span>
          ) : undefined
        }
      />
      <TargetItemsGrid
        targets={targets}
        items={items}
        maxEnabledByTarget={maxEnabledByTarget}
        onTargetChange={onTargetChange}
        onTargetRemove={onTargetRemove}
        onTargetLockToggle={onTargetLockToggle}
        onMaximizeTarget={onMaximizeTarget}
        maximizingIndex={maximizingIndex}
        optimizerBusy={optimizerBusy}
        onAddClick={onAddClick}
      />
    </section>
  );
});

export default TargetsSection;
