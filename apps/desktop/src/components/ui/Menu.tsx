import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "~/lib/cx";

export function Menu({ trigger, children, align = "start", side = "bottom" }: { trigger: ReactNode; children: ReactNode; align?: "start" | "center" | "end"; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align={align}
          side={side}
          sideOffset={6}
          className="z-50 min-w-[200px] rounded-lg border border-line bg-raised p-1 text-sm text-ink shadow-xl animate-fade-in"
        >
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function MenuItem({ children, onSelect, selected, disabled, hint, destructive }: { children: ReactNode; onSelect?: () => void; selected?: boolean; disabled?: boolean; hint?: string; destructive?: boolean }) {
  return (
    <Dropdown.Item
      disabled={disabled}
      onSelect={() => onSelect?.()}
      className={cx(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-ink/[0.06] data-[disabled]:opacity-40",
        destructive && "text-red",
      )}
    >
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="font-mono text-2xs text-ink3">{hint}</span>}
      {selected && <Check size={14} className="text-accent" aria-hidden="true" />}
    </Dropdown.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Dropdown.Label className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-ink3">{children}</Dropdown.Label>;
}

export function MenuSeparator() {
  return <Dropdown.Separator className="my-1 h-px bg-line" />;
}
