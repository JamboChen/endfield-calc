import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDomainSettingsContext } from "@/contexts/domain-settings-context";
import { items, rawAvailabilityByDomain, regionStructures } from "@/data";
import {
  countAicResearched,
  countCustomizedCaps,
  countFacilityCapTargets,
  countRawSourced,
  countRegionStructuresEnabled,
  filterRegionRawItems,
  resolveActiveTab,
} from "@/lib/settings-helpers";
import { cn } from "@/lib/utils";
import type { AicGroupId, AicTechId } from "@/types/aic";
import type { DomainId } from "@/types/domain";
import type { Item, ItemId } from "@/types";

import { AicPlanContent } from "./AicPlanContent";
import { FacilityLimitsContent } from "./FacilityLimitsContent";
import { RawLimitsContent } from "./RawLimitsContent";
import { StructuresContent } from "./StructuresContent";

// Module-scope item index for the raw-sourced count derivation.
const ITEMS_BY_ID: ReadonlyMap<ItemId, Item> = new Map(
  items.map((i) => [i.id, i] as const),
);

interface RegionConfigTabsProps {
  /** Region being configured (the Settings "Configuring" context). */
  editingDomain: DomainId;
  // Toast-wrapped action handlers owned by SettingsSheet (cascade deltas,
  // prereq warnings, reset feedback). The pure aic/rawLimits setters are
  // read from context directly.
  onToggleNode: (id: AicTechId) => void;
  onActivateLayer: (layerId: string) => void;
  onActivateGroup: (groupId: AicGroupId) => void;
  onResetGroup: (groupId: AicGroupId) => void;
}

/**
 * Category sub-tabs for one region. Tabs render only when the region has
 * content for them (Plan / Resources are effectively always present;
 * Limits shows only with cap targets; Structures only for regions with
 * special structures), so the set varies per region. Tabs are controlled
 * with a fallback (`resolveActiveTab`) so switching to a region that
 * lacks the selected tab does not leave a dangling selection.
 *
 * Each trigger carries a compact count badge; the active panel leads with
 * a word-labeled status line so the counts never read as identical `X/Y`
 * pills.
 */
