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
 *   - All domains (pinned + togglable) appear as hero-image cards in
 *     a 2-up grid (1-up on mobile), defaulted to selected. The pinned
 *     domain (Valley IV) cannot be deactivated, but its card still
 *     drives whether its AIC nodes start fully researched (selected)
 *     or only at game defaults (unselected).
 *   - Staged state: card toggles update local component state.
 *     Nothing is mutated on the global settings until Confirm.
 *   - On Confirm (or any close event): `applyOnboardingChoices` runs
 *     the bulk apply, then `localStorage` flag is set, then the dialog
 *     closes. Any close path (Escape, overlay click) takes this same
 *     path, so users can't end up in a partial state.
 *
 * # Visual design
 *
 *   - Each domain is a full-card `<button>` with two zones:
 *       1. Hero zone (3:1 aspect — matches the source deco PNG's
 *          790×257 dimensions so silhouettes display in full). A
 *          neutral `bg-secondary` plate throughout; the silhouette is
 *          always rendered via CSS `mask-image` (the PNG's alpha
 *          becomes the mask) and tinted via `background-color`. When
 *          SELECTED, the tint is the literal domain color; when
 *          UNSELECTED, it's `muted-foreground` at ~35% alpha (theme-
 *          aware via `color-mix`) — region identity remains
 *          recognizable as a soft ghost.
 *       2. Footer zone: domain name + uppercase status text. The
 *          status text takes the domain's color when selected,
 *          muted-foreground when not.
 *   - Selected cards carry a 2px domain-color border. Unselected
 *     cards have a 2px neutral border. Selection is conveyed by the
 *     silhouette color + border + the "ACTIVE" / "OFF" status text;
 *     no chrome overlay sits on the pictogram itself.
 *   - Per-domain color identity is the accent system — there's
 *     intentionally no shared brand accent. Yellow seen in upstream
 *     mockups was a placeholder.
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
 *   - Initial render returns the dialog closed; effect runs post-mount,
 *     flips `open` if the flag is absent.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDomainSettingsContext } from "@/contexts/domain-settings-context";
import { pickLatestActive } from "@/hooks/useDomainSettings";
import { cn } from "@/lib/utils";
import type { Domain, DomainId } from "@/types/domain";

const STORAGE_KEY = "endfield-calc:onboarding-v1";

