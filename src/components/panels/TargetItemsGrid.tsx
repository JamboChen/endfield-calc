import { memo, useState } from "react";
import { Card } from "@/components/ui/card";
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
    <div className="grid grid-cols-3 gap-2">
      {/* Existing targets */}
      {targets.map((target, index) => {
        const item = items.find((i) => i.id === target.itemId);
        if (!item) return null;

        const isFocused = focusedIndex === index;
        const tc = tierClasses(item.tier);

        return (
          <Card
            key={target.itemId}
            className={cn(
              "target-card-enter relative group border-l-2 transition-all duration-150 hover:shadow-md hover:-translate-y-0.5",
              tc.border,
              isFocused && "ring-2 ring-primary/40",
            )}
            style={{ animationDelay: `${index * 30}ms` }}
          >
            {/* Remove button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onTargetRemove(index)}
              className="absolute -top-1.5 -right-1.5 h-5 w-5 p-0 rounded-full bg-background border border-border shadow-sm [@media(hover:none)]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 transition-all hover:bg-destructive hover:text-destructive-foreground hover:border-destructive z-10"
              aria-label={t("removeTarget")}
            >
              <X className="h-3 w-3" />
            </Button>

            <div className="px-2 space-y-2">
              {/* Item icon, tier dot, and name */}
              <div className="flex flex-col items-center gap-1.5">
                <div className="h-12 w-12 flex items-center justify-center">
                  {item.iconUrl ? (
                    <img
                      src={item.iconUrl}
                      alt={getItemName(item)}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="h-full w-full bg-muted rounded flex items-center justify-center">
                      <span className="text-xs text-muted-foreground">
                        {t("noIcon")}
                      </span>
                    </div>
                  )}
                </div>
                <div className="text-xs font-medium text-center line-clamp-2 w-full px-1 min-h-8 leading-tight">
                  {getItemName(item)}
                </div>
              </div>

              {/* Rate input */}
              <div className="space-y-1">
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
                  className="h-7 text-xs text-center font-mono"
                  min="0"
                  step="1"
                  aria-label={t("rateInput")}
                />
                <div className="text-[10px] text-center text-muted-foreground">
                  {t("rateUnit")}
                </div>
              </div>
            </div>
          </Card>
        );
      })}

      {/* Add button */}
      {targets.length < maxTargets && (
        <Card
          className="border-2 border-dashed border-border hover:border-primary/50 hover:bg-accent/40 cursor-pointer transition-all duration-200 group active:scale-[0.97]"
          onClick={onAddClick}
        >
          <div className="h-full flex flex-col items-center justify-center p-2.5 min-h-[140px]">
            <div className="h-10 w-10 border-2 border-dashed border-muted-foreground/30 group-hover:border-primary/50 rounded-lg flex items-center justify-center mb-2 transition-all duration-200 group-hover:scale-110">
              <Plus className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
            <div className="text-xs text-muted-foreground group-hover:text-foreground transition-colors text-center font-medium">
              {t("addTarget")}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
});

export default TargetItemsGrid;
