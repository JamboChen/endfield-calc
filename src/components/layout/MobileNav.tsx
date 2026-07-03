import { memo } from "react";
import { ClipboardList, Factory } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type MobileView = "plan" | "production";

type MobileNavProps = {
  view: MobileView;
  onViewChange: (view: MobileView) => void;
};

/**
 * Portrait-only bottom navigation: Plan (targets + options) vs
 * Production (view tabs). The stats ticker/drawer sits directly above
 * this bar on BOTH tabs so target edits give immediate plan feedback.
 * Visibility is CSS-gated by the App-level orientation wrappers (the
 * nav itself is orientation-agnostic, like LeftPanel/PortraitDrawer).
 */
const MobileNav = memo(function MobileNav({
  view,
  onViewChange,
}: MobileNavProps) {
  const { t } = useTranslation("app");

  const tabs = [
    { id: "plan", icon: ClipboardList, label: t("mobileNav.plan") },
    { id: "production", icon: Factory, label: t("mobileNav.production") },
  ] as const;

  return (
    <nav className="shrink-0 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
      {tabs.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          aria-current={view === id ? "page" : undefined}
          onClick={() => onViewChange(id)}
          className={cn(
            "flex items-center justify-center gap-2 rounded-md py-2 text-sm font-medium transition-colors",
            view === id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          {label}
        </button>
      ))}
    </nav>
  );
});

export default MobileNav;
