import { useState } from "react";
import { Wrench, Loader2, CheckCircle2, XCircle, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface ToolCallCardProps {
  tool: string;
  status: "running" | "done" | "error";
  result?: string;
}

const statusConfig = {
  running: {
    icon: Loader2,
    label: "Running...",
    color: "text-mercury-500",
    border: "border-l-mercury-500",
    iconClass: "animate-spin",
  },
  done: {
    icon: CheckCircle2,
    label: "Complete",
    color: "text-emerald-500",
    border: "border-l-emerald-500",
    iconClass: "",
  },
  error: {
    icon: XCircle,
    label: "Failed",
    color: "text-red-500",
    border: "border-l-red-500",
    iconClass: "",
  },
} as const;

export function ToolCallCard({ tool, status, result }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const config = statusConfig[status];
  const StatusIcon = config.icon;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "my-1.5 overflow-hidden rounded-md border border-border/60 border-l-2 bg-muted/30",
          config.border
        )}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-muted/50">
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
          <Wrench className="h-3 w-3 text-muted-foreground" />
          <span className="font-medium">{tool}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <StatusIcon
              className={cn("h-3.5 w-3.5", config.color, config.iconClass)}
            />
            <span className={cn("text-[0.6875rem]", config.color)}>
              {config.label}
            </span>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          {result && (
            <div className="max-h-40 overflow-auto border-t border-border/40 bg-background/50 px-3 py-2">
              <pre className="whitespace-pre-wrap font-mono text-[0.75rem] leading-relaxed text-muted-foreground">
                {result}
              </pre>
            </div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
