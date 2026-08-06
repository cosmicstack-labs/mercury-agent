import { useThemeStore } from "@/stores/theme";
import { Sun, Moon, Monitor } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  collapsed?: boolean;
}

export function ThemeToggle({ collapsed }: ThemeToggleProps) {
  const { theme, setTheme } = useThemeStore();

  const nextTheme = () => {
    const order: Array<"dark" | "light" | "system"> = [
      "dark",
      "light",
      "system",
    ];
    const idx = order.indexOf(theme);
    setTheme(order[(idx + 1) % order.length]);
  };

  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const label =
    theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System";

  const btn = (
    <button
      onClick={nextTheme}
      className={cn(
        "p-2 rounded-lg transition-colors",
        "text-muted-foreground hover:text-foreground hover:bg-muted/50"
      )}
    >
      <Icon size={18} />
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          Theme: {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {btn}
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
