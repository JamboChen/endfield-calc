import { useTranslation } from "react-i18next";
import { Info, Scale } from "lucide-react";
import { SiDiscord, SiTencentqq } from "react-icons/si";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Single-row compact footer (~30px). The full trademark disclaimer that
 * used to occupy a second centered row now lives in a tooltip anchored
 * on the always-visible "Unofficial fan-made tool" text, keeping the
 * legal wording one hover/focus away without spending vertical space.
 */
export default function AppFooter() {
  const { t } = useTranslation("app");
  return (
    <footer className="border-t mt-auto [@media(orientation:portrait)]:hidden">
      <div className="flex items-center justify-between gap-x-4 py-1.5 px-2 text-xs text-muted-foreground">
        {/* Left section — community / feedback */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="hidden md:inline">{t("footer.feedback")}</span>
          <a
            href="https://qm.qq.com/q/OFNdDzjk4Y"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <SiTencentqq className="h-3 w-3" />
            <span>1075221296</span>
          </a>
          <span className="text-muted-foreground/60">•</span>
          <a
            href="https://discord.gg/6V7CupPwb6"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <SiDiscord className="h-3 w-3" />
            <span>Discord</span>
          </a>
        </div>
        {/* Right section — legal + meta */}
        <div className="flex items-center gap-2 shrink-0">
          <span>© 2025 JamboChen</span>
          <span className="text-muted-foreground/60">•</span>
          <span className="flex items-center gap-1">
            <Scale className="h-3 w-3" />
            MIT License
          </span>
          <span className="text-muted-foreground/60">•</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 hover:text-foreground transition-colors cursor-help"
              >
                <Info className="h-3 w-3" />
                <span>{t("footer.unofficial")}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-center">
              {t("footer.trademark")}
            </TooltipContent>
          </Tooltip>
          {import.meta.env.BASE_URL.includes("/beta/") && (
            <>
              <span className="text-muted-foreground/60">•</span>
              <span className="font-mono uppercase tracking-wider text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-600 dark:text-amber-400">
                Beta
              </span>
            </>
          )}
          <span className="text-muted-foreground/60">•</span>
          <span className="font-mono">{__APP_VERSION__}</span>
        </div>
      </div>
    </footer>
  );
}
