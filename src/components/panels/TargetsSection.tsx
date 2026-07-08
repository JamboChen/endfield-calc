import { memo, type ReactNode } from "react";
import { SectionHeader } from "@/components/SectionHeader";
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
  onAddClick,
  headerAction,
}: TargetsSectionProps) {
  const { t } = useTranslation("targets");

  return (
    <section className="p-4 max-sm:p-3">
      <SectionHeader
        label={t("title")}
        count={t("count", { current: targets.length, max: MAX_TARGETS })}
        action={headerAction}
      />
      <TargetItemsGrid
        targets={targets}
        items={items}
        maxEnabledByTarget={maxEnabledByTarget}
        onTargetChange={onTargetChange}
        onTargetRemove={onTargetRemove}
        onTargetLockToggle={onTargetLockToggle}
        onAddClick={onAddClick}
      />
    </section>
  );
});

export default TargetsSection;
