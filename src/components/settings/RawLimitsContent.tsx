import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { defaultRawCapsByDomain, items } from "@/data";
import { rawLimitKey } from "@/lib/raw-limits-helpers";
import { filterRegionRawItems } from "@/lib/settings-helpers";
import { cn } from "@/lib/utils";
import type { Item, ItemId } from "@/types";
import type { DomainId } from "@/types/domain";

import { SettingsCard, settingsRowClass } from "./SettingsCard";

// Module-scope item index. `items` is a static module import, so the
// Map can be built once at module load rather than every render.
const ITEMS_BY_ID: ReadonlyMap<ItemId, Item> = new Map(
  items.map((i) => [i.id, i] as const),
);

interface RawLimitsContentProps {
  /** Region these limits are for. */
  domainId: DomainId;
  /**
   * Raws available in this region (from `rawAvailabilityByDomain`).
   * Iterated filtered to non-liquid items only — liquids are hidden per
   * the locked design (costless in the LP, governed by pump
   * deployability rather than user caps).
   */
  regionRawMaterials: ReadonlySet<ItemId>;
  /** All overrides across every (item, domain) pair; own region read here. */
  overrides: ReadonlyMap<string, number>;
  /** Mutator. `null` clears (uncapped); a finite number sets the value. */
  onSetLimit: (
    itemId: ItemId,
    domainId: DomainId,
    value: number | null,
  ) => void;
}

/**
 * Raw-material limits body for one region — the "Raws" sub-tab content.
 * A responsive 2-column grid of material rows (single column on narrow
 * widths). Each row hosts a swatch-framed icon, the localised item name,
 * and a per-min numeric input. No outer card/collapsible chrome — the
 * tab panel is the container. Returns `null` when the region has no
 * non-liquid raws.
 *
 * Default model: rows with a `defaultRawCapsByDomain` entry (mined ores)
 * show the region's max mining output as the input placeholder — a blank
 * field means "use that default". Rows without one (Burdo-Muck) keep the
 * `∞` placeholder — blank means unlimited.
 *
 * Reset model (per the settings redesign): per-row reset buttons are
 * removed — clearing a row is just emptying its field (→ default cap, or
 * uncapped when the row has no default). A single tab-level **"Clear
 * all"** wipes every override in the region.
 */
export function RawLimitsContent({
  domainId,
  regionRawMaterials,
  overrides,
  onSetLimit,
}: RawLimitsContentProps) {
  const { t } = useTranslation(["item", "settings"]);

  // Non-liquid region raws, stably ordered then re-sorted by localised
  // name (matches the ProductionStats raw-materials list ordering).
  const rows = useMemo<Item[]>(() => {
    const out = filterRegionRawItems(regionRawMaterials, ITEMS_BY_ID);
    out.sort((a, b) =>
      t(a.id, { ns: "item", defaultValue: a.id }).localeCompare(
        t(b.id, { ns: "item", defaultValue: b.id }),
      ),
    );
    return out;
  }, [regionRawMaterials, t]);

  // Rows with a non-null override. Gates the "Clear all" affordance.
  const sourcedCount = useMemo(() => {
    let count = 0;
    for (const item of rows) {
      if (overrides.has(rawLimitKey(item.id, domainId))) count++;
    }
    return count;
  }, [rows, overrides, domainId]);

  const handleClearAll = () => {
    for (const item of rows) {
      if (overrides.has(rawLimitKey(item.id, domainId))) {
        onSetLimit(item.id, domainId, null);
      }
    }
  };

  const defaultCaps = defaultRawCapsByDomain.get(domainId);

  if (rows.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed px-1">
        {t("rawLimits.help", {
          ns: "settings",
          defaultValue:
            "A blank row uses the region's max mining output (the hinted value); resources without one are unlimited. Enter a rate to override.",
        })}
      </p>
      <SettingsCard
        title={t("rawLimits.cardTitle", {
          ns: "settings",
          defaultValue: "Natural Resources",
        })}
        actions={
          sourcedCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 sm:h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleClearAll}
            >
              {t("rawLimits.clearAll", {
                ns: "settings",
                defaultValue: "Clear all",
              })}
            </Button>
          ) : undefined
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
          {rows.map((item) => (
            <RawLimitRow
              key={item.id}
              item={item}
              domainId={domainId}
              value={overrides.get(rawLimitKey(item.id, domainId))}
              defaultCap={defaultCaps?.get(item.id)}
              onSetLimit={onSetLimit}
            />
          ))}
        </div>
      </SettingsCard>
    </div>
  );
}

