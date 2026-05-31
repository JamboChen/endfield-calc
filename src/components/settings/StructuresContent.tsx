import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import { facilityRecipeVariants, recipes } from "@/data";
import { facilityIconUrl } from "@/lib/facility-icons";
import { structureKey } from "@/lib/settings-helpers";
import { cn } from "@/lib/utils";
import type { RecipeId, RegionStructureId } from "@/types/constants";
import type { DomainId } from "@/types/domain";
import type { RegionStructure } from "@/types/structures";

import { SettingsCard, settingsRowClass } from "./SettingsCard";

interface StructuresContentProps {
  /** Region being configured. */
  domainId: DomainId;
  /** The region's structures (already domain-scoped), in chain order. */
  structures: readonly RegionStructure[];
  /** Global enabled set, keyed by `structureKey`. */
  enabled: ReadonlySet<string>;
  onToggle: (domainId: DomainId, structureId: RegionStructureId) => void;
}

/**
 * Region-exclusive structures body — the "Structures" sub-tab content.
 * Today: the Wuling Purification Node (3 Sewage Inlets + 1 Byproduct
 * Outlet, a linear opt-in chain). Each row is a checkbox; toggling
 * cascades along the chain (enable pulls in prereqs, disable drops
 * dependents). Rows whose prereq isn't enabled yet are faded as a "level"
 * hint, but stay clickable — clicking cascades the prereqs in (mirrors the
 * Limits cap-raise rows). Opt-in: all off by default.
 *
 * Per-row annotation ("Treats X" / "Produces Y") is derived from the
 * real `Recipe` data via `facilityRecipeVariants` — the structure itself
 * carries no rate numbers, keeping a single source of truth between
 * what the UI shows and what the LP runs.
 */
export function StructuresContent({
  domainId,
  structures,
  enabled,
  onToggle,
}: StructuresContentProps) {
  const { t } = useTranslation(["settings", "item"]);

  // Index recipes by id once per render so the per-row annotation lookup
  // is O(1). Memo because the `recipes` array reference is stable but
  // the Map allocation isn't free.
  const recipesById = useMemo(() => {
    const out = new Map<RecipeId, (typeof recipes)[number]>();
    for (const r of recipes) out.set(r.id, r);
    return out;
  }, []);

  if (structures.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed px-1">
        {t("structures.help", {
          ns: "settings",
          defaultValue: "Activate structures you can connect to your factory.",
        })}
      </p>

      <SettingsCard
        title={t("structures.purificationNode", {
          ns: "settings",
          defaultValue: "Purification Node",
        })}
      >
        <div className="space-y-0.5">
          {structures.map((s) => {
            const isEnabled = enabled.has(structureKey(domainId, s.id));
            // Faded when its prereq isn't enabled yet — a "level" hint, not
            // a block: clicking cascades the prereq chain in.
            const isLocked =
              s.requires != null &&
              !enabled.has(structureKey(domainId, s.requires)) &&
              !isEnabled;
            const name =
              s.index != null
                ? t(`structures.${s.nameKey}`, {
                    ns: "settings",
                    n: s.index,
                    defaultValue: `Sewage Inlet ${s.index}`,
                  })
                : t(`structures.${s.nameKey}`, {
                    ns: "settings",
                    defaultValue: "Byproduct Outlet",
                  });
            // Annotation deriving:
            //   instance      → "Treats <input of default variant>"
            //   recipeToggle  → "Produces <output of toggled variant>"
            // Both fall back to a blank annotation when the variants
            // map doesn't list the facility (defensive — keeps the UI
            // robust if a new structure is added without its variant
            // entries).
            const variants = facilityRecipeVariants.get(s.solver.facilityId);
            let annotation = "";
            if (variants) {
              if (s.solver.role === "instance") {
                const defaultRecipe = recipesById.get(variants.default);
                const consumedId = defaultRecipe?.inputs[0]?.itemId;
                if (consumedId) {
                  annotation = t("structures.treats", {
                    ns: "settings",
                    item: t(consumedId, { ns: "item" }),
                    defaultValue: `Treats ${t(consumedId, { ns: "item" })}`,
                  });
                }
              } else {
                const toggledRecipe = recipesById.get(variants.toggled);
                const producedId = toggledRecipe?.outputs[0]?.itemId;
                if (producedId) {
                  annotation = t("structures.produces", {
                    ns: "settings",
                    item: t(producedId, { ns: "item" }),
                    defaultValue: `Produces ${t(producedId, { ns: "item" })}`,
                  });
                }
              }
            }
            return (
              <label
                key={s.id}
                className={cn(
                  settingsRowClass,
                  "hover:bg-accent/40 cursor-pointer",
                  isLocked && "opacity-55",
                )}
              >
                <Checkbox
                  checked={isEnabled}
                  onCheckedChange={() => onToggle(domainId, s.id)}
                  aria-label={name}
                />
                <img
                  src={facilityIconUrl(s.iconSlug)}
                  alt=""
                  aria-hidden="true"
                  // These are pure-white monochrome game glyphs (invisible
                  // on the light card). Invert to dark in light mode; keep
                  // them white in dark mode.
                  className="size-6 object-contain shrink-0 opacity-80 invert dark:invert-0"
                  draggable={false}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.visibility = "hidden";
                  }}
                />
                <span className="flex-1 min-w-0 truncate">{name}</span>
                <span className="text-xs text-muted-foreground truncate max-w-[45%]">
                  {annotation}
                </span>
              </label>
            );
          })}
        </div>
      </SettingsCard>
    </div>
  );
}
