import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import api from "@/lib/api";
import type { CodeStatus } from "@/lib/api";

type CodeState = "off" | "plan" | "execute";

const STATES: { value: CodeState; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "plan", label: "Plan" },
  { value: "execute", label: "Exec" },
];

export function CodeModeToggle() {
  const [status, setStatus] = useState<CodeStatus | null>(null);
  const [switching, setSwitching] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.code.status();
      setStatus(data);
    } catch {
      // not available
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function handleSet(state: CodeState) {
    if (!status || switching || state === status.state) return;
    setSwitching(true);
    try {
      const result = await api.code.set(state);
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              state: result.state as CodeState,
              active: result.active,
            }
          : prev
      );
    } catch {
      // silently fail
    } finally {
      setSwitching(false);
    }
  }

  if (!status?.available) return null;

  return (
    <div className="flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
      {STATES.map((s) => {
        const isActive = status.state === s.value;
        return (
          <button
            key={s.value}
            disabled={switching}
            onClick={() => handleSet(s.value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150",
              isActive
                ? s.value === "plan"
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 shadow-sm"
                  : s.value === "execute"
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shadow-sm"
                    : "bg-background text-muted-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
