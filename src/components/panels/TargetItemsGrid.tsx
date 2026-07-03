import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X, Plus, Lock, LockOpen, ArrowUpToLine } from "lucide-react";
import type { Item, ItemId } from "@/types";
import { useTranslation } from "react-i18next";
import { getItemName } from "@/lib/i18n-helpers";
import { tierClasses } from "@/lib/tier-styles";
import { cn } from "@/lib/utils";
import { MAX_TARGETS } from "@/data";

export type ProductionTarget = {
  itemId: ItemId;
  rate: number;
  /**
   * Locked targets are protected from the (upcoming) Fit-to-limits
   * rebalance — see docs/plan-target-optimizer.md. Absent = unlocked
   * (the default; flexible).
   */
  locked?: boolean;
};

/* ── Scrub tuning constants ─────────────────────────────────────────
 * The scrub maps horizontal pointer distance to a value delta with
 * distance-based acceleration: gain(d) = G0 · (1 + (d/D)²) per pixel,
 * integrated to value(d) = G0 · (d + d³/(3D²)). Reversing the drag
 * direction re-anchors at the turn point, so backing off after an
 * overshoot is instantly fine-grained again (the "squeeze" gesture).
 * Tuned live during the browser pass — adjust here, nowhere else. */
/** Fine-zone gain: value change per pixel right at the anchor. */
const SCRUB_FINE_GAIN = 0.02;
/** Distance (px) at which the per-pixel gain has doubled. */
const SCRUB_ACCEL_DISTANCE = 60;
/** Pixels of movement before a press becomes a drag (below = tap). */
const SCRUB_DRAG_THRESHOLD = 4;
/** Trailing-throttle interval for live commits while scrubbing. */
const SCRUB_COMMIT_THROTTLE_MS = 200;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Integrated scrub curve: signed value delta for a pixel offset. */
function scrubDelta(dx: number): number {
  const d = Math.abs(dx);
  const D = SCRUB_ACCEL_DISTANCE;
  return Math.sign(dx) * SCRUB_FINE_GAIN * (d + (d * d * d) / (3 * D * D));
}

/** Per-pixel gain at a distance — drives the value-snapping tier. */
function scrubGainAt(dx: number): number {
  const d = Math.abs(dx);
  const ratio = d / SCRUB_ACCEL_DISTANCE;
  return SCRUB_FINE_GAIN * (1 + ratio * ratio);
}

/** Snap a scrubbed value to a human-friendly grid that coarsens with
 *  the local gain (0.001 in the fine zone so typed values like 12.968
 *  survive small nudges; up to whole units on coarse sweeps). */
function snapScrubValue(v: number, gain: number): number {
  const grid = gain < 0.03 ? 0.001 : gain < 0.3 ? 0.01 : gain < 3 ? 0.1 : 1;
  return round3(Math.round(v / grid) * grid);
}

type RateScrubInputProps = {
  value: number;
  onCommit: (rate: number) => void;
  onFocusChange: (focused: boolean) => void;
  ariaLabel: string;
  scrubHint: string;
  unitTitle: string;
};

/**
 * Photoshop/Blender-style scrubbable rate input, unified for mouse /
 * touch / pen via Pointer Events:
 *
 *   - Press + horizontal drag on the UNFOCUSED input scrubs the value
 *     with distance-based acceleration (see the constants above);
 *     reversing direction re-anchors into the fine zone.
 *   - A tap / click without drag focuses the input for typing
 *     (select-all, numeric keypad on mobile) — the previous behavior.
 *   - `touch-action: pan-y` keeps vertical swipes scrolling the page;
 *     the browser fires pointercancel when it claims the gesture.
 *   - Esc mid-drag cancels and restores the pre-drag value.
 *   - Keyboard path (focused): ↑/↓ ±1 · Shift ±10 · Alt ±0.1 ·
 *     Alt+Shift ±0.01.
 *
 * Commits are trailing-throttled while dragging so the plan solves
 * live (the calc effect cancels stale runs), with a final commit on
 * release.
 */