export function AicOnboardingDialog() {
  const { t } = useTranslation(["onboarding", "domain"]);
  const { domains, applyOnboardingChoices } = useDomainSettingsContext();

  const [open, setOpen] = useState(false);

  // Staged choices — local until Confirm. Initialise with every domain
  // checked (the "all unlocked" default that matches who actually uses
  // production calculators). The initializer runs once on mount;
  // `domains` is a stable module-level reference so re-running it would
  // produce the same result anyway.
  const [choices, setChoices] = useState<Map<DomainId, boolean>>(() => {
    const m = new Map<DomainId, boolean>();
    for (const d of domains) m.set(d.id, true);
    return m;
  });

  // Region picker options: pinned domains ∪ ticked non-pinned domains.
  // Pinned domains always appear here regardless of their tick state
  // because unticking them only resets their AIC research, doesn't
  // deactivate the region.
  const pickerOptions = useMemo<readonly Domain[]>(
    () =>
      domains
        .filter((d) => d.isPinned || (choices.get(d.id) ?? true))
        .slice()
        .sort((a, b) => a.sortId - b.sortId),
    [domains, choices],
  );

  // Staged `currentDomain` — defaults to the latest (highest-sortId)
  // option. Auto-adjusts when the picker option list changes (e.g. user
  // unticks the currently-staged region → fall back to next-latest).
  //
  // First render: dialog starts with everything checked, so the staged
  // active set equals the full domain registry. `pickLatestActive` is
  // the shared "latest active" helper from `useDomainSettings` — using
  // it here keeps onboarding + settings + hook all in lockstep if the
  // tie-breaking rule ever changes. Assumes `domains` from the context
  // is the module-static `domainData` (which `pickLatestActive`
  // iterates internally), which is currently invariant.
  const [stagedCurrent, setStagedCurrent] = useState<DomainId>(() =>
    pickLatestActive(new Set(domains.map((d) => d.id))),
  );
  useEffect(() => {
    const stillAvailable = pickerOptions.some((d) => d.id === stagedCurrent);
    if (stillAvailable) return;
    const fallback = pickerOptions[pickerOptions.length - 1]; // highest sortId
    if (fallback) setStagedCurrent(fallback.id);
  }, [pickerOptions, stagedCurrent]);

  // Render the picker even when only one option remains (i.e. Wuling
  // unticked → Valley IV only). Disabling rather than hiding prevents a
  // layout shift mid-dialog and mirrors RegionPicker's settings-sheet
  // pattern.
  const isTrivialRegionPick = pickerOptions.length <= 1;

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
    applyOnboardingChoices(choices, stagedCurrent);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Best-effort: if storage is unavailable, the dialog re-shows on
      // next visit. Not catastrophic.
    }
    setOpen(false);
  }, [applyOnboardingChoices, choices, stagedCurrent]);

  // Any close event (Escape, overlay click, X button) routes through
  // the same apply path. Prevents users from dismissing into a
  // half-configured state.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) handleConfirm();
    },
    [handleConfirm],
  );

  const decoBaseUrl = `${import.meta.env.BASE_URL}images/domains/`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-2xl"
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-2xl font-bold uppercase tracking-[0.12em] leading-tight">
            {t("onboarding:title")}
          </DialogTitle>
          <DialogDescription>{t("onboarding:description")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
          {domains.map((domain, idx) => {
            const checked = choices.get(domain.id) ?? true;
            const domainName = t(`domain:domains.${domain.id}.name`, {
              defaultValue: domain.id,
            });
            const statusLabel = checked
              ? t("onboarding:statusActive")
              : t("onboarding:statusInactive");

            return (
              <button
                key={domain.id}
                type="button"
                aria-pressed={checked}
                aria-label={`${domainName}, ${statusLabel}`}
                onClick={() => handleToggle(domain.id)}
                style={
                  {
                    // CSS variable bound to the domain color (selected
                    // state only). Consumed via `var()` by the border,
                    // check badge, and status text classes below.
                    ...(checked
                      ? { ["--domain-color"]: `#${domain.color}` }
                      : {}),
                    // Staggered entrance: each card fades in 50ms after
                    // the previous one. Runs once on mount; subsequent
                    // state changes don't re-trigger.
                    animationDelay: `${idx * 50}ms`,
                  } as React.CSSProperties
                }
                className={cn(
                  // Layout — full-card button with overflow-hidden so
                  // the hero zone clips correctly to the rounded corner.
                  "group relative w-full overflow-hidden rounded-lg text-left",
                  // Motion
                  "transition-colors duration-150 ease-out",
                  "active:scale-[0.99]",
                  "animate-in fade-in-0 slide-in-from-bottom-1 [animation-duration:300ms] fill-mode-both",
                  // Focus
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  // Border — uniform 2px thickness in both states so
                  // toggling doesn't shift content.
                  "border-2",
                  checked
                    ? "[border-color:var(--domain-color)]"
                    : "border-border hover:border-border/70",
                )}
              >
                {/* Hero zone (3:1 aspect — matches the source deco
                    PNG's 790×257 dimensions so silhouettes display
                    without cropping). Neutral `bg-secondary` plate
                    throughout; the silhouette is always rendered via
                    CSS `mask-image` (the PNG's alpha becomes the mask)
                    and tinted via `background-color`:
                      - selected: literal domain color
                      - unselected: muted-foreground at ~35% alpha
                        (theme-aware via `color-mix`)
                    No chrome overlays the pictogram. */}
                <div className="relative aspect-[3/1] bg-secondary">
                  <div
                    aria-hidden="true"
                    className="absolute inset-0"
                    style={{
                      backgroundColor: checked
                        ? `#${domain.color}`
                        : "color-mix(in oklch, var(--muted-foreground), transparent 65%)",
                      maskImage: `url(${decoBaseUrl}deco_${domain.id}.png)`,
                      WebkitMaskImage: `url(${decoBaseUrl}deco_${domain.id}.png)`,
                      maskSize: "cover",
                      WebkitMaskSize: "cover",
                      maskRepeat: "no-repeat",
                      WebkitMaskRepeat: "no-repeat",
                      maskPosition: "center",
                      WebkitMaskPosition: "center",
                    }}
                  />
                </div>

                {/* Footer zone — name + status */}
                <div className="px-3 py-2.5 bg-card">
                  <p
                    className={cn(
                      "text-base font-semibold leading-tight truncate",
                      !checked && "text-muted-foreground",
                    )}
                  >
                    {domainName}
                  </p>
                  <p
                    className={cn(
                      "text-[11px] font-mono uppercase tracking-[0.15em] mt-1",
                      !checked && "text-muted-foreground",
                    )}
                    style={
                      checked ? { color: `#${domain.color}` } : undefined
                    }
                  >
                    {statusLabel}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        <div className="border-l-2 border-amber-500/60 pl-3 py-1 mt-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
            {t("onboarding:warningLabel")}
          </p>
          <p className="text-xs leading-snug text-muted-foreground mt-0.5">
            {t("onboarding:warning")}
          </p>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="onboarding-region-picker"
            className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("onboarding:region.label", {
              defaultValue: "Currently building in",
            })}
          </label>
          <Select
            value={stagedCurrent}
            onValueChange={(value) => setStagedCurrent(value as DomainId)}
            disabled={isTrivialRegionPick}
          >
            <SelectTrigger
              id="onboarding-region-picker"
              className="w-full pl-3 gap-2 border-l-4"
              style={(() => {
                const d = pickerOptions.find((x) => x.id === stagedCurrent);
                return d ? { borderLeftColor: `#${d.color}` } : undefined;
              })()}
            >
              <SelectValue
                placeholder={t("onboarding:region.placeholder", {
                  defaultValue: "Select region",
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {pickerOptions.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  <span
                    aria-hidden="true"
                    className="inline-block size-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: `#${d.color}` }}
                  />
                  <span className="truncate">
                    {t(`domain:domains.${d.id}.name`, {
                      defaultValue: d.id,
                    })}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="text-xs text-muted-foreground">{t("onboarding:hint")}</p>

        <DialogFooter className="mt-1">
          <Button
            type="button"
            onClick={handleConfirm}
            className="min-w-[180px] h-11 uppercase tracking-[0.12em] font-semibold"
          >
            {t("onboarding:confirmButton")}
            <ArrowRight className="size-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
