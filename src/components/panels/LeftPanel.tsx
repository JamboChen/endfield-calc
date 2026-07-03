import { memo, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import TargetItemsGrid, { type ProductionTarget } from "./TargetItemsGrid";
import OptionsCard from "./OptionsCard";
import type { Item, ItemId } from "@/types";
import { useTranslation } from "react-i18next";

type LeftPanelProps = {
  targets: ProductionTarget[];
  items: Item[];
  maxEnabledByTarget: ReadonlyMap<ItemId, boolean>;
  ceilMode: boolean;
  onCeilModeChange: (value: boolean) => void;
  onOpenSettings: () => void;
  onTargetChange: (index: number, rate: number) => void;
  onTargetRemove: (index: number) => void;
  onTargetLockToggle: (index: number) => void;
  onAddClick: () => void;
};

const LeftPanel = memo(function LeftPanel({
  targets,
  items,
  maxEnabledByTarget,
  ceilMode,
  onCeilModeChange,
  onOpenSettings,
  onTargetChange,
  onTargetRemove,
  onTargetLockToggle,
  onAddClick,
}: LeftPanelProps) {
  const { t } = useTranslation("targets");
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
    <div className="w-[420px] flex flex-col gap-2.5 overflow-y-auto shrink-0 pb-2">
      <Card className="flex flex-col shrink-0">
        <CardHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <div className="flex items-center gap-2">
              <div className="text-xs text-muted-foreground font-mono">
                {t("count", { current: targets.length, max: 12 })}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => setCollapsed(true)}
                aria-label="Collapse panel"
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <TargetItemsGrid
            targets={targets}
            items={items}
            maxEnabledByTarget={maxEnabledByTarget}
            onTargetChange={onTargetChange}
            onTargetRemove={onTargetRemove}
            onTargetLockToggle={onTargetLockToggle}
            onAddClick={onAddClick}
          />
        </CardContent>
      </Card>

      <OptionsCard
        ceilMode={ceilMode}
        onCeilModeChange={onCeilModeChange}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
});

export default LeftPanel;
