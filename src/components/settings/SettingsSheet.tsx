import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useDomainSettingsContext } from "@/contexts/domain-settings-context";
import { previewActivationDelta } from "@/lib/aic-cascade";
import { pickLatestActive } from "@/hooks/useDomainSettings";
import type { AicGroupId, AicLayerId, AicTechId } from "@/types/aic";
import type { Domain, DomainId } from "@/types/domain";
import type { ItemId } from "@/types";

import { AicPlanCard } from "./AicPlanCard";
import { DomainSection } from "./DomainSection";
import { RawLimitsCard } from "./RawLimitsCard";
import { RegionPicker } from "./RegionPicker";
import { rawAvailabilityByDomain } from "@/data";

interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsSheet({ open, onOpenChange }: SettingsSheetProps) {
  const { t } = useTranslation(["settings", "aic", "domain"]);

  const {
    domains,
    activeDomains,
    toggleDomain,
    currentDomain,
    setCurrentDomain,
    aic,
    rawLimits,
  } = useDomainSettingsContext();

  const orderedDomains = useMemo<readonly Domain[]>(
    () => [...domains].sort((a, b) => a.sortId - b.sortId),
    [domains],
  );

  const aicGroups = aic.groups;
  const groupsByDomain = useMemo(() => {
    const out = new Map<DomainId, typeof aicGroups[number][]>();
    for (const group of aicGroups) {
      const bucket = out.get(group.domainId) ?? [];
      bucket.push(group);
      out.set(group.domainId, bucket);
    }
    return out;
  }, [aicGroups]);

  // Domain activation is silent in the normal case — the switch flip is
  // its own visual feedback. EXCEPT when deactivating the user's current
  // factory region: the hook auto-falls-back `currentDomain` to the
  // next-latest active region, and we surface that as a toast so the
  // change isn't silent.
  const handleToggleDomain = useCallback(
    (domain: Domain) => {
      const willAutoFallback =
        !domain.isPinned &&
        domain.id === currentDomain &&
        activeDomains.has(domain.id);
      toggleDomain(domain.id);
      if (willAutoFallback) {
        // The auto-fallback target = `pickLatestActive(activeDomains \ {id})`.
        // We can't read it from the hook synchronously here (state has
        // batched but hasn't re-rendered), so call the same helper the
        // hook does — keeps both sides in lockstep if the tie-breaking
        // rule ever changes.
        const nextActive = new Set(activeDomains);
        nextActive.delete(domain.id);
        const nextId = pickLatestActive(nextActive);
        const next = domains.find((d) => d.id === nextId);
        // Pinned domain is always active by construction, so `next` is
        // never undefined in practice; the fallback keeps types happy.
        const fallbackName = next
          ? t(`domains.${next.id}.name`, {
              ns: "domain",
              defaultValue: next.id,
            })
          : "";
        toast.info(
          t("region.toast.switchedToFallback", {
            ns: "settings",
            name: fallbackName,
            defaultValue: `Switched to ${fallbackName} factory`,
          }),
        );
      }
    },
    [toggleDomain, currentDomain, activeDomains, domains, t],
  );

  const handleActivateGroup = useCallback(
    (groupId: AicGroupId) => {
      const targets = aic.nodes.filter((n) => n.groupId === groupId).map((n) => n.id);
      const delta = previewActivationDelta(targets, aic.researched, aic.nodes);
      aic.activateGroup(groupId);
      if (delta.primary + delta.prereqs > 0) {
        toast.success(
          t("aic.toast.activatedGroup", {
            ns: "settings",
            primary: delta.primary,
            prereqs: delta.prereqs,
            defaultValue:
              delta.prereqs > 0
                ? `Activated ${delta.primary} facilities (+${delta.prereqs} prereqs)`
                : `Activated ${delta.primary} facilities`,
          }),
        );
      }
    },
    [aic, t],
  );

  const handleActivateLayer = useCallback(
    (layerId: string) => {
      const targets = aic.nodes
        .filter((n) => n.layerId === (layerId as AicLayerId))
        .map((n) => n.id);
      const delta = previewActivationDelta(targets, aic.researched, aic.nodes);
      aic.activateLayer(layerId as AicLayerId);
      if (delta.primary + delta.prereqs > 0) {
        toast.success(
          t("aic.toast.activatedLayer", {
            ns: "settings",
            primary: delta.primary,
            prereqs: delta.prereqs,
            defaultValue:
              delta.prereqs > 0
                ? `Activated ${delta.primary} facilities (+${delta.prereqs} prereqs)`
                : `Activated ${delta.primary} facilities`,
          }),
        );
      }
    },
    [aic, t],
  );

  const handleResetGroup = useCallback(
    (groupId: AicGroupId) => {
      aic.resetGroupToDefaults(groupId);
      toast.info(
        t("aic.toast.resetGroup", {
          ns: "settings",
          defaultValue: "Reset plan to defaults",
        }),
      );
    },
    [aic, t],
  );

  const handleToggleNode = useCallback(
    (id: AicTechId) => {
      // Surface a hint when the click would be a no-op (prereqs unmet).
      const node = aic.nodes.find((n) => n.id === id);
      if (!node) return;
      if (aic.researched.has(id)) {
        aic.toggleNode(id);
        return;
      }
      const prereqsMet = node.preNodes.every((p: AicTechId) =>
        aic.researched.has(p),
      );
      if (!prereqsMet) {
        toast.warning(
          t("aic.toast.prereqsRequired", {
            ns: "settings",
            defaultValue: "Research the prerequisite tech first.",
          }),
        );
        return;
      }
      aic.toggleNode(id);
    },
    [aic, t],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md md:max-w-lg lg:max-w-[600px] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="px-5 pt-5 pb-4 border-b">
          <SheetTitle className="text-lg">
            {t("title", { ns: "settings", defaultValue: "Settings" })}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {t("aic.intro", {
              ns: "settings",
              defaultValue:
                "Choose which AIC technologies you've researched. This filters the items and formulas available to your plans.",
            })}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <RegionPicker
            domains={domains}
            activeDomains={activeDomains}
            currentDomain={currentDomain}
            onChange={setCurrentDomain}
          />
          {orderedDomains.map((domain) => {
            const isActive = activeDomains.has(domain.id);
            const groups = groupsByDomain.get(domain.id) ?? [];
            const regionRawMaterials =
              rawAvailabilityByDomain.get(domain.id) ?? new Set<ItemId>();
            return (
              <DomainSection
                key={domain.id}
                domain={domain}
                isActive={isActive}
                onToggle={() => handleToggleDomain(domain)}
              >
                {groups.map((group) => (
                  <AicPlanCard
                    key={group.id}
                    group={group}
                    layers={aic.layers}
                    nodes={aic.nodes}
                    researched={aic.researched}
                    baseCaps={aic.baseCaps}
                    capOverrides={aic.capOverrides}
                    effectiveCaps={aic.effectiveCaps}
                    isAtDefaults={aic.isAtDefaultsByGroup.get(group.id) ?? false}
                    onToggleNode={handleToggleNode}
                    onActivateLayer={handleActivateLayer}
                    onActivateGroup={() => handleActivateGroup(group.id)}
                    onResetGroup={() => handleResetGroup(group.id)}
                    onSetCapOverride={aic.setCapOverride}
                    onActivateRaiseNodes={aic.activateNodes}
                  />
                ))}
                <RawLimitsCard
                  domainId={domain.id}
                  regionRawMaterials={regionRawMaterials}
                  overrides={rawLimits.overrides}
                  onSetLimit={rawLimits.setRawLimitOverride}
                />
              </DomainSection>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
