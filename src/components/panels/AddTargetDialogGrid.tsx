import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Search, X, Check } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { Item, ItemId } from "@/types";
import { useTranslation } from "react-i18next";
import { getItemName } from "@/lib/i18n-helpers";
import { forcedRawMaterials, MAX_TARGETS } from "@/data";
import { tierClasses } from "@/lib/tier-styles";
import { cn } from "@/lib/utils";

/* ── Types ── */

type QueuedItem = { itemId: ItemId; rate: number };

export type AddTargetDialogGridProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: Item[];
  existingTargetIds: ItemId[];
  onBatchAddTargets: (targets: QueuedItem[]) => void;
};

/* ── Main Component ── */

export default function AddTargetDialogGrid({
  open,
  onOpenChange,
  items,
  existingTargetIds,
  onBatchAddTargets,
}: AddTargetDialogGridProps) {
  const { t } = useTranslation("dialog");
  const searchRef = useRef<HTMLInputElement>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [activeTier, setActiveTier] = useState<number | null>(null);
  const [defaultRate, setDefaultRate] = useState(6);
  const [queue, setQueue] = useState<QueuedItem[]>([]);

  const existingTargetCount = existingTargetIds.length;

  /* Reset state when dialog opens */
  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setActiveTier(null);
      setQueue([]);
      /* auto-focus search after dialog animation */
      const raf = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  /* ── Derived data ── */

  const availableItems = useMemo(() => {
    const existingSet = new Set<ItemId>(existingTargetIds);
    return items.filter(
      (item) =>
        !existingSet.has(item.id) &&
        item.asTarget !== false &&
        !forcedRawMaterials.has(item.id),
    );
  }, [items, existingTargetIds]);

  /* Pre-computed lowercase names to avoid repeated i18n lookups while typing */
  const searchIndex = useMemo(
    () =>
      new Map(
        availableItems.map((item) => [
          item.id,
          getItemName(item).toLowerCase(),
        ]),
      ),
    [availableItems],
  );

  const filteredItems = useMemo(() => {
    let result = availableItems;
    if (activeTier !== null) {
      result = result.filter((item) => item.tier === activeTier);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((item) => {
        const name = searchIndex.get(item.id) ?? "";
        return name.includes(q) || item.id.toLowerCase().includes(q);
      });
    }
    return result;
  }, [availableItems, searchIndex, activeTier, searchQuery]);

  /* Tier counts for filter chips */
  const tierCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of availableItems) {
      counts.set(item.tier, (counts.get(item.tier) ?? 0) + 1);
    }
    return counts;
  }, [availableItems]);

  const uniqueTiers = useMemo(
    () => [...tierCounts.keys()].sort((a, b) => a - b),
    [tierCounts],
  );

  const queuedIds = useMemo(() => new Set(queue.map((q) => q.itemId)), [queue]);

  const remainingSlots = MAX_TARGETS - existingTargetCount - queue.length;

  /* Refs for stable callbacks (rerender-use-ref-transient-values) */
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const defaultRateRef = useRef(defaultRate);
  defaultRateRef.current = defaultRate;

  /* Item lookup map for StagingBar (js-index-maps) */
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  /* ── Handlers ── */

  const toggleItem = useCallback(
    (itemId: ItemId) => {
      setQueue((prev) => {
        const isRemoving = prev.some((q) => q.itemId === itemId);
        if (isRemoving) return prev.filter((q) => q.itemId !== itemId);
        const slotsLeft = MAX_TARGETS - existingTargetCount - prev.length;
        if (slotsLeft <= 0) return prev;
        return [...prev, { itemId, rate: defaultRateRef.current }];
      });
    },
    [existingTargetCount],
  );

  const updateQueueRate = useCallback((itemId: ItemId, rate: number) => {
    setQueue((prev) =>
      prev.map((q) => (q.itemId === itemId ? { ...q, rate } : q)),
    );
  }, []);

  const removeFromQueue = useCallback((itemId: ItemId) => {
    setQueue((prev) => prev.filter((q) => q.itemId !== itemId));
  }, []);

  const handleConfirm = useCallback(() => {
    if (queue.length === 0) return;
    onBatchAddTargets(queue);
    setQueue([]);
    setSearchQuery("");
    onOpenChange(false);
  }, [queue, onBatchAddTargets, onOpenChange]);

  const handleClearQueue = useCallback(() => setQueue([]), []);

  const handleCancel = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleDoubleClick = useCallback(
    (itemId: ItemId) => {
      const currentQueue = queueRef.current;
      const slotsLeft = MAX_TARGETS - existingTargetCount - currentQueue.length;
      const isQueued = currentQueue.some((q) => q.itemId === itemId);
      if (slotsLeft <= 0 && !isQueued) return;
      onBatchAddTargets([{ itemId, rate: defaultRateRef.current }]);
      setQueue([]);
      onOpenChange(false);
    },
    [existingTargetCount, onBatchAddTargets, onOpenChange],
  );

  /* ── Render ── */

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-sm:inset-0 max-sm:max-w-none max-sm:h-dvh max-sm:rounded-none max-sm:translate-x-0 max-sm:translate-y-0 sm:max-w-6xl sm:h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
        {/* ── Header ── */}
        <DialogHeader className="px-3 sm:px-5 pt-5 pb-0 shrink-0">
          <DialogTitle className="tracking-tight">{t("title")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        {/* ── Search + controls bar ── */}
        <div className="px-3 sm:px-5 pt-4 pb-3 space-y-3 shrink-0">
          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              ref={searchRef}
              placeholder={t("searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-11 text-sm bg-muted/50 border-transparent focus:border-border focus:bg-background transition-colors"
            />
          </div>

          {/* Tier filter chips + default rate */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* All chip */}
              <button
                onClick={() => setActiveTier(null)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer",
                  activeTier === null
                    ? "bg-foreground text-background border-foreground"
                    : "bg-transparent text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground",
                )}
              >
                {t("tierAll")}
                <span className="opacity-60">{availableItems.length}</span>
              </button>

              {uniqueTiers.map((tier) => {
                const tc = tierClasses(tier);
                const isActive = activeTier === tier;
                return (
                  <button
                    key={tier}
                    onClick={() => setActiveTier(isActive ? null : tier)}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer",
                      isActive
                        ? cn(tc.chip, "border-current")
                        : "bg-transparent text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground",
                    )}
                  >
                    <span className={cn("w-1.5 h-1.5 rounded-full", tc.dot)} />
                    {t("tierLabel", { tier: tier + 1 })}
                    <span className="opacity-60">
                      {tierCounts.get(tier) ?? 0}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Default rate */}
            <div className="flex items-center gap-2 shrink-0">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">
                {t("defaultRate")}
              </Label>
              <Input
                type="number"
                value={defaultRate}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "") {
                    setDefaultRate(0);
                  } else {
                    const num = Number(val);
                    if (!isNaN(num)) setDefaultRate(num);
                  }
                }}
                onBlur={(e) => {
                  if (e.target.value === "" || Number(e.target.value) < 0) {
                    setDefaultRate(0);
                  }
                }}
                className="h-8 w-20 text-xs text-center font-mono"
                min="0"
                step="1"
              />
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {t("rateUnit")}
              </span>
            </div>
          </div>
        </div>

        {/* ── Divider ── */}
        <div className="mx-3 sm:mx-5 border-t" />

        {/* ── Item grid ── */}
        <div className="flex-1 min-h-0 overflow-auto px-3 sm:px-5 py-4 [scrollbar-gutter:stable]">
          {filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
              <img
                src={`${import.meta.env.BASE_URL}images/no-results.png`}
                alt=""
                className="w-32 h-32"
                draggable={false}
              />
              <p className="text-sm">
                {availableItems.length === 0
                  ? t("allItemsAdded")
                  : t("noMatchingItems")}
              </p>
            </div>
          ) : (
            <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(90px,1fr))]">
              {filteredItems.map((item) => (
                <ItemCell
                  key={item.id}
                  item={item}
                  isQueued={queuedIds.has(item.id)}
                  isDisabled={remainingSlots <= 0 && !queuedIds.has(item.id)}
                  onToggle={toggleItem}
                  onDoubleClick={handleDoubleClick}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Staging queue bar ── */}
        <StagingBar
          queue={queue}
          itemMap={itemMap}
          remainingSlots={remainingSlots}
          onUpdateRate={updateQueueRate}
          onRemove={removeFromQueue}
          onClear={handleClearQueue}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      </DialogContent>
    </Dialog>
  );
}

