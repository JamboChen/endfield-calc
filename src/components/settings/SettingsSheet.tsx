import { useCallback, useEffect, useRef, useState } from "react";
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
import { resolveEditingDomain } from "@/lib/settings-helpers";
import type { AicGroupId, AicLayerId, AicTechId } from "@/types/aic";
import type { DomainId } from "@/types/domain";

import { RegionConfigTabs } from "./RegionConfigTabs";
import { RegionNavMenu } from "./RegionNavMenu";

interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsSheet({ open, onOpenChange }: SettingsSheetProps) {
  const { t } = useTranslation(["settings", "aic", "domain"]);

  const { activeDomains, currentDomain, aic } = useDomainSettingsContext();

  // Local "Configuring" context — decoupled from the factory region.
  const [editingDomain, setEditingDomain] = useState<DomainId>(currentDomain);

  // Re-sync the editing context to the factory region on each
  // closed→open transition. The sheet stays mounted (AppHeader owns
  // `open`), so the useState initializer runs only once at app load —
  // this effect is what actually keeps "defaults to currentDomain on
  // open" true across sessions of opening the sheet.
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current) setEditingDomain(currentDomain);
    prevOpen.current = open;
  }, [open, currentDomain]);

  // Guard against the edited region being deactivated mid-session: fall
  // back to the factory region (always active by the hook's invariant).
  const editing = resolveEditingDomain(
    editingDomain,
    activeDomains,
    currentDomain,
  );

  const handleActivateGroup = useCallback(
    (groupId: AicGroupId) => {
      const targets = aic.nodes
        .filter((n) => n.groupId === groupId)
        .map((n) => n.id);
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
        className="w-full md:max-w-2xl lg:max-w-3xl max-w-[92vw] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="px-5 pt-5 pb-4 border-b">
          <SheetTitle className="text-lg">
            {t("title", { ns: "settings", defaultValue: "Settings" })}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {t("intro", {
              ns: "settings",
              defaultValue:
                "Configure each region's AIC research plan, facility limits, and raw-material rates. Pick a region to configure below; the switches add or remove regions from your roster.",
            })}
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 py-3 border-b border-border/60">
          <RegionNavMenu
            editingDomain={editing}
            onEditingDomainChange={setEditingDomain}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <RegionConfigTabs
            editingDomain={editing}
            onToggleNode={handleToggleNode}
            onActivateLayer={handleActivateLayer}
            onActivateGroup={handleActivateGroup}
            onResetGroup={handleResetGroup}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
