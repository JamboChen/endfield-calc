import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useTheme } from "../ui/theme-context";
import {
  Sun,
  Moon,
  Save,
  FolderOpen,
  Settings,
  Share2,
  MoreHorizontal,
  Languages,
} from "lucide-react";
import { SiGithub, SiDiscord, SiTencentqq } from "react-icons/si";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { sharePlanLink } from "@/lib/share-plan";

interface AppHeaderProps {
  onLanguageChange: (lang: string) => void;
  onSavePlan: () => void;
  onOpenPlan: () => void;
  /** Opens the Settings sheet (state lives in `AppContent` so the
   *  left-rail Options card can trigger it too). */
  onOpenSettings: () => void;
}

const SUPPORTED_LANGS = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "ru"];

const LANG_LABELS: Record<string, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  ru: "Русский",
};

const LANG_NORMALIZE: Record<string, string> = {
  zh: "zh-Hans",
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
};

function resolveDisplayLang(lang: string): string {
  if (SUPPORTED_LANGS.includes(lang)) return lang;
  if (LANG_NORMALIZE[lang]) return LANG_NORMALIZE[lang];
  // e.g. "en-US" -> "en", "ja-JP" -> "ja"
  const prefix = lang.split("-")[0];
  if (SUPPORTED_LANGS.includes(prefix)) return prefix;
  return "en";
}

/** Icon button (or icon link via `href`) + tooltip — the header's unit
 *  of chrome. Links render a real anchor through `asChild` so we never
 *  nest interactive elements. */
function HeaderIconButton({
  label,
  onClick,
  href,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  children: React.ReactNode;
}) {
  const className = "h-8 w-8 p-0 text-muted-foreground hover:text-foreground";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <Button variant="ghost" size="sm" className={className} asChild>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={label}
            >
              {children}
            </a>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClick}
            className={className}
            aria-label={label}
          >
            {children}
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * App header. One slim row in both layouts:
 *
 *   - Desktop (`md+`): icon-button toolbar with tooltips, grouped by
 *     separators (file · community · app) + a compact language select.
 *     Labels live in the tooltips — the old labelled buttons overflowed
 *     at mid widths and were clipped entirely in portrait.
 *   - Mobile (`<md`): a single ⋯ overflow menu carrying Save/Open,
 *     community links and a language radio group; Settings and theme
 *     stay as always-visible icon buttons (the two most-used actions).
 */