/* ── Item grid cell (memoized — rerender-memo) ── */

type ItemCellProps = {
  item: Item;
  isQueued: boolean;
  isDisabled: boolean;
  onToggle: (itemId: ItemId) => void;
  onDoubleClick: (itemId: ItemId) => void;
};

const ItemCell = memo(function ItemCell({
  item,
  isQueued,
  isDisabled,
  onToggle,
  onDoubleClick,
}: ItemCellProps) {
  const tc = tierClasses(item.tier);

  return (
    <button
      onClick={(e) => {
        if (e.detail === 1) onToggle(item.id);
      }}
      onDoubleClick={() => onDoubleClick(item.id)}
      disabled={isDisabled}
      title={getItemName(item)}
      className={cn(
        "group relative aspect-square rounded-lg overflow-hidden border-l-2 border border-border transition-all duration-150 cursor-pointer",
        tc.border,
        isQueued
          ? cn("ring-2", tc.ring, tc.bg)
          : "hover:shadow-md hover:border-foreground/20 active:scale-[0.97]",
        isDisabled && !isQueued && "opacity-35 cursor-not-allowed",
      )}
    >
      {/* Check badge */}
      {isQueued && (
        <div
          className={cn(
            "absolute top-1 right-1 z-20 w-4.5 h-4.5 rounded-full flex items-center justify-center pill-enter shadow-sm",
            tc.dot,
          )}
        >
          <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
        </div>
      )}

      {/* Icon — fills the cell, z-0 keeps it behind the gradient scrim (z-10) */}
      <div className="absolute inset-1 bottom-5 z-0 flex items-center justify-center">
        {item.iconUrl ? (
          <img
            src={item.iconUrl}
            alt={getItemName(item)}
            className="w-full h-full object-contain drop-shadow-sm transition-transform duration-150 group-hover:scale-110"
            draggable={false}
          />
        ) : (
          <div className="w-10 h-10 bg-muted rounded flex items-center justify-center">
            <span className="text-[9px] text-muted-foreground">?</span>
          </div>
        )}
      </div>

      {/* Name overlay at bottom with tier-colored gradient scrim */}
      <div className="absolute inset-x-0 bottom-0 z-10">
        <div
          className={cn(
            "bg-linear-to-t to-transparent pt-1 pb-1.5 px-1.5",
            tc.gradient,
          )}
        >
          <span className="block text-[11px] leading-tight text-center text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)] line-clamp-2">
            {getItemName(item)}
          </span>
        </div>
      </div>
    </button>
  );
});

