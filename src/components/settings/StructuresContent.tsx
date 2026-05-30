import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import { structureKey } from "@/lib/settings-helpers";
import { cn } from "@/lib/utils";
import type { RegionStructureId } from "@/types/constants";
import type { DomainId } from "@/types/domain";
import type { RegionStructure } from "@/types/structures";

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
 * dependents), so every checkbox is always clickable. Opt-in: all off by
 * default. Not yet wired to the solver.
 */
export function StructuresContent({
  domainId,
  structures,
  enabled,
  onToggle,
}: StructuresContentProps) {
  const { t } = useTranslation(["settings", "item"]);

  if (structures.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed px-1">
        {t("structures.help", {
          ns: "settings",
          defaultValue:
            "Map structures you can wire into your factory. Enabling one also enables the structures it depends on.",
        })}
      </p>

      <div className="rounded-md border border-border/60 bg-background/40">
        <div className="px-3 py-2 border-b border-border/40">
          <span className="text-sm font-semibold">
            {t("structures.purificationNode", {
              ns: "settings",
              defaultValue: "Purification Node",
            })}
          </span>
        </div>
        <div className="px-2 py-1.5 space-y-0.5">
          {structures.map((s) => {
            const isEnabled = enabled.has(structureKey(domainId, s.id));
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
            const annotation =
              s.kind === "source" && s.recipe.outputItemId
                ? t("structures.produces", {
                    ns: "settings",
                    item: t(s.recipe.outputItemId, { ns: "item" }),
                    defaultValue: `Produces ${t(s.recipe.outputItemId, { ns: "item" })}`,
                  })
                : t("structures.treats", {
                    ns: "settings",
                    item: t(s.recipe.inputItemId, { ns: "item" }),
                    defaultValue: `Treats ${t(s.recipe.inputItemId, { ns: "item" })}`,
                  });
            return (
              <label
                key={s.id}
                className={cn(
                  "flex items-center gap-2 py-1.5 px-1 rounded text-sm",
                  "hover:bg-accent/40 cursor-pointer",
                )}
              >
                <Checkbox
                  checked={isEnabled}
                  onCheckedChange={() => onToggle(domainId, s.id)}
                  aria-label={name}
                />
                <span className="flex-1 min-w-0 truncate">{name}</span>
                <span className="text-xs text-muted-foreground shrink-0 truncate">
                  {annotation}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
