import { create } from "zustand";

type Theme = "dark" | "light" | "system";

interface ThemeState {
  theme: Theme;
  resolved: "dark" | "light";
  setTheme: (theme: Theme) => void;
}

function getSystemTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(theme: Theme): "dark" | "light" {
  return theme === "system" ? getSystemTheme() : theme;
}

function applyTheme(resolved: "dark" | "light") {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(resolved);
}

const stored = (typeof window !== "undefined"
  ? localStorage.getItem("mercury-theme")
  : null) as Theme | null;

const initial: Theme = stored || "dark";
const initialResolved = resolveTheme(initial);

// Apply on load
if (typeof window !== "undefined") {
  applyTheme(initialResolved);
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initial,
  resolved: initialResolved,
  setTheme: (theme: Theme) => {
    const resolved = resolveTheme(theme);
    localStorage.setItem("mercury-theme", theme);
    applyTheme(resolved);
    set({ theme, resolved });
  },
}));

// Listen for system theme changes
if (typeof window !== "undefined") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const state = useThemeStore.getState();
      if (state.theme === "system") {
        const resolved = getSystemTheme();
        applyTheme(resolved);
        useThemeStore.setState({ resolved });
      }
    });
}
