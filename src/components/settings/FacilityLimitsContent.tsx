import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  RotateCcw,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { facilities } from "@/data";
import { facilityIconUrl } from "@/lib/facility-icons";
import type { AicNode, AicTechId, FacilityBaseCap } from "@/types/aic";
import type { DomainId } from "@/types/domain";
import type { FacilityId } from "@/types";

interface FacilityLimitsContentProps {
  /**
   * The region this content represents. Used to scope `targets` so each
   * region only lists its own facility caps — without it, the iteration
   * over `baseCaps` (registry-wide) would surface every region's targets.
   */
  domainId: DomainId;
  /** Cap-raise nodes for this region (other regions filtered out upstream). */
  capRaiseNodes: readonly AicNode[];
  researched: ReadonlySet<AicTechId>;
  baseCaps: readonly FacilityBaseCap[];
  capOverrides: ReadonlyMap<string, number>;
  effectiveCaps: ReadonlyMap<FacilityId, ReadonlyMap<DomainId, number>>;
  onToggle: (id: AicTechId) => void;
  onSetCapOverride: (
    facilityId: FacilityId,
    domainId: DomainId,
    value: number | null,
  ) => void;
  /** Bulk-activate every cap-raise upgrade for a facility (prereq cascade). */
  onActivateRaiseNodes: (ids: readonly AicTechId[]) => void;
  /** Bulk-deactivate cap-raises for a facility — the "Reset to base" path. */
  onDeactivateRaiseNodes: (ids: readonly AicTechId[]) => void;
}

function capKey(facilityId: FacilityId, domainId: DomainId): string {
  return `${facilityId}\u0000${domainId}`;
}

interface CapTarget {
  facilityId: FacilityId;
  domainId: DomainId;
  base: number;
  /** Cap-raise nodes targeting this (facility, domain), sorted by delta asc. */
  raiseNodes: AicNode[];
}

/**
 * Facility-limits body for one region — the "Limits" sub-tab content.
 * Mirrors the Plan tab's visual language: one collapsible card per capped
 * facility (icon + name + effective-cap pill in the header; cap-raise
 * checkboxes + the game/custom/effective grid inside). Returns `null` when
 * the region has no capped facilities.
 *
 * Cards default open (few facilities, and the cap controls are the point of
 * the tab); an expand/collapse-all toggle appears once there are ≥2.
 *
 * Reset model (Option B): per-card "Reset to base limit" drops every
 * researched cap-raise + clears the override → bare base cap. The
 * override-only reset is the implicit field-clear (empty the custom input).
 */
