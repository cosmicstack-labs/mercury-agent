import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/Button";
import { Kbd, Spinner } from "~/components/ui/bits";
import { splitLabel } from "~/components/indicators/Approval";
import { cx } from "~/lib/cx";
import type { Described } from "./describe";

/* ═══════════════════════════════════════════════════════════════
   "Needs you": everything waiting on your answer, one at a time, in
   the same card as the plan (pinned above the composer). "1 of 4" with
   ‹ › and ←/→ to move through them; answering one moves to the next, and
   the card goes away when none are left. Y / N answer allow / deny,
   1–9 pick from a list. Plain words on top, the exact command or path
   underneath, folded when long.
   ═══════════════════════════════════════════════════════════════ */

export interface NeedsYouOption {
  value: string;
  label: string;
  /** primary: the main answer; secondary: another yes; quiet: no / deny (on the right). */
  role: "primary" | "secondary" | "quiet";
}

export interface NeedsYouItem {
  id: string;
  described: Described;
  options: NeedsYouOption[];
  /** A pick from a list (rows, 1–9) rather than buttons. */
  list?: boolean;
  /** Who asks, when it isn't Mercury itself ("Researcher · waits 8 min"). */
  from?: string;
  onAnswer(value: string | null): Promise<void> | void;
  /** A pick can be cancelled. */
  cancelable?: boolean;
}

const CODE_FOLD = 6;

