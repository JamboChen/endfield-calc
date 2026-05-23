/**
 * First-visit AIC onboarding dialog.
 *
 * Shown once per browser (localStorage key `endfield-calc:onboarding-v1`)
 * to let users opt out of AIC plans they haven't researched in-game.
 * The default is "all checked" — calculator users skew late-game, so
 * full-unlock is the right starting position for most. Users who want
 * a stricter view uncheck the regions they haven't progressed in.
 *
 * # Behavior
 *
 *   - Triggered on mount when the flag is absent.
 *   - All domains (pinned + togglable) appear as checkboxes, defaulted
 *     to checked. The pinned domain (Valley IV) cannot be deactivated,
 *     but its checkbox still drives whether its AIC nodes start fully
 *     researched (checked) or only at game defaults (unchecked).
 *   - Staged state: checkbox toggles update local component state.
 *     Nothing is mutated on the global settings until Confirm.
 *   - On Confirm (or any close event): `applyOnboardingChoices` runs
 *     the bulk apply, then `localStorage` flag is set, then the dialog
 *     closes. Any close path (Escape, overlay click, X button) takes
 *     this same path, so users can't end up in a partial state.
 *
 * # Trigger contract
 *
 *   - The flag is set unconditionally on close. There is no
 *     "fire-again" affordance — once dismissed, the dialog is done.
 *   - Existing users with non-default AIC state see the modal once;
 *     confirming with the default all-checked state will OVERRIDE
 *     their granular configuration. This is intentional — see the
 *     PR notes for the design rationale.
 *
 * # SSR safety
 *
 *   - The initial `localStorage.getItem` lives inside `useEffect`, so
 *     server-side renders don't try to read `window`.
 *   - Initial render returns `null` (dialog closed); effect runs
 *     post-mount, flips `open` if the flag is absent.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDomainSettingsContext } from "@/contexts/domain-settings-context";
import { cn } from "@/lib/utils";
import type { DomainId } from "@/types/domain";

const STORAGE_KEY = "endfield-calc:onboarding-v1";

export function AicOnboardingDialog() {
  const { t } = useTranslation(["onboarding", "domain"]);
  const { domains, applyOnboardingChoices } = useDomainSettingsContext();

  const [open, setOpen] = useState(false);

  // Staged choices — local until Confirm. Initialise with every domain
  // checked (the "all unlocked" default that matches who actually uses
  // production calculators).
  const initialChoices = useMemo(() => {
    const m = new Map<DomainId, boolean>();
    for (const d of domains) m.set(d.id, true);
    return m;
  }, [domains]);
  const [choices, setChoices] = useState<Map<DomainId, boolean>>(
    () => new Map(initialChoices),
  );

  // Trigger gate: read localStorage post-mount. Hidden on SSR.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!window.localStorage.getItem(STORAGE_KEY)) {
        setOpen(true);
      }
    } catch {
      // localStorage disabled/full — silently skip the dialog. The
      // user gets the all-checked default by virtue of not interacting.
    }
  }, []);

  const handleToggle = useCallback((id: DomainId) => {
    setChoices((prev) => {
      const next = new Map(prev);
      next.set(id, !(prev.get(id) ?? true));
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    applyOnboardingChoices(choices);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Best-effort: if storage is unavailable, the dialog re-shows on
      // next visit. Not catastrophic.
    }
    setOpen(false);
  }, [applyOnboardingChoices, choices]);

  // Any close event (Escape, overlay click, X button) routes through
  // the same apply path. Prevents users from dismissing into a
  // half-configured state.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) handleConfirm();
    },
    [handleConfirm],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("onboarding:title")}</DialogTitle>
          <DialogDescription>{t("onboarding:description")}</DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-2 py-2">
          {domains.map((domain) => {
            const checked = choices.get(domain.id) ?? true;
            const domainName = t(`domain:domains.${domain.id}.name`, {
              defaultValue: domain.id,
            });
            return (
              <li
                key={domain.id}
                className={cn(
                  "flex items-center gap-3 rounded-md border-l-4 px-3 py-2.5",
                  "bg-card/40 hover:bg-accent/30 transition-colors cursor-pointer",
                )}
                style={{ borderLeftColor: `#${domain.color}` }}
                onClick={() => handleToggle(domain.id)}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => handleToggle(domain.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={domainName}
                />
                <span className="text-sm font-medium">{domainName}</span>
              </li>
            );
          })}
        </ul>

        <div
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2",
            "border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/30",
            "text-amber-900 dark:text-amber-200",
          )}
          role="note"
        >
          <AlertTriangle
            className="size-4 shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <p className="text-xs leading-snug">{t("onboarding:warning")}</p>
        </div>

        <p className="text-xs text-muted-foreground">{t("onboarding:hint")}</p>

        <DialogFooter>
          <Button type="button" onClick={handleConfirm}>
            {t("onboarding:confirmButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