function RateScrubInput({
  value,
  onCommit,
  onFocusChange,
  ariaLabel,
  scrubHint,
  unitTitle,
}: RateScrubInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  /** Non-null while a scrub gesture owns the displayed value. */
  const [scrubValue, setScrubValue] = useState<number | null>(null);

  // All gesture state lives in refs — pointermove must not re-render.
  const gesture = useRef({
    pressed: false,
    dragging: false,
    pressX: 0,
    startValue: 0,
    anchorX: 0,
    anchorValue: 0,
    prevX: 0,
    dir: 0 as -1 | 0 | 1,
    lastShown: 0,
  });
  const throttle = useRef<{ timer: number | null; pending: number | null }>({
    timer: null,
    pending: null,
  });

  const flushCommit = useCallback(
    (v: number) => {
      const th = throttle.current;
      if (th.timer !== null) {
        window.clearTimeout(th.timer);
        th.timer = null;
      }
      th.pending = null;
      onCommit(v);
    },
    [onCommit],
  );

  const throttledCommit = useCallback(
    (v: number) => {
      const th = throttle.current;
      if (th.timer !== null) {
        th.pending = v;
        return;
      }
      onCommit(v);
      th.timer = window.setTimeout(() => {
        th.timer = null;
        if (th.pending !== null) {
          const p = th.pending;
          th.pending = null;
          onCommit(p);
        }
      }, SCRUB_COMMIT_THROTTLE_MS);
    },
    [onCommit],
  );

  // Clear any pending throttle timer on unmount.
  useEffect(() => {
    const th = throttle.current;
    return () => {
      if (th.timer !== null) window.clearTimeout(th.timer);
    };
  }, []);

  const endGesture = useCallback(() => {
    gesture.current.pressed = false;
    gesture.current.dragging = false;
    setScrubValue(null);
  }, []);

  // Esc mid-drag cancels the scrub and restores the pre-drag value.
  useEffect(() => {
    if (scrubValue === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      flushCommit(gesture.current.startValue);
      endGesture();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scrubValue, flushCommit, endGesture]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Focused input = edit mode: drags do text selection as usual.
    if (focused) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    // Prevent the browser's mousedown-focus so a drag never enters
    // edit mode; taps focus manually on pointerup.
    e.preventDefault();
    const g = gesture.current;
    g.pressed = true;
    g.dragging = false;
    g.pressX = e.clientX;
    g.startValue = value;
    g.lastShown = value;
    // Capture can throw for already-inactive pointers (synthetic
    // events, exotic drivers) — scrubbing degrades gracefully without
    // it as long as the pointer stays over the wrapper.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.pressed) return;
    if (!g.dragging) {
      if (Math.abs(e.clientX - g.pressX) < SCRUB_DRAG_THRESHOLD) return;
      g.dragging = true;
      g.anchorX = g.pressX;
      g.anchorValue = g.startValue;
      g.prevX = e.clientX;
      g.dir = 0;
    }
    const stepX = e.clientX - g.prevX;
    if (stepX === 0) return;
    const newDir: -1 | 1 = stepX > 0 ? 1 : -1;
    if (g.dir !== 0 && newDir !== g.dir) {
      // Direction reversal: re-anchor at the turn point so backing off
      // an overshoot is immediately fine-grained again.
      g.anchorX = g.prevX;
      g.anchorValue = g.lastShown;
    }
    g.dir = newDir;
    g.prevX = e.clientX;

    const dx = e.clientX - g.anchorX;
    const raw = g.anchorValue + scrubDelta(dx);
    const v = Math.max(0, snapScrubValue(raw, scrubGainAt(dx)));
    if (v === g.lastShown) return;
    g.lastShown = v;
    setScrubValue(v);
    throttledCommit(v);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.pressed) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (g.dragging) {
      flushCommit(g.lastShown);
    } else {
      // Tap: enter edit mode (select-all for quick retype).
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    endGesture();
  };

  const handlePointerCancel = () => {
    // Browser claimed the gesture (e.g. vertical scroll on touch):
    // restore the pre-drag value.
    const g = gesture.current;
    if (!g.pressed) return;
    if (g.dragging) flushCommit(g.startValue);
    endGesture();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const step =
      e.altKey && e.shiftKey ? 0.01 : e.altKey ? 0.1 : e.shiftKey ? 10 : 1;
    const sign = e.key === "ArrowUp" ? 1 : -1;
    onCommit(Math.max(0, round3(value + sign * step)));
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 shrink-0 select-none touch-pan-y",
        !focused && "cursor-ew-resize",
      )}
      title={scrubHint}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <Input
        ref={inputRef}
        type="number"
        value={scrubValue ?? value}
        onChange={(e) => {
          const val = e.target.value;
          if (val === "") {
            onCommit(0);
          } else {
            const num = Number(val);
            if (!isNaN(num)) {
              onCommit(num);
            }
          }
        }}
        onFocus={() => {
          setFocused(true);
          onFocusChange(true);
        }}
        onBlur={(e) => {
          if (e.target.value === "" || Number(e.target.value) < 0) {
            onCommit(0);
          }
          setFocused(false);
          onFocusChange(false);
        }}
        onKeyDown={handleKeyDown}
        className="h-8 w-24 px-2 text-xs text-right font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        min="0"
        step="any"
        aria-label={ariaLabel}
      />
      <span
        className="text-[11px] text-muted-foreground font-mono"
        title={unitTitle}
      >
        /min
      </span>
    </div>
  );
}

