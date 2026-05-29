import { memo, useMemo } from "react";
import { Lock, Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AicNode, AicTechId } from "@/types/aic";
import { facilities, items, recipes } from "@/data";
import { recipesByTech } from "@/data/aic-plans";
import { facilityIconUrl } from "@/lib/facility-icons";
import { getRecipeName } from "@/lib/i18n-helpers";
import type { FacilityId, RecipeId } from "@/types";

interface AicNodeRowProps {
  node: AicNode;
  researched: ReadonlySet<AicTechId>;
  onToggle: (id: AicTechId) => void;
}

// O(1) lookup tables for the recipe-list tooltip. Built once at module
// load. The Separating Unit tooltip has 67 recipes; without these maps
// each render would do `recipes.length × items.length` work via
// `Array.find` per row.
const RECIPES_BY_ID = new Map(recipes.map((r) => [r.id, r]));
const ITEMS_BY_ID = new Map(items.map((i) => [i.id, i]));

/**
 * Resolve the icon URL for a recipe's primary product. `outputs[0]` is
 * the calculator-wide convention for "primary output" (see lp-solver.ts,
 * multi-formula-packing.ts, etc.). Returns `undefined` when the recipe
 * or item is missing — caller skips icon rendering and the name still
 * shows.
 */
function recipePrimaryOutputIcon(recipeId: RecipeId): string | undefined {
  const recipe = RECIPES_BY_ID.get(recipeId);
  const primaryOutputId = recipe?.outputs[0]?.itemId;
  if (!primaryOutputId) return undefined;
  return ITEMS_BY_ID.get(primaryOutputId)?.iconUrl;
}