export function NeedsYou({ items, keys = true, className }: { items: NeedsYouItem[]; keys?: boolean; className?: string }) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const lastIds = useRef<string[]>([]);

  // Keep showing the same question when others arrive or leave; a new list starts at the first.
  useEffect(() => {
    const ids = items.map((i) => i.id);
    const current = lastIds.current[index];
    const at = current ? ids.indexOf(current) : -1;
    setIndex(at >= 0 ? at : Math.min(index, Math.max(0, ids.length - 1)));
    lastIds.current = ids;
  }, [items.map((i) => i.id).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOpen(false); }, [index]);

  const item = items[Math.min(index, items.length - 1)];
  const busyRef = useRef(busy);
  busyRef.current = busy;

  async function answer(value: string | null) {
    if (!item || busyRef.current !== null) return;
    setBusy(value ?? "__cancel");
    try { await item.onAnswer(value); } finally { setBusy(null); }
  }
  const answerRef = useRef(answer);
  answerRef.current = answer;
  const count = items.length;
  const go = (d: number) => setIndex((i) => (count ? (i + d + count) % count : 0));

  useEffect(() => {
    if (!keys || !item) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "arrowright" && count > 1) { e.preventDefault(); go(1); return; }
      if (k === "arrowleft" && count > 1) { e.preventDefault(); go(-1); return; }
      if (item.list && /^[1-9]$/.test(k)) {
        const o = item.options[Number(k) - 1];
        if (o) { e.preventDefault(); void answerRef.current(o.value); }
        return;
      }
      const yes = item.options.find((o) => o.role === "primary");
      const no = item.options.find((o) => o.role === "quiet");
      if (!item.list && k === "y" && yes) { e.preventDefault(); void answerRef.current(yes.value); }
      if (!item.list && k === "n" && no) { e.preventDefault(); void answerRef.current(no.value); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, item, count]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;
  const d = item.described;
  const codeLines = d.code ? d.code.split("\n") : [];
  const folded = !open && codeLines.length > CODE_FOLD;
  const yes = item.options.filter((o) => o.role !== "quiet");
  const no = item.options.filter((o) => o.role === "quiet");

  return (
    <section className={cx("overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]", className)} aria-label="Needs you" role="group">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
          <span className="absolute h-2 w-2 animate-ping rounded-full bg-amber/50" />
          <span className="h-2 w-2 rounded-full bg-amber" />
        </span>
        <span className="shrink-0 text-sm font-medium text-ink">Needs you</span>
        {count > 1 && <span className="shrink-0 font-mono text-xs tabular-nums text-ink3">{index + 1} of {count}</span>}
        {item.from && <span className="min-w-0 truncate text-xs text-ink3">· {item.from}</span>}
        <span className="flex-1" />
        {count > 1 && (
          <span className="flex shrink-0 items-center gap-1">
            <span className="mr-1 hidden gap-1 sm:flex" aria-hidden="true">
              {items.slice(0, 8).map((x, i) => <span key={x.id} className={cx("h-1.5 rounded-full transition-all", i === index ? "w-4 bg-ink/60" : "w-1.5 bg-ink/15")} />)}
            </span>
            <button onClick={() => go(-1)} className="rounded-md p-1 text-ink3 hover:bg-ink/[0.06] hover:text-ink" aria-label="Previous"><ChevronLeft size={15} /></button>
            <button onClick={() => go(1)} className="rounded-md p-1 text-ink3 hover:bg-ink/[0.06] hover:text-ink" aria-label="Next"><ChevronRight size={15} /></button>
          </span>
        )}
      </div>

      <div key={item.id} className="animate-fade-in border-t border-line px-4 py-3">
        <div className="text-sm font-medium text-ink">{d.title}</div>
        {d.warning && (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-amber"><AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />{d.warning}</p>
        )}
        {d.code && (
          <div className="mt-2">
            <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-ink/[0.03] px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink [overflow-wrap:anywhere]" data-selectable>
              {folded ? codeLines.slice(0, CODE_FOLD).join("\n") : d.code}
            </pre>
            {codeLines.length > CODE_FOLD && (
              <button onClick={() => setOpen(!open)} className="mt-1 text-2xs text-ink3 hover:text-ink">{open ? "Show less" : `Show all ${codeLines.length} lines`}</button>
            )}
          </div>
        )}
        {d.body && <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink2 [overflow-wrap:anywhere]" data-selectable>{d.body}</p>}
        {d.note && <p className="mt-1.5 text-xs text-ink3">{d.note}</p>}

        {item.list ? (
          <div className="mt-3 flex flex-col gap-1.5" role="listbox" aria-label={d.title}>
            {item.options.map((o, i) => {
              const { name, detail } = splitLabel(o.label);
              return (
                <button key={o.value} role="option" aria-selected={false} disabled={busy !== null} onClick={() => void answer(o.value)}
                  className="flex w-full min-w-0 items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-ink/25 hover:bg-ink/[0.03] disabled:opacity-60">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-line bg-soft font-mono text-2xs text-ink3">
                    {busy === o.value ? <Spinner size={10} /> : i < 9 ? i + 1 : "·"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{name}</span>
                    {detail && <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-ink3">{detail}</span>}
                  </span>
                </button>
              );
            })}
            {item.cancelable && (
              <div><Button size="sm" variant="ghost" loading={busy === "__cancel"} disabled={busy !== null} onClick={() => void answer(null)}>Cancel</Button></div>
            )}
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {yes.map((o) => (
              <Button key={o.value} size="sm" variant={o.role === "primary" ? "primary" : "outline"} loading={busy === o.value} disabled={busy !== null} onClick={() => void answer(o.value)}>{o.label}</Button>
            ))}
            <span className="flex-1" />
            {keys && yes[0] && no[0] && (
              <span className="mr-1 hidden items-center gap-1 text-2xs text-ink4 md:inline-flex"><Kbd>Y</Kbd> / <Kbd>N</Kbd></span>
            )}
            {no.map((o) => (
              <Button key={o.value} size="sm" variant="ghost" loading={busy === o.value} disabled={busy !== null} onClick={() => void answer(o.value)}>{o.label}</Button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Roles for a runtime prompt's answers: the first is the main one, a deny-like one is quiet, the rest secondary. */
export function rolesFor(options: Array<{ value: string; label: string }>): NeedsYouOption[] {
  const denyIdx = options.length >= 2
    ? Math.max(options.findIndex((o) => /^(deny|no|don'?t|stop|reject|decline|never|cancel)\b/i.test(o.label)), -1)
    : -1;
  return options.map((o, i) => ({ ...o, role: i === denyIdx ? "quiet" : i === 0 ? "primary" : "secondary" }));
}
