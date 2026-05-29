import { useMemo, useState } from "react";
import { Check, ChevronDown, RotateCcw } from "lucide-react";
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
import type {
  AicNode,
  AicTechId,
  FacilityBaseCap,
} from "@/types/aic";
import type { DomainId } from "@/types/domain";
import type { FacilityId } from "@/types";

interface AicFacilityLimitsProps {
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
  /**
   * Bulk-activate every cap-raise upgrade for a given facility. Wired by
   * the per-facility Check button in the row header. The hook applies a
   * prereq cascade so transitive dependencies tick automatically.
   */
  onActivateRaiseNodes: (ids: readonly AicTechId[]) => void;
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

export function AicFacilityLimits({
  capRaiseNodes,
  researched,
  baseCaps,
  capOverrides,
  effectiveCaps,
  onToggle,
  onSetCapOverride,
  onActivateRaiseNodes,
}: AicFacilityLimitsProps) {
  const { t } = useTranslation(["facility", "settings", "aic"]);
  const [open, setOpen] = useState(false);

  // Collate cap-raise nodes by (facility, domain) and pair with base caps.
  const targets = useMemo<CapTarget[]>(() => {
    const byKey = new Map<string, CapTarget>();

    for (const base of baseCaps) {
      byKey.set(capKey(base.facilityId, base.domainId), {
        facilityId: base.facilityId,
        domainId: base.domainId,
        base: base.base,
        raiseNodes: [],
      });
    }

    for (const node of capRaiseNodes) {
      if (node.action.kind !== "capRaise") continue;
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

    return Array.from(byKey.values()).sort((a, b) => {
      if (a.facilityId !== b.facilityId)
        return a.facilityId.localeCompare(b.facilityId);
      return a.domainId.localeCompare(b.domainId);
    });
  }, [capRaiseNodes, baseCaps]);

  if (targets.length === 0) return null;

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
              {t("aic.facilityLimits.title", {
                ns: "settings",
                defaultValue: "Facility limits",
              })}
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {targets.length}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 pt-1 space-y-3">
            {targets.map((target) => (
              <CapTargetRow
                key={capKey(target.facilityId, target.domainId)}
                target={target}
                researched={researched}
                capOverrides={capOverrides}
                effectiveCaps={effectiveCaps}
                onToggle={onToggle}
                onSetCapOverride={onSetCapOverride}
                onActivateRaiseNodes={onActivateRaiseNodes}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

interface CapTargetRowProps {
  target: CapTarget;
  researched: ReadonlySet<AicTechId>;
  capOverrides: ReadonlyMap<string, number>;
  effectiveCaps: ReadonlyMap<FacilityId, ReadonlyMap<DomainId, number>>;
  onToggle: (id: AicTechId) => void;
  onSetCapOverride: (
    facilityId: FacilityId,
    domainId: DomainId,
    value: number | null,
  ) => void;
  onActivateRaiseNodes: (ids: readonly AicTechId[]) => void;
}

function CapTargetRow({
  target,
  researched,
  capOverrides,
  effectiveCaps,
  onToggle,
  onSetCapOverride,
  onActivateRaiseNodes,
}: CapTargetRowProps) {
  const { t } = useTranslation(["facility", "settings", "aic"]);

  const facility = facilities.find((f) => f.id === target.facilityId);
  const facilityName = facility
    ? t(facility.id, { ns: "facility", defaultValue: facility.id })
    : target.facilityId;

  const overrideKey = capKey(target.facilityId, target.domainId);
  const overrideValue = capOverrides.get(overrideKey);
  const hasOverride = overrideValue !== undefined;
  const effective = effectiveCaps.get(target.facilityId)?.get(target.domainId) ?? 0;

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

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2.5">
      <div className="flex items-center gap-2 min-w-0 min-h-7">
        <span className="text-sm font-medium truncate flex-1">
          {facilityName}
        </span>
        {canActivateAny && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 text-muted-foreground hover:text-foreground hover:bg-accent/80 shrink-0"
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
      </div>

      {target.raiseNodes.length > 0 && (
        <div className="space-y-0.5">
          {target.raiseNodes.map((node) => {
            if (node.action.kind !== "capRaise") return null;
            const isResearched = researched.has(node.id);
            const prereqsMet = node.preNodes.every((p) => researched.has(p));
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
            defaultValue: "Game cap",
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
        <div className="flex items-center gap-1">
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
            className="h-7 w-16 text-xs tabular-nums"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setDraft("");
              onSetCapOverride(target.facilityId, target.domainId, null);
            }}
            disabled={!hasOverride}
            aria-label={t("aic.facilityLimits.reset", {
              ns: "settings",
              defaultValue: "Reset",
            })}
          >
            <RotateCcw className="size-3" />
          </Button>
        </div>

        {hasOverride && (
          <>
            <span className="text-muted-foreground">
              {t("aic.facilityLimits.effective", {
                ns: "settings",
                defaultValue: "Effective",
              })}
            </span>
            <span className="font-semibold tabular-nums text-foreground">
              {effective}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
