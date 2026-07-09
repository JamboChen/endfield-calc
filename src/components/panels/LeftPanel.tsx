import { memo, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import PlanPanel from "./PlanPanel";
import type { ProductionTarget } from "./TargetItemsGrid";
import type { Item, ItemId } from "@/types";

type LeftPanelProps = {
  targets: ProductionTarget[];
  items: Item[];
  maxEnabledByTarget: ReadonlyMap<ItemId, boolean>;
  ceilMode: boolean;
  onCeilModeChange: (value: boolean) => void;
  autoFit: boolean;
  onAutoFitChange: (value: boolean) => void;
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
};

const LeftPanel = memo(function LeftPanel({
  targets,
  items,
  maxEnabledByTarget,
  ceilMode,
  onCeilModeChange,
  autoFit,
  onAutoFitChange,
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
}: LeftPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="flex flex-col shrink-0">
        <Button
          variant="outline"
          className="h-full w-8 rounded-r-none border-r-0 flex flex-col gap-1 py-4 px-0"
          onClick={() => setCollapsed(false)}
          aria-label="Expand panel"
        >
          <PanelLeftOpen className="h-4 w-4 shrink-0" />
        </Button>
      </div>
    );
  }

  return (
    <div className="w-[420px] flex flex-col overflow-y-auto shrink-0 pb-2">
      <PlanPanel
        targets={targets}
        items={items}
        maxEnabledByTarget={maxEnabledByTarget}
        ceilMode={ceilMode}
        onCeilModeChange={onCeilModeChange}
        autoFit={autoFit}
        onAutoFitChange={onAutoFitChange}
        onOpenSettings={onOpenSettings}
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
        headerAction={
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse panel"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        }
      />
    </div>
  );
});

export default LeftPanel;
