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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useTheme } from "../ui/theme-provider";
import { MessageCircle, Sun, Moon } from "lucide-react";
import { SiGithub, SiDiscord, SiTencentqq } from "react-icons/si";

interface AppHeaderProps {
  onLanguageChange: (lang: string) => void;
}

const SUPPORTED_LANGS = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "ru"];

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

export default function AppHeader({ onLanguageChange }: AppHeaderProps) {
  const { t, i18n } = useTranslation("app");
  const { theme, setTheme } = useTheme();
  const currentLang = resolveDisplayLang(i18n.language);

  return (
    <div className="flex flex-col gap-2">
      {/* Header bar with title and controls */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <div className="flex items-center gap-4">
          {/* Community dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <MessageCircle className="h-4 w-4" />
                <span>{t("header.community")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a
                  href="https://discord.gg/6V7CupPwb6"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <SiDiscord className="h-4 w-4" />
                  <span>{t("header.discord")}</span>
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href="https://qm.qq.com/q/OFNdDzjk4Y"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <SiTencentqq className="h-4 w-4" />
                  <span>{t("header.qqGroup")}</span>
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* GitHub link */}
          <a
            href="https://github.com/JamboChen/endfield-calc"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <SiGithub className="h-4 w-4" />
            <span>GitHub</span>
          </a>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="h-9 w-9 p-0"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>

          {/* Language selector */}
          <Select value={currentLang} onValueChange={onLanguageChange}>
            <SelectTrigger className="w-[120px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh-Hans">简体中文</SelectItem>
              <SelectItem value="zh-Hant">繁體中文</SelectItem>
              <SelectItem value="ja">日本語</SelectItem>
              <SelectItem value="ko">한국어</SelectItem>
              <SelectItem value="es">Español</SelectItem>
              <SelectItem value="ru">Русский</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
