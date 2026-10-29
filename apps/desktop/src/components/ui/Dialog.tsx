import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "~/lib/cx";

export function Dialog({ open, onOpenChange, title, description, children, width = 440 }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; width?: number }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40 animate-fade-in" />
        <RadixDialog.Content
          style={{ width }}
          className={cx("fixed left-1/2 top-1/2 z-50 max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-2xl animate-fade-in")}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <RadixDialog.Title className="text-md font-semibold text-ink">{title}</RadixDialog.Title>
              {description && <RadixDialog.Description className="mt-0.5 text-sm text-ink3">{description}</RadixDialog.Description>}
            </div>
            <RadixDialog.Close className="rounded-md p-1 text-ink3 hover:bg-ink/[0.06] hover:text-ink" aria-label="Close">
              <X size={16} />
            </RadixDialog.Close>
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
