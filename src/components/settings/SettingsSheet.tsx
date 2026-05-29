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
import type { AicGroupId, AicLayerId, AicTechId } from "@/types/aic";
import type { Domain, DomainId } from "@/types/domain";

import { AicPlanCard } from "./AicPlanCard";
import { DomainSection } from "./DomainSection";

interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsSheet({ open, onOpenChange }: SettingsSheetProps) {
  const { t } = useTranslation(["settings", "aic", "domain"]);

  const { domains, activeDomains, toggleDomain, aic } = useDomainSettingsContext();

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

  // Domain activation is silent — the switch flip is its own visual
  // feedback (no toast needed). State preservation across deactivation
  // is implicit in `toggleDomain`'s soft semantics.
  const handleToggleDomain = useCallback(
    (domain: Domain) => {
      toggleDomain(domain.id);
    },
    [toggleDomain],
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
                "Choose which AIC technologies you've researched. In a future update, this will filter the items and recipes available to your plans.",
            })}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {orderedDomains.map((domain) => {
            const isActive = activeDomains.has(domain.id);
            const groups = groupsByDomain.get(domain.id) ?? [];
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
              </DomainSection>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
