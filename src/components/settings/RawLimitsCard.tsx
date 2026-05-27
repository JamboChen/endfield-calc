import { useEffect, useMemo, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { items } from "@/data";
import { rawLimitKey } from "@/lib/raw-limits-helpers";
import { cn } from "@/lib/utils";
import type { Item, ItemId } from "@/types";
import type { DomainId } from "@/types/domain";

// Module-scope item index. `items` is a static module import, so the
// Map can be built once at module load rather than every render. (Used
// by `RawLimitsCard`'s `rows` memo and the row-level lookups.)
const ITEMS_BY_ID: ReadonlyMap<ItemId, Item> = new Map(
  items.map((i) => [i.id, i] as const),
);

interface RawLimitsCardProps {
  /** Domain this card is for (i.e. the parent `DomainSection`'s domain). */
  domainId: DomainId;
  /**
   * Raws available in this region (from `rawAvailabilityByDomain`).
   * The card iterates this set, filtered to non-liquid items only —
   * liquids are deliberately hidden from the UI per the locked design.
   */
  regionRawMaterials: ReadonlySet<ItemId>;
  /**
   * All current overrides across every (item, domain) pair. The card
   * reads its own region's entries; writing is via `onSetLimit`.
   */
  overrides: ReadonlyMap<string, number>;
  /**
   * Mutator. Pass `null` to clear the override (uncapped); a finite
   * number sets the value.
   */
  onSetLimit: (
    itemId: ItemId,
    domainId: DomainId,
    value: number | null,
  ) => void;
}

/**
 * One raw-material limits card — sits inside a `DomainSection` as a
 * sibling of `AicPlanCard`. Per the comment at `AicPlanCard.tsx`:55-63,
 * future per-domain settings categories follow this sibling-card
 * pattern.
 *
 * The card iterates `regionRawMaterials` filtered by `!isLiquid`
 * (liquids are hidden — they're costless in the LP and their per-
 * region presence is governed by pump deployability, not user-
 * configurable limits). If the filtered set is empty, the card
 * renders nothing (defensive — no domain currently has zero non-
 * liquid raws).
 *
 * Limit values are in **items/min** and may be fractional (a pump
 * that runs once every 2 minutes is 0.5/min — physically meaningful).
 * Inputs are persisted via `useDomainSettings.rawLimits` and consumed
 * by the calc layer in two places: (1) as soft LP upper-bound
 * constraints (via `lp-solver.ts` slack vars), and (2) as `raw-over-
 * cap` PlanWarnings post-pack. Over-cap items render with red tint in
 * the ProductionStats raw-materials list.
 */
export function RawLimitsCard({
  domainId,
  regionRawMaterials,
  overrides,
  onSetLimit,
}: RawLimitsCardProps) {
  const { t } = useTranslation(["item", "settings"]);
  const [open, setOpen] = useState(false);

  // Resolve the iterable list of Item objects for the card's rows.
  // Hide liquids per the locked design.
  const rows = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const id of regionRawMaterials) {
      const item = ITEMS_BY_ID.get(id);
      if (!item) continue;
      if (item.isLiquid === true) continue;
      out.push(item);
    }
    // Stable alphabetical order by localised name (matches
    // ProductionStats raw-materials list ordering).
    out.sort((a, b) =>
      t(a.id, { ns: "item", defaultValue: a.id }).localeCompare(
        t(b.id, { ns: "item", defaultValue: b.id }),
      ),
    );
    return out;
  }, [regionRawMaterials, t]);

  if (rows.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border border-dashed border-border/70 bg-background/40">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2 min-h-[44px]",
              "text-left rounded-md",
              "hover:bg-accent/40 dark:hover:bg-accent/30 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            )}
            aria-expanded={open}
          >
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition-transform shrink-0",
                open ? "rotate-0" : "-rotate-90",
              )}
            />
            <span className="text-sm font-medium flex-1 min-w-0">
              {t("rawLimits.title", {
                ns: "settings",
                defaultValue: "Raw material limits",
              })}
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {rows.length}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 pt-1 space-y-2">
            {rows.map((item) => (
              <RawLimitRow
                key={item.id}
                item={item}
                domainId={domainId}
                value={overrides.get(rawLimitKey(item.id, domainId))}
                onSetLimit={onSetLimit}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

interface RawLimitRowProps {
  item: Item;
  domainId: DomainId;
  value: number | undefined;
  onSetLimit: (
    itemId: ItemId,
    domainId: DomainId,
    value: number | null,
  ) => void;
}

function RawLimitRow({
  item,
  domainId,
  value,
  onSetLimit,
}: RawLimitRowProps) {
  const { t } = useTranslation(["item", "settings"]);
  const itemName = t(item.id, { ns: "item", defaultValue: item.id });
  const hasOverride = value !== undefined;
  const [draft, setDraft] = useState<string>(
    hasOverride ? String(value) : "",
  );

  // Sync the local draft when `value` changes externally — e.g. the
  // user clicks the Reset button (which clears via `onSetLimit(null)`),
  // or a future write path (import / URL load) mutates the override.
  // Without this effect, the draft would diverge from the persisted
  // value and the next blur would write the stale draft back.
  useEffect(() => {
    setDraft(value !== undefined ? String(value) : "");
  }, [value]);

  // parseFloat with finite + non-negative check, empty → clear
  // override. Fractional caps are intentional: per-min rates are
  // physically fractional (a pump cycling every 2 minutes is 0.5/min).
  //
  // Negative / NaN inputs are rejected here AND toast-warn the user
  // so the silent-revert behaviour doesn't confuse them. The HTML5
  // `min={0}` on the Input is a browser-level hint; this is the
  // real gate. The hook setter, loader, and App.tsx aggregation all
  // independently reject negative values — defense in depth.
  const commitDraft = () => {
    if (draft === "") {
      onSetLimit(item.id, domainId, null);
      return;
    }
    const v = parseFloat(draft);
    if (Number.isFinite(v) && v >= 0) {
      onSetLimit(item.id, domainId, v);
    } else {
      // Invalid (NaN or negative) — revert draft AND notify the user.
      setDraft(hasOverride ? String(value) : "");
      toast.warning(
        t("rawLimits.invalidValue", {
          ns: "settings",
          defaultValue:
            "Limit must be a non-negative number — value not saved.",
        }),
      );
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/30 p-2">
      {item.iconUrl && (
        <img
          src={item.iconUrl}
          alt=""
          aria-hidden="true"
          className="size-5 object-contain shrink-0"
        />
      )}
      <span className="text-sm font-medium flex-1 min-w-0 truncate">
        {itemName}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={draft}
          placeholder={t("rawLimits.placeholder", {
            ns: "settings",
            defaultValue: "—",
          })}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          className="h-7 w-20 text-xs tabular-nums"
          aria-label={t("rawLimits.inputAria", {
            ns: "settings",
            name: itemName,
            defaultValue: `${itemName} limit (items per minute)`,
          })}
        />
        <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
          {t("rawLimits.unitSuffix", {
            ns: "settings",
            defaultValue: "/min",
          })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setDraft("");
            onSetLimit(item.id, domainId, null);
          }}
          disabled={!hasOverride}
          aria-label={t("rawLimits.reset", {
            ns: "settings",
            defaultValue: "Reset",
          })}
        >
          <RotateCcw className="size-3" />
        </Button>
      </div>
    </div>
  );
}
