import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { parseDomainId } from "@/types/domain";
import type { Domain, DomainId } from "@/types/domain";

interface RegionPickerProps {
  /** Full domain registry (sort order is decided by `sortId`). */
  domains: readonly Domain[];
  /** Which regions are currently in the active set. Only these are listed. */
  activeDomains: ReadonlySet<DomainId>;
  /** Currently-selected factory region. */
  currentDomain: DomainId;
  /** Apply a new selection. Caller is expected to be the hook setter. */
  onChange: (id: DomainId) => void;
  /**
   * Force-disable the picker (e.g. read-only shared-view). ORed with the
   * trivial single-region case.
   */
  disabled?: boolean;
}

/**
 * Header-style picker for the user's current factory region.
 *
 * Lists `activeDomains` only (sorted by `sortId`). Each option shows the
 * region name (via the `domain` i18n namespace) with the domain's color
 * as a left-edge accent stripe, mirroring the `DomainSection` chrome.
 *
 * When only one region is active the picker is rendered disabled — the
 * choice is trivial and the dropdown affordance would mislead users
 * into thinking other regions exist.
 *
 * The picker only exposes regions the user has marked active. The hook's
 * `setCurrentDomain` additionally validates that the id is in
 * `activeDomains`, so the invariant `currentDomain ∈ activeDomains` is
 * preserved even if a future caller bypasses the UI.
 */
export function RegionPicker({
  domains,
  activeDomains,
  currentDomain,
  onChange,
  disabled = false,
}: RegionPickerProps) {
  const { t } = useTranslation(["settings", "domain"]);
  // Instance-unique control id: the picker renders in both the left
  // rail and the portrait drawer, which stay mounted simultaneously
  // (orientation swap is CSS-only) — a static id would duplicate.
  const pickerId = useId();

  const options = useMemo<readonly Domain[]>(
    () =>
      domains
        .filter((d) => activeDomains.has(d.id))
        .slice()
        .sort((a, b) => a.sortId - b.sortId),
    [domains, activeDomains],
  );

  const currentDomainObj = options.find((d) => d.id === currentDomain);
  // Nothing to pick between, or the caller froze it (shared-view).
  const pickerDisabled = options.length <= 1 || disabled;

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={pickerId}
        className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
      >
        {t("region.label", {
          ns: "settings",
          defaultValue: "Current factory region",
        })}
      </label>
      <Select
        value={currentDomain}
        onValueChange={(value) => {
          const d = parseDomainId(value);
          if (d) onChange(d);
        }}
        disabled={pickerDisabled}
      >
        <SelectTrigger
          id={pickerId}
          className={cn(
            "w-full pl-3 gap-2",
            // Domain-color accent stripe on the left edge (matches
            // `DomainSection`'s visual language). The 4px border keeps
            // it visually balanced with the surrounding input chrome.
            "border-l-4",
          )}
          style={
            currentDomainObj
              ? { borderLeftColor: `#${currentDomainObj.color}` }
              : undefined
          }
          aria-label={t("region.picker.ariaLabel", {
            ns: "settings",
            defaultValue: "Select current factory region",
          })}
        >
          <SelectValue
            placeholder={t("region.picker.placeholder", {
              ns: "settings",
              defaultValue: "Select region",
            })}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-full shrink-0"
                style={{ backgroundColor: `#${d.color}` }}
              />
              <span className="truncate">
                {t(`domains.${d.id}.name`, {
                  ns: "domain",
                  defaultValue: d.id,
                })}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
