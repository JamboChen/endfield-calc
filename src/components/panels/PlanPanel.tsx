import { memo, type ReactNode } from "react";
import TargetsSection from "./TargetsSection";
import type { ProductionTarget } from "./TargetItemsGrid";
import PowerTargetsSection from "./PowerTargetsSection";
import OptionsSection from "./OptionsSection";
import type { PowerTarget } from "@/hooks/useProductionPlan";
import type { Item, ItemId } from "@/types";
import { cn } from "@/lib/utils";

type PlanPanelProps = {
  targets: ProductionTarget[];
  items: Item[];
  maxEnabledByTarget: ReadonlyMap<ItemId, boolean>;
  ceilMode: boolean;
  onCeilModeChange: (value: boolean) => void;
  autoFit: boolean;
  onAutoFitChange: (value: boolean) => void;
  powerSustain: boolean;
  onPowerSustainChange: (value: boolean) => void;
  /** Read-only battery-for-power rows (self-sustaining power). */
  powerTargets: readonly PowerTarget[];
  /** No battery fuel producible — Power Targets empty-state variant. */
  powerSustainUnavailable: boolean;
  onOpenSettings: () => void;
  onTargetChange: (index: number, rate: number) => void;
  onTargetRemove: (index: number) => void;
  onTargetLockToggle: (index: number) => void;
  onMaximizeTarget: (index: number) => void;
  maximizingIndex: number | null;
  optimizerBusy: boolean;
  maxedIndices: ReadonlySet<number>;
  showFitPill: boolean;
  fitRunning: boolean;
  onFitToLimits: () => void;
  onAddClick: () => void;
  /** Header-right node for the Targets section (LeftPanel's collapse
   *  button on desktop; absent on the portrait Plan tab). */
  headerAction?: ReactNode;
  className?: string;
};

/**
 * The plan input console: ONE surface (same chrome as the stats dock —
 * rounded-lg border, card bg, hairline dividers) holding the ticked
 * Targets and Options sections. Rendered by the desktop `LeftPanel`
 * and the portrait Plan tab, so both orientations share the exact
 * telemetry-deck language by construction.
 */
const PlanPanel = memo(function PlanPanel({
  targets,
  items,
  maxEnabledByTarget,
  ceilMode,
  onCeilModeChange,
  autoFit,
  onAutoFitChange,
  powerSustain,
  onPowerSustainChange,
  powerTargets,
  powerSustainUnavailable,
  onOpenSettings,
  onTargetChange,
  onTargetRemove,
  onTargetLockToggle,
  onMaximizeTarget,
  maximizingIndex,
  optimizerBusy,
  maxedIndices,
  showFitPill,
  fitRunning,
  onFitToLimits,
  onAddClick,
  headerAction,
  className,
}: PlanPanelProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card shadow-sm divide-y divide-border h-fit",
        className,
      )}
    >
      <TargetsSection
        targets={targets}
        items={items}
        maxEnabledByTarget={maxEnabledByTarget}
        onTargetChange={onTargetChange}
        onTargetRemove={onTargetRemove}
        onTargetLockToggle={onTargetLockToggle}
        onMaximizeTarget={onMaximizeTarget}
        maximizingIndex={maximizingIndex}
        optimizerBusy={optimizerBusy}
        maxedIndices={maxedIndices}
        showFitPill={showFitPill}
        fitRunning={fitRunning}
        onFitToLimits={onFitToLimits}
        onAddClick={onAddClick}
        headerAction={headerAction}
      />
      {/* Read-only power targets — only while self-sustaining power is
          active, so the section doubles as toggle feedback. */}
      {powerSustain && (
        <PowerTargetsSection
          powerTargets={powerTargets}
          ceilMode={ceilMode}
          unavailable={powerSustainUnavailable}
        />
      )}
      <OptionsSection
        ceilMode={ceilMode}
        onCeilModeChange={onCeilModeChange}
        autoFit={autoFit}
        onAutoFitChange={onAutoFitChange}
        powerSustain={powerSustain}
        onPowerSustainChange={onPowerSustainChange}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
});

export default PlanPanel;