export function FacilityLimitsContent({
  domainId,
  capRaiseNodes,
  researched,
  baseCaps,
  capOverrides,
  effectiveCaps,
  onToggle,
  onSetCapOverride,
  onActivateRaiseNodes,
  onDeactivateRaiseNodes,
}: FacilityLimitsContentProps) {
  const { t } = useTranslation(["facility", "settings", "aic"]);

  // Collate cap-raise nodes by (facility, domain) and pair with base caps.
  // Filtered to the current region so each region surfaces only its own
  // targets — `baseCaps` is a global registry across every (facility,
  // domain) pair.
  const targets = useMemo<CapTarget[]>(() => {
    const byKey = new Map<string, CapTarget>();

    for (const base of baseCaps) {
      if (base.domainId !== domainId) continue;
      byKey.set(capKey(base.facilityId, base.domainId), {
        facilityId: base.facilityId,
        domainId: base.domainId,
        base: base.base,
        raiseNodes: [],
      });
    }

    for (const node of capRaiseNodes) {
      if (node.action.kind !== "capRaise") continue;
      if (node.action.domainId !== domainId) continue;
      const key = capKey(node.action.facilityId, node.action.domainId);
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          facilityId: node.action.facilityId,
          domainId: node.action.domainId,
          base: 0,
          raiseNodes: [],
        };
        byKey.set(key, entry);
      }
      entry.raiseNodes.push(node);
    }

    // Sort raises by delta ascending for stable display (+1 → +2 → +4).
    for (const entry of byKey.values()) {
      entry.raiseNodes.sort((a, b) => {
        const da = a.action.kind === "capRaise" ? a.action.delta : 0;
        const db = b.action.kind === "capRaise" ? b.action.delta : 0;
        return da - db;
      });
    }

    return Array.from(byKey.values()).sort((a, b) =>
      a.facilityId.localeCompare(b.facilityId),
    );
  }, [capRaiseNodes, baseCaps, domainId]);

  // Controlled card-expand state. Tracked as the set of CLOSED keys so the
  // default (empty) is all-open. Keyed by `capKey`, so it never collides
  // across regions.
  const [closedKeys, setClosedKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const targetKeys = targets.map((tg) => capKey(tg.facilityId, tg.domainId));
  const allOpen = targetKeys.every((k) => !closedKeys.has(k));
  const handleCardOpenChange = (key: string, open: boolean) => {
    setClosedKeys((prev) => {
      const next = new Set(prev);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleAll = () => {
    setClosedKeys(allOpen ? new Set(targetKeys) : new Set());
  };

  if (targets.length === 0) return null;

  return (
    <div className="space-y-2">
      {targets.length >= 2 && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={toggleAll}
          >
            {allOpen ? (
              <ChevronsDownUp className="size-3.5" />
            ) : (
              <ChevronsUpDown className="size-3.5" />
            )}
            {allOpen
              ? t("aic.collapseAll", {
                  ns: "settings",
                  defaultValue: "Collapse all",
                })
              : t("aic.expandAll", {
                  ns: "settings",
                  defaultValue: "Expand all",
                })}
          </Button>
        </div>
      )}
      {targets.map((target) => {
        const key = capKey(target.facilityId, target.domainId);
        return (
          <CapTargetRow
            key={key}
            target={target}
            researched={researched}
            capOverrides={capOverrides}
            effectiveCaps={effectiveCaps}
            open={!closedKeys.has(key)}
            onOpenChange={(o) => handleCardOpenChange(key, o)}
            onToggle={onToggle}
            onSetCapOverride={onSetCapOverride}
            onActivateRaiseNodes={onActivateRaiseNodes}
            onDeactivateRaiseNodes={onDeactivateRaiseNodes}
          />
        );
      })}
    </div>
  );
}

interface CapTargetRowProps {
  target: CapTarget;
  researched: ReadonlySet<AicTechId>;
  capOverrides: ReadonlyMap<string, number>;
  effectiveCaps: ReadonlyMap<FacilityId, ReadonlyMap<DomainId, number>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (id: AicTechId) => void;
  onSetCapOverride: (
    facilityId: FacilityId,
    domainId: DomainId,
    value: number | null,
  ) => void;
  onActivateRaiseNodes: (ids: readonly AicTechId[]) => void;
  onDeactivateRaiseNodes: (ids: readonly AicTechId[]) => void;
}

function CapTargetRow({
  target,
  researched,
  capOverrides,
  effectiveCaps,
  open,
  onOpenChange,
  onToggle,
  onSetCapOverride,
  onActivateRaiseNodes,
  onDeactivateRaiseNodes,
}: CapTargetRowProps) {
  const { t } = useTranslation(["facility", "settings", "aic"]);

  const facility = facilities.find((f) => f.id === target.facilityId);
  const facilityName = facility
    ? t(facility.id, { ns: "facility", defaultValue: facility.id })
    : target.facilityId;

  const overrideKey = capKey(target.facilityId, target.domainId);
  const overrideValue = capOverrides.get(overrideKey);
  const hasOverride = overrideValue !== undefined;
  const effective =
    effectiveCaps.get(target.facilityId)?.get(target.domainId) ?? 0;

  // "Game cap" = base + researched cap-raises (ignoring overrides).
  const gameCap = useMemo(() => {
    let value = target.base;
    for (const node of target.raiseNodes) {
      if (researched.has(node.id) && node.action.kind === "capRaise") {
        value += node.action.delta;
      }
    }
    return value;
  }, [target, researched]);

  const [draft, setDraft] = useState<string>(
    hasOverride ? String(overrideValue) : "",
  );

  // Per-facility Activate Check button: hide when there's nothing to
  // activate (no cap-raise nodes) or everything is already researched.
  const allRaised = useMemo(
    () => target.raiseNodes.every((n) => researched.has(n.id)),
    [target.raiseNodes, researched],
  );
  const canActivateAny = target.raiseNodes.length > 0 && !allRaised;

  // "Reset to base limit": drop every researched cap-raise + clear the
  // override → bare base cap. Only meaningful when there's something to undo.
  const researchedRaiseIds = useMemo(
    () => target.raiseNodes.filter((n) => researched.has(n.id)).map((n) => n.id),
    [target.raiseNodes, researched],
  );
  const canResetToBase = hasOverride || researchedRaiseIds.length > 0;
  const handleResetToBase = () => {
    setDraft("");
    if (hasOverride) {
      onSetCapOverride(target.facilityId, target.domainId, null);
    }
    if (researchedRaiseIds.length > 0) {
      onDeactivateRaiseNodes(researchedRaiseIds);
    }
  };

  const hasActions = canActivateAny || canResetToBase;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div
        className={cn(
          "rounded-md border border-border/60 bg-background/40",
          open && "shadow-xs",
        )}
      >
        <div className="relative flex items-stretch">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 min-h-[44px]",
                hasActions ? "pr-20" : "pr-3",
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
              <img
                src={facilityIconUrl(target.facilityId)}
                alt=""
                aria-hidden="true"
                className="size-6 object-contain shrink-0"
                draggable={false}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.visibility = "hidden";
                }}
              />
              <span className="text-sm font-medium flex-1 min-w-0 truncate">
                {facilityName}
              </span>
              <span
                className={cn(
                  "text-[11px] tabular-nums font-medium rounded px-1.5 py-0.5 shrink-0",
                  hasOverride
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    : "bg-muted text-muted-foreground",
                )}
                title={t("aic.facilityLimits.effective", {
                  ns: "settings",
                  defaultValue: "Effective",
                })}
              >
                {effective}
              </span>
            </button>
          </CollapsibleTrigger>
          {hasActions && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {canActivateAny && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 text-muted-foreground hover:text-foreground hover:bg-accent/80"
                  onClick={() =>
                    onActivateRaiseNodes(target.raiseNodes.map((n) => n.id))
                  }
                  aria-label={t("aic.activateAll", {
                    ns: "settings",
                    defaultValue: "Activate all",
                  })}
                  title={t("aic.activateAll", {
                    ns: "settings",
                    defaultValue: "Activate all",
                  })}
                >
                  <Check className="size-3.5" />
                </Button>
              )}
              {canResetToBase && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 text-muted-foreground hover:text-foreground hover:bg-accent/80"
                  onClick={handleResetToBase}
                  aria-label={t("aic.facilityLimits.resetToBase", {
                    ns: "settings",
                    defaultValue: "Reset to base limit",
                  })}
                  title={t("aic.facilityLimits.resetToBase", {
                    ns: "settings",
                    defaultValue: "Reset to base limit",
                  })}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>

        <CollapsibleContent>
          <div className="px-3 pb-3 pt-1 space-y-2">
            {target.raiseNodes.length > 0 && (
              <div className="space-y-0.5">
                {target.raiseNodes.map((node) => {
                  if (node.action.kind !== "capRaise") return null;
                  const isResearched = researched.has(node.id);
                  const prereqsMet = node.preNodes.every((p) =>
                    researched.has(p),
                  );
                  const isLocked = !prereqsMet && !isResearched;
                  const nodeName = t(`nodes.${node.id}.name`, {
                    ns: "aic",
                    defaultValue: node.id,
                  });
                  return (
                    <label
                      key={node.id}
                      className={cn(
                        "flex items-center gap-2 py-1 px-1 rounded text-xs",
                        isLocked
                          ? "opacity-55 cursor-not-allowed"
                          : "hover:bg-accent/40 cursor-pointer",
                      )}
                    >
                      <Checkbox
                        checked={isResearched}
                        disabled={isLocked}
                        onCheckedChange={() => onToggle(node.id)}
                        aria-label={nodeName}
                      />
                      <span className="flex-1 min-w-0 truncate">{nodeName}</span>
                      <span className="text-amber-700 dark:text-amber-400 font-semibold tabular-nums shrink-0">
                        +{node.action.delta}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 items-center text-xs pt-1 border-t border-border/40">
              <span className="text-muted-foreground">
                {t("aic.facilityLimits.gameCap", {
                  ns: "settings",
                  defaultValue: "Game limit",
                })}
              </span>
              <span className="font-medium tabular-nums">{gameCap}</span>

              <label
                className="text-muted-foreground"
                htmlFor={`cap-override-${overrideKey}`}
              >
                {t("aic.facilityLimits.customCap", {
                  ns: "settings",
                  defaultValue: "Custom",
                })}
              </label>
              <Input
                id={`cap-override-${overrideKey}`}
                type="number"
                inputMode="numeric"
                value={draft}
                placeholder={String(gameCap)}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  if (draft === "") {
                    onSetCapOverride(target.facilityId, target.domainId, null);
                    return;
                  }
                  const v = parseInt(draft, 10);
                  if (Number.isFinite(v)) {
                    onSetCapOverride(target.facilityId, target.domainId, v);
                  } else {
                    setDraft(hasOverride ? String(overrideValue) : "");
                  }
                }}
                className="h-7 w-16 text-xs tabular-nums justify-self-end"
              />

              {hasOverride && (
                <>
                  <span className="text-muted-foreground">
                    {t("aic.facilityLimits.effective", {
                      ns: "settings",
                      defaultValue: "Effective",
                    })}
                  </span>
                  <span className="font-semibold tabular-nums text-foreground justify-self-end">
                    {effective}
                  </span>
                </>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
