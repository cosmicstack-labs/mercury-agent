import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useThemeStore } from "@/stores/theme";

interface KeyboardShortcutsOptions {
  onToggleSidebar?: () => void;
}

export function useKeyboardShortcuts(options: KeyboardShortcutsOptions = {}) {
  const navigate = useNavigate();
  const { setTheme, theme } = useThemeStore();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // Don't fire shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        if (e.key === "Escape") {
          target.blur();
          return;
        }
        return;
      }

      if (mod && e.key === "k") {
        e.preventDefault();
        navigate("/chat");
      }

      if (mod && e.key === "/") {
        e.preventDefault();
        options.onToggleSidebar?.();
      }

      if (mod && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setTheme(theme === "dark" ? "light" : "dark");
      }

      if (e.key === "Escape") {
        (document.activeElement as HTMLElement)?.blur();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, options, setTheme, theme]);
}
