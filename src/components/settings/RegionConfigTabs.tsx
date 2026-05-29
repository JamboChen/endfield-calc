import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDomainSettingsContext } from "@/contexts/domain-settings-context";
import { items, rawAvailabilityByDomain } from "@/data";
import {
  countAicResearched,
  countCustomizedCaps,
  countRawSourced,
  filterRegionRawItems,
} from "@/lib/settings-helpers";
import { cn } from "@/lib/utils";
import type { AicGroupId, AicTechId } from "@/types/aic";
import type { DomainId } from "@/types/domain";
import type { Item, ItemId } from "@/types";

import { AicPlanContent } from "./AicPlanContent";
import { FacilityLimitsContent } from "./FacilityLimitsContent";
import { RawLimitsContent } from "./RawLimitsContent";

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
 * Category sub-tabs (Plan · Limits · Raws) for one region. Each trigger
 * carries a compact count badge; the active panel leads with a
 * word-labeled status line ("12 / 14 researched", "2 customized",
 * "3 / 8 sourced") so the three counts never read as identical `X/Y`
 * pills. Hosts the three chrome-less content components.
 */
export function RegionConfigTabs({
  editingDomain,
  onToggleNode,
  onActivateLayer,
  onActivateGroup,
  onResetGroup,
}: RegionConfigTabsProps) {
  const { t } = useTranslation(["settings"]);
  const { aic, rawLimits } = useDomainSettingsContext();

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

  const planCount = useMemo(
    () => countAicResearched(aic.nodes, aic.groups, aic.researched, editingDomain),
    [aic.nodes, aic.groups, aic.researched, editingDomain],
  );
  const customizedCount = useMemo(
    () => countCustomizedCaps(aic.capOverrides, editingDomain),
    [aic.capOverrides, editingDomain],
  );
  const rawCount = useMemo(
    () => countRawSourced(rawRowItems, rawLimits.overrides, editingDomain),
    [rawRowItems, rawLimits.overrides, editingDomain],
  );

  return (
    <Tabs defaultValue="plan" className="gap-3">
      <TabsList className="w-full">
        <TabsTrigger value="plan">
          {t("tabs.plan", { ns: "settings", defaultValue: "Plan" })}
          {planCount.total > 0 && (
            <CountBadge>
              {planCount.done}/{planCount.total}
            </CountBadge>
          )}
        </TabsTrigger>
        <TabsTrigger value="limits">
          {t("tabs.limits", { ns: "settings", defaultValue: "Limits" })}
          {customizedCount > 0 && <CountBadge>{customizedCount}</CountBadge>}
        </TabsTrigger>
        <TabsTrigger value="raws">
          {t("tabs.raws", { ns: "settings", defaultValue: "Raws" })}
          {rawCount.total > 0 && (
            <CountBadge>
              {rawCount.done}/{rawCount.total}
            </CountBadge>
          )}
        </TabsTrigger>
      </TabsList>

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
