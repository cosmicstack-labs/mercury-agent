import { useState } from "react";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PermissionPromptProps {
  id: string;
  tool: string;
  description: string;
  onResolve: (id: string, action: string) => void;
}

export function PermissionPrompt({
  id,
  tool,
  description,
  onResolve,
}: PermissionPromptProps) {
  const [resolved, setResolved] = useState<string | null>(null);

  const handleAction = (action: string) => {
    setResolved(action);
    onResolve(id, action);
  };

  return (
    <div className="flex gap-3">
      {/* Avatar placeholder to align with messages */}
      <div className="w-7 shrink-0" />

      <div
        className={cn(
          "max-w-[80%] overflow-hidden rounded-lg border border-border/60 border-l-2 border-l-amber-500 bg-card"
        )}
      >
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <Shield className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-semibold">Permission Required</span>
          </div>

          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Tool: <span className="font-mono text-foreground">{tool}</span>
          </p>
          <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>

          {resolved ? (
            <p className="text-xs text-muted-foreground">
              {resolved === "allow" ? "Allowed" : "Denied"}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => handleAction("allow")}>
                Allow
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleAction("deny")}
              >
                Deny
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
