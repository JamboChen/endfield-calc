import { memo, useId } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { RegionPicker } from "@/components/settings/RegionPicker";
import { useDomainSettingsContext } from "@/contexts/domain-settings-context";
import { regionStructures } from "@/data";
import { facilityIconUrl } from "@/lib/facility-icons";
import {
  countRegionStructuresEnabled,
  structureKey,
} from "@/lib/settings-helpers";
import { cn } from "@/lib/utils";

type OptionsSectionProps = {
  /** Whether facility counts round up (physical view). */
  ceilMode: boolean;
  onCeilModeChange: (value: boolean) => void;
  /** Auto-fit: shrink other unlocked targets when an edit pushes the
   *  plan over its limits (persisted preference — see
   *  `useProductionPlan`'s AUTO_FIT_STORAGE_KEY). */
  autoFit: boolean;
  onAutoFitChange: (value: boolean) => void;
  /** Opens the full Settings sheet (AIC plan / limits / resources / …). */
  onOpenSettings: () => void;
};

/**
 * The "Options" section of the plan rail: the plan-level context in
 * one place — current factory region, the region's quick structure
 * toggles, and output-affecting plan settings (round-up). Deep
 * configuration stays in the Settings sheet, one click away via the
 * header action. Renders as a plain section — `PlanPanel` owns the
 * surface chrome.
 *
 * Region-locked structure rows mirror Settings → Structures, lenient
 * model included: rows whose prereq is off render faded (`opacity-55`)
 * but stay clickable — `structures.toggle` cascades the chain in the
 * hook, so this section carries no cascade logic of its own.
 */
const OptionsSection = memo(function OptionsSection({
  ceilMode,
  onCeilModeChange,
  autoFit,
  onAutoFitChange,
  onOpenSettings,
}: OptionsSectionProps) {
  const { t } = useTranslation(["settings", "app", "structure"]);
  const {
    domains,
    activeDomains,
    currentDomain,
    setCurrentDomain,
    structures,
  } = useDomainSettingsContext();
  // Instance-unique control ids: LeftPanel and the portrait Plan tab
  // both stay mounted (orientation swap is CSS-only), so static ids
  // would duplicate in the DOM.
  const ceilSwitchId = useId();
  const autoFitSwitchId = useId();

  const regionStructureList = regionStructures.get(currentDomain) ?? [];
  const structureCount = countRegionStructuresEnabled(
    structures.enabled,
    regionStructureList,
    currentDomain,
  );

  return (
    <section className="p-4 max-sm:p-3">
      <SectionHeader
        label={t("options.title", { ns: "settings" })}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSettings}
            className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Settings className="h-3.5 w-3.5" />
            {t("options.allSettings", { ns: "settings" })}
          </Button>
        }
      />
      <div className="space-y-4">
        <RegionPicker
          domains={domains}
          activeDomains={activeDomains}
          currentDomain={currentDomain}
          onChange={setCurrentDomain}
        />

        {regionStructureList.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t("tabs.structures", { ns: "settings" })}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t("status.enabled", {
                  ns: "settings",
                  done: structureCount.done,
                  total: structureCount.total,
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              {regionStructureList.map((s) => {
                const isEnabled = structures.enabled.has(
                  structureKey(currentDomain, s.id),
                );
                // Faded when its prereq isn't enabled yet — a "level"
                // hint, not a block: clicking cascades the prereqs in.
                const isLocked =
                  s.requires != null &&
                  !structures.enabled.has(
                    structureKey(currentDomain, s.requires),
                  ) &&
                  !isEnabled;
                const baseName = t(`structures.${s.id}`, { ns: "structure" });
                const name =
                  s.index != null
                    ? t("structures.indexed", {
                        ns: "settings",
                        name: baseName,
                        n: s.index,
                        defaultValue: `${baseName} ${s.index}`,
                      })
                    : baseName;
                return (
                  // Chip chrome matches the dock's facility rows
                  // (border + card bg + hover accent) — structures are
                  // facility-ish entities, so they rhyme with the
                  // build list in the stats dock.
                  <label
                    key={s.id}
                    className={cn(
                      "flex items-center gap-2 rounded border border-border/40 bg-card px-2 py-1.5 text-xs hover:bg-accent/40 transition-colors cursor-pointer",
                      isLocked && "opacity-55",
                    )}
                  >
                    <Checkbox
                      checked={isEnabled}
                      onCheckedChange={() =>
                        structures.toggle(currentDomain, s.id)
                      }
                      aria-label={name}
                    />
                    <img
                      src={facilityIconUrl(s.iconSlug)}
                      alt=""
                      aria-hidden="true"
                      // Pure-white monochrome game glyphs — invert to
                      // dark in light mode, keep white in dark mode.
                      className="size-5 object-contain shrink-0 opacity-80 invert dark:invert-0"
                      draggable={false}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.visibility =
                          "hidden";
                      }}
                    />
                    <span className="flex-1 min-w-0 truncate">{name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <Separator />

        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor={ceilSwitchId}
            className="text-sm cursor-pointer"
          >
            {t("ceilMode", { ns: "app" })}
          </Label>
          <Switch
            id={ceilSwitchId}
            checked={ceilMode}
            onCheckedChange={onCeilModeChange}
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Label
              htmlFor={autoFitSwitchId}
              className="text-sm cursor-pointer"
            >
              {t("autoFit", { ns: "app" })}
            </Label>
            <Switch
              id={autoFitSwitchId}
              checked={autoFit}
              onCheckedChange={onAutoFitChange}
            />
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("autoFitHint", { ns: "app" })}
          </p>
        </div>
      </div>
    </section>
  );
});

export default OptionsSection;
