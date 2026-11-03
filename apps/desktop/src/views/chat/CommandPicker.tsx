import { Hash, Puzzle, Slash } from "lucide-react";
import { useEffect, useRef } from "react";
import { cx } from "~/lib/cx";
import type { PickerItem } from "./picker";

/**
 * The list above the composer while you type "/…" or "#…": the command (or
 * skill), what it takes, and what it does. Arrow keys move, Tab fills, Enter
 * runs a command that needs nothing more (or fills one that does), Esc closes.
 */
export function CommandPicker({ items, active, mode, onPick, onHover }: {
  items: PickerItem[];
  active: number;
  mode: "command" | "skill";
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_8px_32px_-12px_rgb(0_0_0/0.28)]" role="listbox" aria-label={mode === "command" ? "Commands" : "Skills"}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-2xs font-medium uppercase tracking-wider text-ink4">
        {mode === "command" ? <Slash size={11} /> : <Hash size={11} />}
        {mode === "command" ? "Commands" : "Skills"}
        <span className="flex-1" />
        <span className="normal-case tracking-normal">↑↓ choose · Tab fill · Enter {mode === "command" ? "run" : "use"} · Esc close</span>
      </div>
      <div ref={list} className="max-h-[300px] overflow-y-auto py-1">
        {items.map((item, i) => (
          <button
            key={item.key}
            data-index={i}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
            className={cx("flex w-full items-baseline gap-3 px-4 py-1.5 text-left", i === active ? "bg-ink/[0.06]" : "")}
          >
            <span className="shrink-0 font-mono text-[13px] text-ink">{item.label}</span>
            {item.hint && <span className="shrink-0 font-mono text-xs text-ink4">{item.hint}</span>}
            <span className="min-w-0 flex-1 truncate text-xs text-ink3">{item.description}</span>
            {item.kind === "command" && item.plugin && <span className="flex shrink-0 items-center gap-1 text-2xs text-ink4"><Puzzle size={10} />{item.plugin}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
