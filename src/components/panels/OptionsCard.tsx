import { memo, useId } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

type OptionsCardProps = {
  /** Whether facility counts round up (physical view). */
  ceilMode: boolean;
  onCeilModeChange: (value: boolean) => void;
  /** Opens the full Settings sheet (AIC plan / limits / resources / …). */
  onOpenSettings: () => void;
};

/**
 * Left-rail "Options" card: the plan-level context in one place —
 * current factory region, the region's quick structure toggles, and
 * output-affecting plan settings (round-up). Deep configuration stays in
 * the Settings sheet, one click away via the header action.
 *
 * Region-locked structure rows mirror Settings → Structures, lenient
 * model included: rows whose prereq is off render faded (`opacity-55`)
 * but stay clickable — `structures.toggle` cascades the chain in the
 * hook, so this card carries no cascade logic of its own.
 */
const OptionsCard = memo(function OptionsCard({
  ceilMode,
  onCeilModeChange,
  onOpenSettings,
}: OptionsCardProps) {
  const { t } = useTranslation(["settings", "app", "structure"]);
  const {
    domains,
    activeDomains,
    currentDomain,
    setCurrentDomain,
    structures,
  } = useDomainSettingsContext();
  // Instance-unique control id: LeftPanel and the portrait drawer both
  // stay mounted (orientation swap is CSS-only), so a static id would
  // duplicate in the DOM.
  const ceilSwitchId = useId();

  const regionStructureList = regionStructures.get(currentDomain) ?? [];
  const structureCount = countRegionStructuresEnabled(
    structures.enabled,
    regionStructureList,
    currentDomain,
  );

  return (
    <Card className="flex flex-col shrink-0">
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            {t("options.title", { ns: "settings" })}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSettings}
            className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Settings className="h-3.5 w-3.5" />
            {t("options.allSettings", { ns: "settings" })}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <RegionPicker
          domains={domains}
          activeDomains={activeDomains}
          currentDomain={currentDomain}
          onChange={setCurrentDomain}
        />

        {regionStructureList.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t("tabs.structures", { ns: "settings" })}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("status.enabled", {
                  ns: "settings",
                  done: structureCount.done,
                  total: structureCount.total,
                })}
              </div>
            </div>
            <div className="space-y-0.5">
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
                  <label
                    key={s.id}
                    className={cn(
                      "flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/40 cursor-pointer",
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
      </CardContent>
    </Card>
  );
});

export default OptionsCard;
