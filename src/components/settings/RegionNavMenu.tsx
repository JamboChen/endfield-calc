import { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useDomainSettingsContext } from "@/contexts/domain-settings-context";
import { pickLatestActive } from "@/lib/persisted-shape";
import { cn } from "@/lib/utils";
import type { Domain, DomainId } from "@/types/domain";

interface RegionNavMenuProps {
  /** Region currently being configured (resolved by the parent sheet). */
  editingDomain: DomainId;
  /** Select a different region to configure (closes the menu). */
  onEditingDomainChange: (id: DomainId) => void;
}

/**
 * Compact dropdown that is both the region navigator and the region
 * roster. One list does navigation (click a name → configure it) AND
 * activation (per-row switch → add/remove from the roster).
 *
 * - **Pinned region** (home / Valley IV) is a normal selectable row with
 *   no switch — you can't deactivate your home region and we don't
 *   explain why (`isPinned` is internal only).
 * - **Activation** toggles via the per-row `Switch`; the switch is a
 *   sibling of the (selectable) name item with `stopPropagation`, so
 *   flipping it neither selects the row nor closes the menu.
 * - Activating an inactive region **auto-selects** it for editing.
 * - Deactivating the current *factory* region fires the fallback toast
 *   (the hook auto-shifts `currentDomain`); deactivating the *edited*
 *   region is handled by the parent via `resolveEditingDomain`.
 */