export function RegionConfigTabs({
  editingDomain,
  onToggleNode,
  onActivateLayer,
  onActivateGroup,
  onResetGroup,
}: RegionConfigTabsProps) {
  const { t } = useTranslation(["settings"]);
  const { aic, rawLimits, structures } = useDomainSettingsContext();

  const groups = useMemo(
    () => aic.groups.filter((g) => g.domainId === editingDomain),
    [aic.groups, editingDomain],
  );

  const capRaiseNodes = useMemo(
    () =>
      aic.nodes.filter(
        (n) => n.action.kind === "capRaise" && n.action.domainId === editingDomain,
      ),
    [aic.nodes, editingDomain],
  );

  const regionRawMaterials = useMemo(
    () => rawAvailabilityByDomain.get(editingDomain) ?? new Set<ItemId>(),
    [editingDomain],
  );

  const rawRowItems = useMemo(
    () => filterRegionRawItems(regionRawMaterials, ITEMS_BY_ID),
    [regionRawMaterials],
  );

  const regionStructureList = useMemo(
    () => regionStructures.get(editingDomain) ?? [],
    [editingDomain],
  );

  const planCount = useMemo(
    () => countAicResearched(aic.nodes, aic.groups, aic.researched, editingDomain),
    [aic.nodes, aic.groups, aic.researched, editingDomain],
  );
  const customizedCount = useMemo(
    () => countCustomizedCaps(aic.capOverrides, editingDomain),
    [aic.capOverrides, editingDomain],
  );
  const capTargetCount = useMemo(
    () => countFacilityCapTargets(aic.baseCaps, capRaiseNodes, editingDomain),
    [aic.baseCaps, capRaiseNodes, editingDomain],
  );
  const rawCount = useMemo(
    () => countRawSourced(rawRowItems, rawLimits.overrides, editingDomain),
    [rawRowItems, rawLimits.overrides, editingDomain],
  );
  const structuresCount = useMemo(
    () =>
      countRegionStructuresEnabled(
        structures.enabled,
        regionStructureList,
        editingDomain,
      ),
    [structures.enabled, regionStructureList, editingDomain],
  );

  // A tab shows only when its region has content for it.
  const planAvailable = groups.length > 0;
  const limitsAvailable = capTargetCount > 0;
  const rawsAvailable = rawCount.total > 0;
  const structuresAvailable = regionStructureList.length > 0;

  const availableTabs = useMemo(() => {
    const out: string[] = [];
    if (planAvailable) out.push("plan");
    if (limitsAvailable) out.push("limits");
    if (rawsAvailable) out.push("raws");
    if (structuresAvailable) out.push("structures");
    return out;
  }, [planAvailable, limitsAvailable, rawsAvailable, structuresAvailable]);

  // Controlled tabs: preserve the user's selection across region switches,
  // but fall back to the first available tab when the selected one is not
  // present for the current region.
  const [activeTab, setActiveTab] = useState("plan");
  const effectiveTab = resolveActiveTab(activeTab, availableTabs);

  return (
    <Tabs value={effectiveTab} onValueChange={setActiveTab} className="gap-3">
      <TabsList className="w-full">
        {planAvailable && (
          <TabsTrigger value="plan">
            {t("tabs.plan", { ns: "settings", defaultValue: "Plan" })}
            {planCount.total > 0 && (
              <CountBadge>
                {planCount.done}/{planCount.total}
              </CountBadge>
            )}
          </TabsTrigger>
        )}
        {limitsAvailable && (
          <TabsTrigger value="limits">
            {t("tabs.limits", { ns: "settings", defaultValue: "Limits" })}
            {customizedCount > 0 && <CountBadge>{customizedCount}</CountBadge>}
          </TabsTrigger>
        )}
        {rawsAvailable && (
          <TabsTrigger value="raws">
            {t("tabs.raws", { ns: "settings", defaultValue: "Resources" })}
            {rawCount.total > 0 && (
              <CountBadge>
                {rawCount.done}/{rawCount.total}
              </CountBadge>
            )}
          </TabsTrigger>
        )}
        {structuresAvailable && (
          <TabsTrigger value="structures">
            {t("tabs.structures", { ns: "settings", defaultValue: "Structures" })}
            {structuresCount.total > 0 && (
              <CountBadge>
                {structuresCount.done}/{structuresCount.total}
              </CountBadge>
            )}
          </TabsTrigger>
        )}
      </TabsList>

      {planAvailable && (
        <TabsContent value="plan" className="space-y-3">
          {planCount.total > 0 && (
            <StatusLine>
              {t("status.researched", {
                ns: "settings",
                done: planCount.done,
                total: planCount.total,
                defaultValue: "{{done}} / {{total}} researched",
              })}
            </StatusLine>
          )}
          <AicPlanContent
            groups={groups}
            layers={aic.layers}
            nodes={aic.nodes}
            researched={aic.researched}
            isAtDefaultsByGroup={aic.isAtDefaultsByGroup}
            onToggleNode={onToggleNode}
            onActivateLayer={onActivateLayer}
            onActivateGroup={onActivateGroup}
            onResetGroup={onResetGroup}
          />
        </TabsContent>
      )}

      {limitsAvailable && (
        <TabsContent value="limits" className="space-y-3">
          {customizedCount > 0 && (
            <StatusLine>
              {t("status.customized", {
                ns: "settings",
                n: customizedCount,
                defaultValue: "{{n}} customized",
              })}
            </StatusLine>
          )}
          <FacilityLimitsContent
            domainId={editingDomain}
            capRaiseNodes={capRaiseNodes}
            researched={aic.researched}
            baseCaps={aic.baseCaps}
            capOverrides={aic.capOverrides}
            effectiveCaps={aic.effectiveCaps}
            onToggle={onToggleNode}
            onSetCapOverride={aic.setCapOverride}
            onActivateRaiseNodes={aic.activateNodes}
            onDeactivateRaiseNodes={aic.deactivateNodes}
          />
        </TabsContent>
      )}

      {rawsAvailable && (
        <TabsContent value="raws" className="space-y-3">
          {rawCount.total > 0 && (
            <StatusLine>
              {t("status.sourced", {
                ns: "settings",
                done: rawCount.done,
                total: rawCount.total,
                defaultValue: "{{done}} / {{total}} sourced",
              })}
            </StatusLine>
          )}
          <RawLimitsContent
            domainId={editingDomain}
            regionRawMaterials={regionRawMaterials}
            overrides={rawLimits.overrides}
            onSetLimit={rawLimits.setRawLimitOverride}
          />
        </TabsContent>
      )}

      {structuresAvailable && (
        <TabsContent value="structures" className="space-y-3">
          {structuresCount.total > 0 && (
            <StatusLine>
              {t("status.enabled", {
                ns: "settings",
                done: structuresCount.done,
                total: structuresCount.total,
                defaultValue: "{{done}} / {{total}} enabled",
              })}
            </StatusLine>
          )}
          <StructuresContent
            domainId={editingDomain}
            structures={regionStructureList}
            enabled={structures.enabled}
            onToggle={structures.toggle}
          />
        </TabsContent>
      )}
    </Tabs>
  );
}

function CountBadge({ children }: { children: ReactNode }) {
  return (
    <span className="ml-1 text-[10px] tabular-nums font-medium rounded px-1 py-0.5 bg-background/70 text-muted-foreground">
      {children}
    </span>
  );
}

function StatusLine({ children }: { children: ReactNode }) {
  return (
    <p className={cn("text-xs font-medium text-muted-foreground px-1")}>
      {children}
    </p>
  );
}
