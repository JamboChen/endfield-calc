import { memo, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import TargetItemsGrid, { type ProductionTarget } from "./TargetItemsGrid";
import type { Item, ItemId } from "@/types";
import { useTranslation } from "react-i18next";
import { MAX_TARGETS } from "@/data";

type TargetsCardProps = {
  targets: ProductionTarget[];
  items: Item[];
  maxEnabledByTarget: ReadonlyMap<ItemId, boolean>;
  onTargetChange: (index: number, rate: number) => void;
  onTargetRemove: (index: number) => void;
  onTargetLockToggle: (index: number) => void;
  onAddClick: () => void;
  /** Optional header-right node (e.g. LeftPanel's collapse button). */
  headerAction?: ReactNode;
};

/**
 * The "Production Targets" card — title + mono count + target rows.
 * Shared between the desktop left rail (which passes its collapse
 * button as `headerAction`) and the portrait drawer, so targets carry
 * the same card chrome as the Options and Production Statistics cards
 * in both hosts.
 */
const TargetsCard = memo(function TargetsCard({
  targets,
  items,
  maxEnabledByTarget,
  onTargetChange,
  onTargetRemove,
  onTargetLockToggle,
  onAddClick,
  headerAction,
}: TargetsCardProps) {
  const { t } = useTranslation("targets");

  return (
    <Card className="flex flex-col shrink-0">
      <CardHeader className="shrink-0 max-sm:px-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground font-mono">
              {t("count", { current: targets.length, max: MAX_TARGETS })}
            </div>
            {headerAction}
          </div>
        </div>
      </CardHeader>
      {/* Tighter padding on phones — every horizontal pixel feeds the
          name column of the single-line target rows. */}
      <CardContent className="max-sm:px-3">
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
  );
});

export default TargetsCard;