type TargetItemsGridProps = {
  targets: ProductionTarget[];
  items: Item[];
  /** Per-item Max-button gating from `useProductionPlan` — true when a
   *  raw in the item's chain has a configured limit. */
  maxEnabledByTarget: ReadonlyMap<ItemId, boolean>;
  onTargetChange: (index: number, rate: number) => void;
  onTargetRemove: (index: number) => void;
  onTargetLockToggle: (index: number) => void;
  onAddClick: () => void;
  maxTargets?: number;
};

/**
 * Production-target list in the bottom-dock row language: one
 * tier-accented row per target (icon · name · scrubbable rate input ·
 * max/lock/remove actions), plus a dashed full-width add button.
 *
 * Names **wrap instead of truncating** — the longest localized item
 * names (46 chars in ru) never fit a single line beside the input at
 * any sane rail width, so rows grow while short names stay compact.
 *
 * Action-button visibility: locked-state Lock is always visible (it is
 * state, not just an affordance); everything else is hover-revealed on
 * pointer devices (opacity — space reserved, no layout shift), always
 * visible on touch, and focus-visible-revealed for keyboard users.
 *
 * The Max button is rendered disabled in BOTH gating states this
 * phase — the optimizer engine lands separately (see
 * docs/plan-target-optimizer.md); the tooltip distinguishes "needs raw
 * limits" from "coming soon".
 */
const TargetItemsGrid = memo(function TargetItemsGrid({
  targets,
  items,
  maxEnabledByTarget,
  onTargetChange,
  onTargetRemove,
  onTargetLockToggle,
  onAddClick,
  maxTargets = MAX_TARGETS,
}: TargetItemsGridProps) {
  const { t } = useTranslation("targets");
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // Shared reveal classes for hover-hidden action buttons.
  const reveal =
    "[@media(hover:none)]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 transition-all";

  return (
    <div className="flex flex-col gap-1.5">
      {/* Existing targets */}
      {targets.map((target, index) => {
        const item = items.find((i) => i.id === target.itemId);
        if (!item) return null;

        const tc = tierClasses(item.tier);
        const maxEnabled = maxEnabledByTarget.get(target.itemId) ?? false;

        return (
          <div
            key={target.itemId}
            className={cn(
              "target-card-enter group flex items-center gap-1.5 rounded border border-border/40 border-l-2 bg-card px-2 py-1.5 min-h-11 sm:min-h-0 transition-all duration-150",
              tc.border,
              focusedIndex === index && "ring-2 ring-primary/40",
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
                take extra lines. */}
            <div className="flex-1 min-w-0 text-xs font-medium break-words leading-tight">
              {getItemName(item)}
            </div>

            <RateScrubInput
              value={target.rate}
              onCommit={(rate) => onTargetChange(index, rate)}
              onFocusChange={(f) => setFocusedIndex(f ? index : null)}
              ariaLabel={t("rateInput")}
              scrubHint={t("scrubHint")}
              unitTitle={t("rateUnit")}
            />

            <div className="flex items-center gap-0.5 shrink-0">
              {/* Max — gated on raw limits in the item's chain; the
                  engine lands with the optimizer phase, so it is
                  disabled either way for now. Tooltip lives on a
                  wrapper span (disabled buttons swallow pointer
                  events). */}
              <span
                title={
                  maxEnabled ? t("maximizeComingSoon") : t("maximizeNoLimits")
                }
                className={cn("inline-flex", reveal)}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled
                  className={cn(
                    "h-7 w-7 p-0",
                    !maxEnabled && "opacity-40",
                  )}
                  aria-label={t("maximize")}
                >
                  <ArrowUpToLine className="h-3.5 w-3.5" />
                </Button>
              </span>

              {/* Lock — visible state when locked; hover-revealed
                  affordance when not. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onTargetLockToggle(index)}
                aria-pressed={target.locked === true}
                aria-label={target.locked ? t("unlockTarget") : t("lockTarget")}
                title={target.locked ? t("unlockTarget") : t("lockTarget")}
                className={cn(
                  "h-7 w-7 p-0",
                  target.locked ? "text-foreground" : reveal,
                )}
              >
                {target.locked ? (
                  <Lock className="h-3.5 w-3.5" />
                ) : (
                  <LockOpen className="h-3.5 w-3.5" />
                )}
              </Button>

              {/* Remove */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onTargetRemove(index)}
                className={cn(
                  "h-7 w-7 p-0 rounded-full hover:bg-destructive hover:text-destructive-foreground",
                  reveal,
                )}
                aria-label={t("removeTarget")}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
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
