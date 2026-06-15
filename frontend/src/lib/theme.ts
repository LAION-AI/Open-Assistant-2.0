// Theme handling: cycles system → dark → light. The resolved theme toggles the
// `.dark` class on <html> (see styles/globals.css `@custom-variant dark`).

export type Theme = "system" | "dark" | "light";

const KEY = "oa-theme";

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {}
  return "system";
}

export function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

export function resolveTheme(theme: Theme): "dark" | "light" {
  return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
  applyTheme(theme);
}

export function nextTheme(theme: Theme): Theme {
  return theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
}
