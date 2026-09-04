import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Eye } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDomainSettingsContext } from "@/contexts/domain-settings-context";
import { getDomainName } from "@/lib/i18n-helpers";

/**
 * Slim banner shown while viewing a shared plan — i.e. the URL (or an
 * opened file) carried a settings snapshot that differs from the
 * viewer's own. The plan is computed against the sharer's settings,
 * which are read-only; the viewer's own localStorage is never touched.
 *
 * Two actions:
 *   - "Switch to mine" (`exitSharedPlan`) — discard the snapshot and
 *     re-solve against the viewer's own settings. Non-destructive.
 *   - "Use these settings" (`importSharedPlan`) — adopt the snapshot as
 *     the viewer's own. Destructive (overwrites localStorage), so it is
 *     confirmed first.
 *
 * `useTranslation` re-renders on language change, so the region name
 * (resolved via the global i18next instance) stays current.
 */
export function SharedPlanBanner() {
  const { t } = useTranslation("app");
  const { isSharedView, currentDomain, importSharedPlan, exitSharedPlan } =
    useDomainSettingsContext();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!isSharedView) return null;

  const regionName = getDomainName(currentDomain);

  const handleImport = () => {
    importSharedPlan();
    setConfirmOpen(false);
    toast.success(
      t("sharedPlan.imported", {
        defaultValue: "Shared settings applied to your configuration.",
      }),
    );
  };

  const handleExit = () => {
    exitSharedPlan();
    toast(
      t("sharedPlan.exited", {
        defaultValue: "Switched back to your own settings.",
      }),
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
      <Eye className="h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">
          {t("sharedPlan.title", { defaultValue: "Viewing a shared plan" })}
        </span>{" "}
        <span className="text-muted-foreground">
          {t("sharedPlan.description", {
            region: regionName,
            defaultValue:
              "Showing the sharer's settings for {{region}}. Read-only; your own settings stay unchanged.",
          })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" onClick={handleExit}>
          {t("sharedPlan.useMine", { defaultValue: "Switch to mine" })}
        </Button>
        <Button variant="default" size="sm" onClick={() => setConfirmOpen(true)}>
          {t("sharedPlan.useTheirs", { defaultValue: "Use these settings" })}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("sharedPlan.importTitle", {
                defaultValue: "Use the shared plan's settings?",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("sharedPlan.importDescription", {
                defaultValue:
                  "This replaces your saved region, AIC research, and limits with the shared plan's. You can change them again afterward.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t("sharedPlan.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button variant="default" onClick={handleImport}>
              {t("sharedPlan.importConfirm", {
                defaultValue: "Overwrite my settings",
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
