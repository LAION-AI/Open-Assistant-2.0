import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "./ui/button";
import { applyTheme, getStoredTheme, nextTheme, setTheme, type Theme } from "../lib/theme";

const ICONS: Record<Theme, typeof Monitor> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
};

const LABELS: Record<Theme, string> = {
  system: "System theme",
  dark: "Dark theme",
  light: "Light theme",
};

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());

  // Keep the resolved theme in sync, and follow the OS when set to "system".
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const cycle = () => {
    const next = nextTheme(theme);
    setTheme(next);
    setThemeState(next);
  };

  const Icon = ICONS[theme];

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={cycle}
      className="h-9 w-9 rounded-xl border-border/80 text-muted-foreground hover:text-foreground hover:bg-muted"
      title={`${LABELS[theme]} — click to change`}
    >
      <Icon className="w-4 h-4" />
    </Button>
  );
}
