import * as ContextMenu from "@radix-ui/react-dropdown-menu";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cx } from "~/lib/cx";
import { useUi } from "~/app/store";
import { isVisible, orderedIds, useContributions, type ContributionArea } from "~/extensions/registry";

/**
 * The bottom bar. It renders whatever is registered (extensions/registry),
 * filtered to the current view and the user's layout. Right-click anywhere
 * on it to choose items and their order — the VS Code model.
 */
export function StatusBar() {
  const items = useContributions((s) => s.items);
  const layout = useContributions((s) => s.layout);
  const view = useUi((s) => s.view);
  const [menuOpen, setMenuOpen] = useState(false);

  const visibleIn = (area: ContributionArea) =>
    orderedIds(items, layout, area)
      .map((id) => items[id])
      .filter((i) => i && isVisible(i, layout) && (!i.views || i.views.includes(view)));

  return (
    <footer
      className="relative flex h-7 shrink-0 select-none items-center gap-0.5 border-t border-line bg-soft px-1.5 text-xs text-ink3"
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
      role="status"
      aria-label="Status bar"
    >
      {visibleIn("status.left").map((i) => { const C = i.render; return <C key={i.id} />; })}
      <div className="flex-1" />
      {visibleIn("status.right").map((i) => { const C = i.render; return <C key={i.id} />; })}
      <CustomizeMenu open={menuOpen} onOpenChange={setMenuOpen} />
    </footer>
  );
}

function CustomizeMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const items = useContributions((s) => s.items);
  const layout = useContributions((s) => s.layout);
  const setVisible = useContributions((s) => s.setVisible);
  const move = useContributions((s) => s.move);
  const reset = useContributions((s) => s.reset);
  const areas: Array<[ContributionArea, string]> = [["status.left", "Left"], ["status.right", "Right"]];
  return (
    <ContextMenu.Root open={open} onOpenChange={onOpenChange}>
      <ContextMenu.Trigger asChild><span className="absolute bottom-full right-2 h-0 w-0" aria-hidden="true" /></ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content side="top" align="end" sideOffset={4} className="z-50 w-[300px] rounded-lg border border-line bg-raised p-1 text-sm text-ink shadow-xl animate-fade-in">
          <div className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-ink4">Status bar items</div>
          {areas.map(([area, label]) => (
            <div key={area}>
              <div className="px-2 pt-1.5 text-2xs text-ink4">{label}</div>
              {orderedIds(items, layout, area).map((id) => {
                const item = items[id];
                const on = isVisible(item, layout);
                return (
                  <div key={id} className="group flex items-center gap-1 rounded-md pr-1 hover:bg-ink/[0.06]">
                    <ContextMenu.Item onSelect={(e) => { e.preventDefault(); setVisible(id, !on); }} className="flex flex-1 cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none">
                      <span className="flex h-4 w-4 items-center justify-center rounded border border-line-strong">{on && <Check size={12} className="text-accent" />}</span>
                      <span className="flex-1 truncate">{item.title}</span>
                      {item.source && item.source !== "mercury" && <span className="text-2xs text-ink4">{item.source}</span>}
                    </ContextMenu.Item>
                    <button onClick={() => move(id, -1)} className="hidden rounded p-0.5 text-ink4 hover:text-ink group-hover:block" aria-label={`Move ${item.title} left`}><ArrowLeft size={12} /></button>
                    <button onClick={() => move(id, 1)} className="hidden rounded p-0.5 text-ink4 hover:text-ink group-hover:block" aria-label={`Move ${item.title} right`}><ArrowRight size={12} /></button>
                  </div>
                );
              })}
            </div>
          ))}
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <ContextMenu.Item onSelect={() => reset()} className="cursor-default rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-ink/[0.06]">Reset to default</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A clickable status bar entry. Items use this so they look and behave alike. */
export function StatusButton({ children, title, onClick, tone, className }: { children: ReactNode; title: string; onClick?: () => void; tone?: "accent" | "amber" | "red" | "cyan"; className?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cx(
        "flex h-[22px] items-center gap-1.5 rounded px-1.5 transition-colors hover:bg-ink/[0.07] hover:text-ink",
        tone === "accent" && "text-accent", tone === "amber" && "text-amber", tone === "red" && "text-red", tone === "cyan" && "text-cyan",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A status entry that opens a panel upwards (lists, breakdowns). */
export function StatusPopover({ trigger, children, width = 340 }: { trigger: ReactNode; children: ReactNode; width?: number }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{trigger}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content side="top" align="start" sideOffset={6} style={{ width }} className="z-50 max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-raised p-3 text-sm text-ink shadow-xl animate-fade-in">
          {children}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
