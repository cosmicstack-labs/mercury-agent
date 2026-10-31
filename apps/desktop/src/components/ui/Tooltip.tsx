import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({ label, side = "right", children, shortcut }: { label: string; side?: "top" | "right" | "bottom" | "left"; children: ReactNode; shortcut?: string }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={8}
          className="z-50 flex items-center gap-2 rounded-md border border-line bg-raised px-2 py-1 text-xs text-ink shadow-lg animate-fade-in"
        >
          {label}
          {shortcut && <kbd className="rounded border border-line px-1 font-mono text-2xs text-ink3">{shortcut}</kbd>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