function AicNodeRowImpl({ node, researched, onToggle }: AicNodeRowProps) {
  const { t } = useTranslation(["aic", "facility", "settings"]);

  const isResearched = researched.has(node.id);
  const prereqsMet = node.preNodes.every((p: AicTechId) => researched.has(p));
  const isLocked = !prereqsMet && !isResearched;
  const isImmutable = node.alreadyUnlocked;

  // Tech name from i18n (used as tooltip subtitle for facility/mode unlocks
  // and as the primary label for cap-raise rows in Facility Limits).
  const techName = t(`nodes.${node.id}.name`, {
    ns: "aic",
    defaultValue: node.id,
  });

  // Facility name(s) — primary facility plus any additional bundled facilities.
  const primaryFacility = facilities.find((f) => f.id === node.action.facilityId);
  const primaryFacilityName = primaryFacility
    ? t(primaryFacility.id, {
        ns: "facility",
        defaultValue: primaryFacility.id,
      })
    : node.action.facilityId;

  const additionalFacilityNames = useMemo(() => {
    return node.additionalFacilities.map((fid: FacilityId) => {
      const fac = facilities.find((f) => f.id === fid);
      return fac ? t(fac.id, { ns: "facility", defaultValue: fac.id }) : fid;
    });
  }, [node.additionalFacilities, t]);

  /**
   * Display label per action kind:
   *
   * - `unlock` single        → "Filling Unit"
   * - `unlock` multi         → "Loader & Unloader"  (joined with " & ")
   * - `modeUnlock`           → "Refining Unit"      (the [LIQUID] badge to
   *                            the right disambiguates the mode)
   * - `capRaise`             → tech name (e.g. "Forge Expansion I")
   *                            which is already the right label for the
   *                            Facility Limits section; the extraction
   *                            script overrides hybrid techs to use the
   *                            milestone item's name ("Forge Expansion III")
   */
  const displayLabel = useMemo(() => {
    if (node.action.kind === "capRaise") return techName;
    if (additionalFacilityNames.length === 0) return primaryFacilityName;
    return [primaryFacilityName, ...additionalFacilityNames].join(" & ");
  }, [node.action.kind, additionalFacilityNames, primaryFacilityName, techName]);

  // Right-side annotation chip. Mode label + cap badge stay; the old
  // `+N` annotation for multi-facility unlocks is now folded into the
  // joined `displayLabel` instead.
  let annotation: React.ReactNode = null;
  if (node.action.kind === "modeUnlock") {
    annotation = (
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium rounded bg-muted px-1.5 py-0.5">
        {node.action.modeName}
      </span>
    );
  } else if (node.action.kind === "capRaise") {
    annotation = (
      <span
        className={cn(
          "text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5",
          "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        )}
      >
        +{node.action.delta} {t("aic.capDeltaLabel", { ns: "settings", defaultValue: "max" })}
      </span>
    );
  }

  /**
   * Recipes this tech unlocks, deduplicated for tooltip display.
   * Sourced at extraction time from `recipesByTech` (FactoryMachineCraftTable
   * joins) and collapsed on the composite key
   * (primary output itemId, localized recipe name). Both must match to
   * collapse to a single row:
   *
   *   - Same name + same output → one row (e.g. Separating Unit has
   *     67 input-variant recipes collapsing to 7 unique outputs;
   *     Refining Unit's 25 normal recipes collapse to 13).
   *   - Same name + different output → keep both (recipes that share a
   *     localized label but produce different items).
   *   - Different name + same output → keep both (alternative production
   *     methods with distinct names).
   *
   * First-occurrence order preserved via Map insertion order.
   *
   * Locale: collisions are stable across locales because two recipe ids
   * sharing the same upstream `formulaDesc.id` hash resolve to the same
   * string in every locale.
   *
   * The `recipesByTech.get(node.id) ?? []` lookup is inlined so an empty
   * fallback array isn't reallocated outside the memo — otherwise the
   * memo would invalidate on every render for techs with no recipes.
   */
  const uniqueRecipeIds = useMemo(() => {
    const recipeIds = recipesByTech.get(node.id) ?? [];
    const seen = new Map<string, RecipeId>();
    for (const rid of recipeIds) {
      const recipe = RECIPES_BY_ID.get(rid);
      const outputId = recipe?.outputs[0]?.itemId ?? "";
      const name = getRecipeName(rid);
      const key = `${outputId}\u0000${name}`;
      if (!seen.has(key)) seen.set(key, rid);
    }
    return Array.from(seen.values());
  }, [node.id]);

  const ariaLabel = isImmutable
    ? t("aic.row.ariaAlwaysAvailable", {
        ns: "settings",
        name: displayLabel,
        defaultValue: `${displayLabel}, always available`,
      })
    : isResearched
      ? t("aic.row.ariaResearched", {
          ns: "settings",
          name: displayLabel,
          defaultValue: `${displayLabel}, researched`,
        })
      : isLocked
        ? t("aic.row.ariaLocked", {
            ns: "settings",
            name: displayLabel,
            defaultValue: `${displayLabel}, prerequisites not met`,
          })
        : t("aic.row.ariaAvailable", {
            ns: "settings",
            name: displayLabel,
            defaultValue: `${displayLabel}, available to research`,
          });

  return (
    <div
      className={cn(
        "group/aicrow flex items-center gap-3 min-h-[44px] px-2 py-1.5 rounded-md",
        "transition-colors",
        isLocked
          ? "opacity-55"
          : "hover:bg-accent/60 dark:hover:bg-accent/40",
        isImmutable && "opacity-70",
      )}
    >
      <Checkbox
        checked={isResearched}
        disabled={isImmutable || isLocked}
        onCheckedChange={() => onToggle(node.id)}
        aria-label={ariaLabel}
        className={cn(isImmutable && "data-[state=checked]:bg-muted-foreground data-[state=checked]:border-muted-foreground")}
      />
      <img
        src={facilityIconUrl(node.action.facilityId)}
        alt=""
        aria-hidden="true"
        className="size-6 object-contain shrink-0"
        draggable={false}
        onError={(e) => {
          (e.target as HTMLImageElement).style.visibility = "hidden";
        }}
      />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span
          className={cn(
            "text-sm leading-tight truncate",
            isImmutable && "text-muted-foreground",
          )}
          title={displayLabel}
        >
          {displayLabel}
        </span>
        {annotation}
        {isImmutable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Lock className="size-3 text-muted-foreground shrink-0" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>
              {t("aic.row.alwaysAvailable", {
                ns: "settings",
                defaultValue: "Always available",
              })}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {uniqueRecipeIds.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="size-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/80 transition-colors shrink-0"
              aria-label={t("aic.row.showRecipes", {
                ns: "settings",
                defaultValue: "Show unlocked recipes",
              })}
            >
              <Info className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="left"
            variant="rich"
            className="max-w-xs text-xs leading-relaxed"
          >
            {/* Tooltip header: tech name as subtitle (preserves the original
              * game-flavour name without it dominating the row). */}
            <div className="px-3 pt-2.5 pb-2 border-b border-border/70">
              <div className="font-semibold">{displayLabel}</div>
              {techName !== displayLabel && (
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {techName}
                </div>
              )}
            </div>
            {/* Scrollable recipe list — max-height ~280px before scroll. */}
            <div className="px-3 py-2 max-h-[280px] overflow-y-auto">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
                {t("aic.row.unlocksLabel", {
                  ns: "settings",
                  defaultValue: "Unlocks",
                })}
              </div>
              <ul className="space-y-0.5">
                {uniqueRecipeIds.map((rid) => {
                  const iconUrl = recipePrimaryOutputIcon(rid);
                  return (
                    <li
                      key={rid}
                      className="flex items-center gap-1.5 leading-snug"
                    >
                      {iconUrl && (
                        <img
                          src={iconUrl}
                          alt=""
                          aria-hidden="true"
                          className="size-4 object-contain shrink-0"
                          draggable={false}
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.visibility =
                              "hidden";
                          }}
                        />
                      )}
                      <span className="min-w-0">{getRecipeName(rid)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export const AicNodeRow = memo(AicNodeRowImpl);