export function RegionNavMenu({
  editingDomain,
  onEditingDomainChange,
}: RegionNavMenuProps) {
  const { t } = useTranslation(["settings", "domain"]);
  const { domains, activeDomains, currentDomain, toggleDomain, sharedDiff } =
    useDomainSettingsContext();
  // Read-only shared-view: viewing other regions stays allowed, but the
  // activation switches are frozen (they'd mutate the shared snapshot).
  const readOnly = sharedDiff !== null;
  const domainChanged = (id: DomainId): boolean =>
    (sharedDiff?.domainActivation.has(id) ?? false) ||
    (id === currentDomain && (sharedDiff?.currentDomainChanged ?? false));

  const { activeList, inactiveList } = useMemo(() => {
    const sorted = [...domains].sort((a, b) => a.sortId - b.sortId);
    return {
      activeList: sorted.filter((d) => activeDomains.has(d.id)),
      inactiveList: sorted.filter((d) => !activeDomains.has(d.id)),
    };
  }, [domains, activeDomains]);

  const editingName = useMemo(() => {
    const d = domains.find((x) => x.id === editingDomain);
    return d
      ? t(`domains.${d.id}.name`, { ns: "domain", defaultValue: d.id })
      : editingDomain;
  }, [domains, editingDomain, t]);
  const editingColor = domains.find((d) => d.id === editingDomain)?.color;

  // Toggle activation for a region. Mirrors the old
  // SettingsSheet.handleToggleDomain: surfaces a toast only when the
  // user deactivates their *current factory region*, since the hook
  // silently auto-falls-back `currentDomain` in that case.
  const handleToggle = (domain: Domain) => {
    const isActive = activeDomains.has(domain.id);
    const willAutoFallback =
      !domain.isPinned && domain.id === currentDomain && isActive;

    toggleDomain(domain.id);

    if (willAutoFallback) {
      // Same tie-break the hook uses; computed here because state has
      // batched but not yet re-rendered.
      const nextActive = new Set(activeDomains);
      nextActive.delete(domain.id);
      const nextId = pickLatestActive(nextActive);
      const next = domains.find((d) => d.id === nextId);
      const fallbackName = next
        ? t(`domains.${next.id}.name`, { ns: "domain", defaultValue: next.id })
        : "";
      toast.info(
        t("region.toast.switchedToFallback", {
          ns: "settings",
          name: fallbackName,
          defaultValue: `Switched to ${fallbackName} factory`,
        }),
      );
    }

    // Activating an inactive region auto-selects it for editing.
    if (!isActive) {
      onEditingDomainChange(domain.id);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground shrink-0">
        {t("regions.configuringLabel", {
          ns: "settings",
          defaultValue: "Configuring",
        })}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2 min-w-0 flex-1 justify-start"
          >
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-full shrink-0"
              style={
                editingColor ? { backgroundColor: `#${editingColor}` } : undefined
              }
            />
            <span className="truncate flex-1 text-left">{editingName}</span>
            <ChevronDown className="size-4 text-muted-foreground shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("regions.yourRegions", {
              ns: "settings",
              defaultValue: "Your regions",
            })}
          </DropdownMenuLabel>
          {activeList.map((d) => (
            <RegionRow
              key={d.id}
              domain={d}
              isActive
              isEditing={d.id === editingDomain}
              isFactory={d.id === currentDomain}
              onSelect={() => onEditingDomainChange(d.id)}
              onToggle={() => handleToggle(d)}
              disabled={readOnly}
              changed={domainChanged(d.id)}
            />
          ))}

          {inactiveList.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {t("regions.notInRoster", {
                  ns: "settings",
                  defaultValue: "Not in roster",
                })}
              </DropdownMenuLabel>
              {inactiveList.map((d) => (
                <RegionRow
                  key={d.id}
                  domain={d}
                  isActive={false}
                  isEditing={d.id === editingDomain}
                  isFactory={false}
                  onSelect={() => onEditingDomainChange(d.id)}
                  onToggle={() => handleToggle(d)}
                  disabled={readOnly}
                  changed={domainChanged(d.id)}
                />
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface RegionRowProps {
  domain: Domain;
  isActive: boolean;
  isEditing: boolean;
  isFactory: boolean;
  onSelect: () => void;
  onToggle: () => void;
  /** Read-only shared-view: freeze the activation switch. */
  disabled?: boolean;
  /** Read-only shared-view: this region's activation/selection differs. */
  changed?: boolean;
}

function RegionRow({
  domain,
  isActive,
  isEditing,
  isFactory,
  onSelect,
  onToggle,
  disabled = false,
  changed = false,
}: RegionRowProps) {
  const { t } = useTranslation(["settings", "domain"]);
  const name = t(`domains.${domain.id}.name`, {
    ns: "domain",
    defaultValue: domain.id,
  });

  return (
    <div className="relative">
      <DropdownMenuItem
        onSelect={onSelect}
        aria-current={isEditing ? "true" : undefined}
        className={cn(
          "gap-2",
          // Reserve room for the activation switch (non-pinned only).
          !domain.isPinned && "pr-12",
          !isActive && "opacity-70",
          changed && "border-l-2 border-primary",
        )}
      >
        <span
          aria-hidden="true"
          className="inline-block size-2.5 rounded-full shrink-0"
          style={{ backgroundColor: `#${domain.color}` }}
        />
        <span
          className={cn("flex-1 min-w-0 truncate", isEditing && "font-semibold")}
        >
          {name}
        </span>
        {isFactory && (
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground shrink-0">
            {t("regions.factoryMarker", {
              ns: "settings",
              defaultValue: "Factory",
            })}
          </span>
        )}
      </DropdownMenuItem>
      {!domain.isPinned && (
        <div
          className="absolute right-2 top-1/2 -translate-y-1/2"
          // Keep switch interaction from selecting the row or closing the
          // menu (Radix uses pointer events for both).
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Switch
            checked={isActive}
            onCheckedChange={onToggle}
            disabled={disabled}
            aria-label={
              isActive
                ? t("aic.domain.toggleDeactivate", {
                    ns: "settings",
                    name,
                    defaultValue: `Deactivate ${name}`,
                  })
                : t("aic.domain.toggleActivate", {
                    ns: "settings",
                    name,
                    defaultValue: `Activate ${name}`,
                  })
            }
          />
        </div>
      )}
    </div>
  );
}