/* ── Staging queue bar ── */

type StagingBarProps = {
  queue: QueuedItem[];
  itemMap: Map<ItemId, Item>;
  remainingSlots: number;
  onUpdateRate: (itemId: ItemId, rate: number) => void;
  onRemove: (itemId: ItemId) => void;
  onClear: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

const StagingBar = memo(function StagingBar({
  queue,
  itemMap,
  remainingSlots,
  onUpdateRate,
  onRemove,
  onClear,
  onConfirm,
  onCancel,
}: StagingBarProps) {
  const { t } = useTranslation("dialog");
  const hasQueue = queue.length > 0;

  return (
    <div className="shrink-0 border-t bg-muted/30">
      {/* Queue items row — always visible to avoid layout shift */}
      <div className="px-3 sm:px-5 pt-3 pb-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            {t("queueTitle")}
            <span className="ml-1.5 text-foreground">{queue.length}</span>
          </span>
          {hasQueue && (
            <button
              onClick={onClear}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
            >
              {t("clearQueue")}
            </button>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-2 min-h-10 [scrollbar-gutter:stable]">
          {queue.map((q) => {
            const item = itemMap.get(q.itemId);
            if (!item) return null;
            const tc = tierClasses(item.tier);

            return (
              <div
                key={q.itemId}
                className={cn(
                  "pill-enter shrink-0 flex items-center gap-2 pl-1.5 pr-1 py-1 rounded-lg border border-foreground/15",
                  tc.bg,
                )}
              >
                {/* Tiny icon */}
                {item.iconUrl && (
                  <img
                    src={item.iconUrl}
                    alt=""
                    className="w-6 h-6 object-contain shrink-0"
                    draggable={false}
                  />
                )}

                {/* Name — hidden on mobile, icon is enough */}
                <span className="hidden sm:inline text-xs whitespace-nowrap max-w-[100px] truncate">
                  {getItemName(item)}
                </span>

                {/* Rate input */}
                <Input
                  type="number"
                  value={q.rate}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "") {
                      onUpdateRate(q.itemId, 0);
                    } else {
                      const num = Number(val);
                      if (!isNaN(num)) onUpdateRate(q.itemId, num);
                    }
                  }}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    if (e.target.value === "" || Number(e.target.value) < 0) {
                      onUpdateRate(q.itemId, 0);
                    }
                  }}
                  className="h-6 w-14 text-[11px] text-center font-mono px-1 bg-background"
                  min="0"
                  step="1"
                />

                {/* Remove */}
                <button
                  onClick={() => onRemove(q.itemId)}
                  className="p-0.5 rounded hover:bg-destructive/15 hover:text-destructive transition-colors cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Action bar */}
      <div className="px-3 sm:px-5 py-3 flex items-center justify-between">
        <div className="hidden sm:block text-xs text-muted-foreground">
          {remainingSlots <= 0
            ? t("maxReached", { max: MAX_TARGETS })
            : hasQueue
              ? t("hint", {
                  selected: queue
                    .map((q) => {
                      const item = itemMap.get(q.itemId);
                      return item ? getItemName(item) : q.itemId;
                    })
                    .join(", "),
                })
              : t("queueEmpty")}
        </div>

        <div className="flex items-center gap-2 sm:ml-0 ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="h-8 px-4 text-xs cursor-pointer"
          >
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={queue.length === 0}
            className="h-8 px-4 text-xs cursor-pointer"
          >
            {t("addN", { count: queue.length })}
          </Button>
        </div>
      </div>
    </div>
  );
});