export default function AppHeader({
  onLanguageChange,
  onSavePlan,
  onOpenPlan,
  onOpenSettings,
}: AppHeaderProps) {
  const { t, i18n } = useTranslation(["app", "settings"]);
  const { theme, setTheme } = useTheme();
  const currentLang = resolveDisplayLang(i18n.language);

  const settingsLabel = t("title", { ns: "settings", defaultValue: "Settings" });
  const shareLabel = t("header.share", { defaultValue: "Share Plan" });

  /**
   * Hand the current URL to the OS share sheet, or copy it.
   *
   * Must stay synchronous up to the `sharePlanLink` call: the Web Share
   * API needs the click's transient activation, and an `await` here would
   * consume it. `window.location.href` is read at click time because the
   * plan/URL sync effect rewrites the hash as the plan changes.
   *
   * Shared unconditionally, even with no targets: a plan-less URL is
   * still a link to the tool, which is a reasonable thing to send.
   */
  const handleShare = () => {
    void sharePlanLink({
      url: window.location.href,
      title: t("title"),
    }).then((outcome) => {
      // "shared" and "dismissed" are both the user getting what they
      // asked for; only the fallback paths need narrating.
      if (outcome === "copied") {
        toast.success(
          t("sharedPlan.linkCopied", {
            defaultValue: "Link copied to clipboard.",
          }),
        );
      } else if (outcome === "unavailable") {
        toast.error(
          t("sharedPlan.shareFailed", {
            defaultValue: "Couldn't share the link.",
          }),
        );
      }
    });
  };

  return (
    <div className="flex items-center justify-between gap-2 min-h-9">
      {/* Fluid rather than fixed `text-xl`: the toolbar is 4 controls
          wide on mobile, and a 10-glyph CJK title at 20px would overflow
          a 360px viewport (the root clips rather than scrolls). Scales
          only below ~500px, so wider screens are unchanged; `min-w-0` +
          `truncate` is the floor for the narrowest devices. */}
      <h1 className="text-[length:clamp(1rem,4vw,1.25rem)] font-bold whitespace-nowrap min-w-0 truncate">
        {t("title")}
      </h1>

      {/* Desktop toolbar */}
      <div className="hidden md:flex items-center gap-1">
        <HeaderIconButton label={t("header.save")} onClick={onSavePlan}>
          <Save className="h-4 w-4" />
        </HeaderIconButton>
        <HeaderIconButton label={t("header.open")} onClick={onOpenPlan}>
          <FolderOpen className="h-4 w-4" />
        </HeaderIconButton>
        <HeaderIconButton label={shareLabel} onClick={handleShare}>
          <Share2 className="h-4 w-4" />
        </HeaderIconButton>

        <Separator orientation="vertical" className="h-5 mx-1" />

        <HeaderIconButton
          label={t("header.discord")}
          href="https://discord.gg/6V7CupPwb6"
        >
          <SiDiscord className="h-4 w-4" />
        </HeaderIconButton>
        <HeaderIconButton
          label={t("header.qqGroup")}
          href="https://qm.qq.com/q/OFNdDzjk4Y"
        >
          <SiTencentqq className="h-4 w-4" />
        </HeaderIconButton>
        <HeaderIconButton
          label="GitHub"
          href="https://github.com/JamboChen/endfield-calc"
        >
          <SiGithub className="h-4 w-4" />
        </HeaderIconButton>

        <Separator orientation="vertical" className="h-5 mx-1" />

        <HeaderIconButton label={settingsLabel} onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
        </HeaderIconButton>
        <HeaderIconButton
          label={t("header.toggleTheme", { defaultValue: "Toggle theme" })}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </HeaderIconButton>

        {/* Language selector */}
        <Select value={currentLang} onValueChange={onLanguageChange}>
          <SelectTrigger
            className="w-[110px] h-8 ml-1"
            aria-label={t("header.language", { defaultValue: "Language" })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_LANGS.map((lang) => (
              <SelectItem key={lang} value={lang}>
                {LANG_LABELS[lang]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Mobile toolbar: overflow menu + the two most-used actions. */}
      <div className="flex md:hidden items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0 text-muted-foreground"
              aria-label={t("header.menu", { defaultValue: "Menu" })}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={onSavePlan}>
              <Save className="h-4 w-4" />
              {t("header.save")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenPlan}>
              <FolderOpen className="h-4 w-4" />
              {t("header.open")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a
                href="https://discord.gg/6V7CupPwb6"
                target="_blank"
                rel="noopener noreferrer"
              >
                <SiDiscord className="h-4 w-4" />
                {t("header.discord")}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a
                href="https://qm.qq.com/q/OFNdDzjk4Y"
                target="_blank"
                rel="noopener noreferrer"
              >
                <SiTencentqq className="h-4 w-4" />
                {t("header.qqGroup")}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a
                href="https://github.com/JamboChen/endfield-calc"
                target="_blank"
                rel="noopener noreferrer"
              >
                <SiGithub className="h-4 w-4" />
                GitHub
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2 text-xs text-muted-foreground">
              <Languages className="h-3.5 w-3.5" />
              {t("header.language", { defaultValue: "Language" })}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={currentLang}
              onValueChange={onLanguageChange}
            >
              {SUPPORTED_LANGS.map((lang) => (
                <DropdownMenuRadioItem key={lang} value={lang}>
                  {LANG_LABELS[lang]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Outside the overflow menu on purpose: sharing a link is the
            action mobile users reach for most, and burying it behind `⋯`
            would defeat the point of wiring up the native share sheet. */}
        <HeaderIconButton label={shareLabel} onClick={handleShare}>
          <Share2 className="h-4 w-4" />
        </HeaderIconButton>
        <HeaderIconButton label={settingsLabel} onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
        </HeaderIconButton>
        <HeaderIconButton
          label={t("header.toggleTheme", { defaultValue: "Toggle theme" })}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </HeaderIconButton>
      </div>
    </div>
  );
}
