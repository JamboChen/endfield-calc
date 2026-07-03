import { memo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X, Plus } from "lucide-react";
import type { Item, ItemId } from "@/types";
import { useTranslation } from "react-i18next";
import { getItemName } from "@/lib/i18n-helpers";
import { tierClasses } from "@/lib/tier-styles";
import { cn } from "@/lib/utils";
import { MAX_TARGETS } from "@/data";

export type ProductionTarget = {
  itemId: ItemId;
  rate: number;
};

type TargetItemsGridProps = {
  targets: ProductionTarget[];
  items: Item[];
  onTargetChange: (index: number, rate: number) => void;
  onTargetRemove: (index: number) => void;
  onAddClick: () => void;
  maxTargets?: number;
};

/**
 * Production-target list in the bottom-dock row language: one
 * tier-accented row per target (icon · name · rate input + /min ·
 * remove), plus a dashed full-width add button.
 *
 * Names **wrap instead of truncating** — the longest localized item
 * names (46 chars in ru) never fit a single line beside the input at
 * any sane rail width, so rows grow to two lines for the long tail
 * while the common short names stay one compact line.
 *
 * Touch ergonomics follow the settings-row convention: ≥44px rows on
 * small screens (`min-h-11 sm:min-h-0`), remove buttons always visible
 * on hover-less devices, hover-revealed (opacity, space reserved — no
 * layout shift) plus focus-visible-revealed on pointer devices.
 */
const TargetItemsGrid = memo(function TargetItemsGrid({
  targets,
  items,
  onTargetChange,
  onTargetRemove,
  onAddClick,
  maxTargets = MAX_TARGETS,
}: TargetItemsGridProps) {
  const { t } = useTranslation("targets");
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Existing targets */}
      {targets.map((target, index) => {
        const item = items.find((i) => i.id === target.itemId);
        if (!item) return null;

        const isFocused = focusedIndex === index;
        const tc = tierClasses(item.tier);

        return (
          <div
            key={target.itemId}
            className={cn(
              "target-card-enter group flex items-center gap-2 rounded border border-border/40 border-l-2 bg-card px-2 py-1.5 min-h-11 sm:min-h-0 transition-all duration-150",
              tc.border,
              isFocused && "ring-2 ring-primary/40",
            )}
            style={{ animationDelay: `${index * 30}ms` }}
          >
            {/* Item icon */}
            <div className="h-8 w-8 flex items-center justify-center shrink-0">
              {item.iconUrl ? (
                <img
                  src={item.iconUrl}
                  alt=""
                  aria-hidden="true"
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="h-full w-full bg-muted rounded" />
              )}
            </div>

            {/* Name — wraps (never truncates); long localized names
                take a second line. */}
            <div className="flex-1 min-w-0 text-xs font-medium break-words leading-tight">
              {getItemName(item)}
            </div>

            {/* Rate input + unit */}
            <div className="flex items-center gap-1 shrink-0">
              <Input
                type="number"
                value={target.rate}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "") {
                    onTargetChange(index, 0);
                  } else {
                    const num = Number(val);
                    if (!isNaN(num)) {
                      onTargetChange(index, num);
                    }
                  }
                }}
                onFocus={(e) => {
                  setFocusedIndex(index);
                  e.target.select();
                }}
                onBlur={(e) => {
                  if (e.target.value === "" || Number(e.target.value) < 0) {
                    onTargetChange(index, 0);
                  }
                  setFocusedIndex(null);
                }}
                className="h-8 w-24 px-2 text-xs text-right font-mono"
                min="0"
                step="1"
                aria-label={t("rateInput")}
              />
              <span
                className="text-[11px] text-muted-foreground font-mono"
                title={t("rateUnit")}
              >
                /min
              </span>
            </div>

            {/* Remove — space reserved (opacity reveal, no layout
                shift); always visible on touch, focus-revealed for
                keyboard users. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onTargetRemove(index)}
              className="h-7 w-7 p-0 shrink-0 rounded-full [@media(hover:none)]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 transition-all hover:bg-destructive hover:text-destructive-foreground"
              aria-label={t("removeTarget")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}

      {/* Add button */}
      {targets.length < maxTargets && (
        <button
          type="button"
          onClick={onAddClick}
          className="group flex w-full items-center justify-center gap-2 rounded border-2 border-dashed border-border px-2 py-2 min-h-11 sm:min-h-0 sm:py-1.5 text-xs font-medium text-muted-foreground cursor-pointer transition-all duration-200 hover:border-primary/50 hover:bg-accent/40 hover:text-foreground active:scale-[0.98]"
        >
          <Plus className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />
          {t("addTarget")}
        </button>
      )}
    </div>
  );
});

export default TargetItemsGrid;
