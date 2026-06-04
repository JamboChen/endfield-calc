import { useTranslation } from "react-i18next";
import { Scale } from "lucide-react";
import { SiDiscord, SiTencentqq } from "react-icons/si";

export default function AppFooter() {
  const { t } = useTranslation("app");
  return (
    <footer className="border-t mt-auto [@media(orientation:portrait)]:hidden">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-4 px-2 text-sm text-muted-foreground">
        {/* Left section */}
        <div className="flex items-center gap-2 text-xs sm:text-sm">
          <span>{t("footer.feedback")}</span>
          <a
            href="https://qm.qq.com/q/OFNdDzjk4Y"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <SiTencentqq className="h-3.5 w-3.5" />
            <span>1075221296</span>
          </a>
          <span className="text-muted-foreground/60">•</span>
          <a
            href="https://discord.gg/6V7CupPwb6"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <SiDiscord className="h-3.5 w-3.5" />
            <span>Discord</span>
          </a>
        </div>
        {/* Right section */}
        <div className="flex items-center gap-2 sm:gap-3 text-xs sm:text-sm">
          <span>© 2025 JamboChen</span>
          <span className="text-muted-foreground/60">•</span>
          <span className="flex items-center gap-1">
            <Scale className="h-3 w-3" />
            MIT License
          </span>
          <span className="text-muted-foreground/60">•</span>
          <span>{t("footer.unofficial")}</span>
          <span className="text-muted-foreground/60">•</span>
          {import.meta.env.BASE_URL.includes("/beta/") && (
            <>
              <span className="font-mono uppercase tracking-wider text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-600 dark:text-amber-400">
                Beta
              </span>
              <span className="text-muted-foreground/60">•</span>
            </>
          )}
          <span className="font-mono">{__APP_VERSION__}</span>
        </div>
      </div>
      <div className="text-xs text-muted-foreground/60 text-center pb-3">
        {t("footer.trademark")}
      </div>
    </footer>
  );
}