interface RawLimitRowProps {
  item: Item;
  domainId: DomainId;
  value: number | undefined;
  /**
   * Region default cap (items/min) from `defaultRawCapsByDomain`, shown
   * as the input placeholder when no override is set. `undefined` for
   * raws without a preset maximum (Burdo-Muck) — those fall back to the
   * `∞` placeholder.
   */
  defaultCap: number | undefined;
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
  defaultCap,
  onSetLimit,
}: RawLimitRowProps) {
  const { t } = useTranslation(["item", "settings"]);
  const itemName = t(item.id, { ns: "item", defaultValue: item.id });
  const hasOverride = value !== undefined;
  const [draft, setDraft] = useState<string>(hasOverride ? String(value) : "");

  // Sync the local draft when `value` changes externally — e.g. the
  // tab-level "Clear all" (which clears via `onSetLimit(null)`), or a
  // future write path (import / URL load). Without this, the draft would
  // diverge from the persisted value and the next blur would write the
  // stale draft back.
  useEffect(() => {
    setDraft(value !== undefined ? String(value) : "");
  }, [value]);

  // parseFloat with finite + non-negative check, empty → clear override.
  // Fractional caps are intentional (a pump cycling every 2 min is
  // 0.5/min). Negative / NaN inputs are rejected here AND toast-warn so
  // the silent-revert doesn't confuse the user. The hook setter, loader,
  // and App.tsx aggregation independently reject negatives — defense in
  // depth.
  const commitDraft = () => {
    if (draft === "") {
      onSetLimit(item.id, domainId, null);
      return;
    }
    const v = parseFloat(draft);
    if (Number.isFinite(v) && v >= 0) {
      onSetLimit(item.id, domainId, v);
    } else {
      setDraft(hasOverride ? String(value) : "");
      toast.warning(
        t("rawLimits.invalidValue", {
          ns: "settings",
          defaultValue:
            "Limit must be a non-negative number. Value not saved.",
        }),
      );
    }
  };

  return (
    <div
      className={cn(
        settingsRowClass,
        hasOverride
          ? "bg-muted/30"
          : "hover:bg-muted/20 transition-colors",
      )}
    >
      {item.iconUrl && (
        <img
          src={item.iconUrl}
          alt=""
          aria-hidden="true"
          className="size-6 object-contain shrink-0"
          draggable={false}
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      )}
      <span
        className={cn(
          "flex-1 min-w-0 truncate",
          hasOverride ? "font-medium" : "text-muted-foreground",
        )}
      >
        {itemName}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={draft}
          placeholder={
            defaultCap !== undefined
              ? String(defaultCap)
              : t("rawLimits.placeholder", {
                  ns: "settings",
                  defaultValue: "∞",
                })
          }
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          className={cn(
            "h-9 sm:h-7 w-20 text-xs tabular-nums",
            // Hide native number-input spinner arrows: rate values are
            // typed, not incremented click-by-click, and the arrows eat
            // ~16px of visible digit space inside the box.
            "[appearance:textfield]",
            "[&::-webkit-outer-spin-button]:appearance-none",
            "[&::-webkit-inner-spin-button]:appearance-none",
            "[&::-webkit-inner-spin-button]:m-0",
          )}
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
      </div>
    </div>
  );
}
