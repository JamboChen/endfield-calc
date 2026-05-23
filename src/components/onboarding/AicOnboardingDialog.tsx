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
 *   - All domains (pinned + togglable) appear as large button-cards,
 *     defaulted to selected. The pinned domain (Valley IV) cannot be
 *     deactivated, but its card still drives whether its AIC nodes
 *     start fully researched (selected) or only at game defaults
 *     (unselected).
 *   - Staged state: card toggles update local component state.
 *     Nothing is mutated on the global settings until Confirm.
 *   - On Confirm (or any close event): `applyOnboardingChoices` runs
 *     the bulk apply, then `localStorage` flag is set, then the dialog
 *     closes. Any close path (Escape, overlay click, X button) takes
 *     this same path, so users can't end up in a partial state.
 *
 * # Visual design
 *
 *   - Each domain is a full-width `<button>` (not a checkbox). The
 *     whole card is the click target; `role="button"` + `aria-pressed`
 *     carry the state contract to assistive tech.
 *   - Selected: background tinted with domain color (~8% opacity),
 *     thick (4px) left border in the domain color, full-saturation
 *     status pill. Unselected: outline only, muted name + status.
 *   - The dialog leans on weight + tracking + size for typographic
 *     hierarchy instead of a custom display font — fits the rest of
 *     the calculator's restrained look while still feeling deliberate.
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
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, CircleDashed, CheckCircle2 } from "lucide-react";

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
import { cn } from "@/lib/utils";
import type { DomainId } from "@/types/domain";

const STORAGE_KEY = "endfield-calc:onboarding-v1";

/**
 * Convert a 6-digit hex string (no leading `#`) to an `rgba()` string.
 * Domain colors live as bare hex in `aic-plans.ts` (`"dfef36"`); we
 * use this to derive the low-opacity background tints for selected
 * button-cards.
 *
 * Pre-computing rgba and exposing it via CSS variables (rather than
 * inlining `color-mix(...)` inside Tailwind arbitrary properties) is
 * a workaround for Tailwind v4's arbitrary-value parser, which mangles
 * nested parentheses inside `color-mix(...)` expressions and emits a
 * stripped property value (e.g. `background-color: var(--domain-color)`
 * — the full-saturation color — instead of the tinted result).
 */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

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
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader className="gap-3">
          <DialogTitle className="text-2xl font-bold uppercase tracking-[0.12em] leading-tight">
            {t("onboarding:title")}
          </DialogTitle>
          <DialogDescription>{t("onboarding:description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-1">
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
                    // Inline CSS variables bound to the domain color
                    // (selected state only). The Tailwind classes below
                    // consume `--domain-color` for the border/pill and
                    // `--domain-tint` / `--domain-tint-hover` for the
                    // tinted backgrounds. Pre-computing rgba in JS
                    // sidesteps a Tailwind v4 arbitrary-value parser
                    // bug with nested `color-mix(...)` expressions.
                    ...(checked
                      ? {
                          ["--domain-color"]: `#${domain.color}`,
                          ["--domain-tint"]: hexToRgba(domain.color, 0.08),
                          ["--domain-tint-hover"]: hexToRgba(
                            domain.color,
                            0.14,
                          ),
                        }
                      : {}),
                    // Staggered entrance: each card fades in 50ms after
                    // the previous one. CSS animation runs once on
                    // mount; subsequent state changes don't re-trigger.
                    animationDelay: `${idx * 50}ms`,
                  } as React.CSSProperties
                }
                className={cn(
                  // Layout
                  "group relative w-full flex items-center justify-between gap-3",
                  "px-4 py-3.5 rounded-lg text-left",
                  // Motion
                  "transition-colors duration-150 ease-out",
                  "active:scale-[0.99]",
                  // Use arbitrary `[animation-duration:300ms]` instead
                  // of `duration-300` so the card entrance keeps its
                  // 300ms reveal while the state transitions above
                  // correctly use the 150ms duration class. Tailwind's
                  // `duration-*` writes a shared `--tw-duration`
                  // variable that both `transition-*` and `animate-*`
                  // consume, so two `duration-*` classes on the same
                  // element collapse into one.
                  "animate-in fade-in-0 slide-in-from-bottom-1 [animation-duration:300ms] fill-mode-both",
                  // Focus
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  // State styling
                  checked
                    ? [
                        // Selected: tinted bg + bold left border in
                        // the domain color, rest neutral.
                        "border border-transparent border-l-[4px]",
                        "[border-left-color:var(--domain-color)]",
                        "[background-color:var(--domain-tint)]",
                        "hover:[background-color:var(--domain-tint-hover)]",
                      ]
                    : [
                        // Unselected: thin outline, no color.
                        "border border-border",
                        "bg-card hover:bg-accent/40",
                      ],
                )}
              >
                <div className="flex flex-col items-start gap-0.5 min-w-0">
                  <span
                    className={cn(
                      "text-base font-semibold tracking-wide leading-tight truncate",
                      !checked && "text-muted-foreground",
                    )}
                  >
                    {domainName}
                  </span>
                </div>

                <span
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1.5",
                    "text-[11px] font-semibold uppercase tracking-[0.15em]",
                    checked
                      ? "[color:var(--domain-color)]"
                      : "text-muted-foreground",
                  )}
                >
                  {checked ? (
                    <CheckCircle2
                      className="size-3.5 shrink-0"
                      strokeWidth={2.5}
                    />
                  ) : (
                    <CircleDashed
                      className="size-3.5 shrink-0"
                      strokeWidth={2}
                    />
                  )}
                  {statusLabel}
                </span>
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
