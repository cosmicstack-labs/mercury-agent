/* Theme: light / dark / system, plus a tint for the accent. Applied to <html>. */

import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type Tint = "mercury" | "graphite" | "teal" | "violet" | "amber";

export const TINTS: Array<{ id: Tint; label: string; light: string; dark: string }> = [
  { id: "mercury", label: "Mercury green", light: "#1A9E6E", dark: "#34E1A1" },
  { id: "teal", label: "Teal", light: "#0E7C8C", dark: "#7FD8E8" },
  { id: "graphite", label: "Graphite", light: "#4B5157", dark: "#AEB6BC" },
  { id: "violet", label: "Violet", light: "#6D4CCC", dark: "#B19CFF" },
  { id: "amber", label: "Amber", light: "#A0620A", dark: "#F5C451" },
];

interface ThemeState {
  mode: ThemeMode;
  tint: Tint;
  resolved: "light" | "dark";
  setMode(mode: ThemeMode): void;
  setTint(tint: Tint): void;
}

const MODE_KEY = "mercury.theme";
const TINT_KEY = "mercury.tint";

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (systemDark() ? "dark" : "light") : mode;
}

function apply(resolved: "light" | "dark", tint: Tint): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  if (tint === "mercury") root.removeAttribute("data-tint");
  else root.setAttribute("data-tint", tint);
}

const initialMode = readStored<ThemeMode>(MODE_KEY, ["light", "dark", "system"], "system");
const initialTint = readStored<Tint>(TINT_KEY, TINTS.map((t) => t.id), "mercury");
const initialResolved = resolve(initialMode);
if (typeof document !== "undefined") apply(initialResolved, initialTint);

export const useTheme = create<ThemeState>((set, get) => ({
  mode: initialMode,
  tint: initialTint,
  resolved: initialResolved,
  setMode(mode) {
    const resolved = resolve(mode);
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
    apply(resolved, get().tint);
    set({ mode, resolved });
  },
  setTint(tint) {
    try { localStorage.setItem(TINT_KEY, tint); } catch { /* ignore */ }
    apply(get().resolved, tint);
    set({ tint });
  },
}));

if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const { mode, tint } = useTheme.getState();
    if (mode !== "system") return;
    const resolved = resolve(mode);
    apply(resolved, tint);
    useTheme.setState({ resolved });
  });
}
