import { useEffect, useRef, useState } from "react";
import { cx } from "~/lib/cx";
import type { PendingPrompt } from "~/api/types";
import { Button } from "~/components/ui/Button";
import { Kbd, Spinner } from "~/components/ui/bits";

/**
 * "Needs you": a prompt the runtime raised and is waiting on. One card for
 * all three kinds (tool permission, continue?, pick one). The amber edge is
 * the only colour.
 *
 * Short answers ("Allow", "Deny") sit in a row of buttons. Picks, and any
 * answer too long for a button, become a list of full-width rows that wrap,
 * "name — description" split into a bold name and a quiet line under it,
 * so nothing ever runs off the card. Keys work when you aren't typing:
 * Y / N for allow / deny, 1-9 to pick.
 */
export function Approval({ prompt, onAnswer, compact, keys = false }: { prompt: PendingPrompt; onAnswer: (value: string | null) => Promise<void> | void; compact?: boolean; keys?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  async function answer(value: string | null) {
    if (busyRef.current !== null) return;
    setBusy(value ?? "__cancel");
    try {
      await onAnswer(value);
    } finally {
      setBusy(null);
    }
  }
  const answerRef = useRef(answer);
  answerRef.current = answer;

  const title = prompt.kind === "permission" ? "Allow this?" : prompt.kind === "continue" ? "Keep going?" : "Your pick";
  const asList = prompt.kind === "choice" || prompt.options.some((o) => o.label.length > 32);
  const deny = denyOption(prompt);
  const yesNo = !asList && prompt.options.length >= 2 && !!deny;

  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (asList && /^[1-9]$/.test(k)) {
        const o = prompt.options[Number(k) - 1];
        if (o) { e.preventDefault(); void answerRef.current(o.value); }
      } else if (yesNo && k === "y") {
        e.preventDefault();
        void answerRef.current(prompt.options[0].value);
      } else if (yesNo && k === "n" && deny) {
        e.preventDefault();
        void answerRef.current(deny.value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, asList, yesNo, deny, prompt.options]);

  return (
    <div className={cx("min-w-0 max-w-full rounded-lg border border-amber/40 bg-amber/[0.06] p-3", compact && "p-2.5")} role="group" aria-label={title}>
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-amber">
        <span className="block h-1.5 w-1.5 rounded-full bg-amber" aria-hidden="true" />
        {title}
      </div>
      {prompt.kind === "permission"
        ? <pre className="mb-3 whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-ink [overflow-wrap:anywhere]" data-selectable>{prompt.text}</pre>
        : <p className="mb-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink [overflow-wrap:anywhere]" data-selectable>{prompt.text}</p>}

      {asList ? (
        <>
          <div className="flex flex-col gap-1.5" role="listbox" aria-label={title}>
            {prompt.options.map((o, i) => {
              const { name, detail } = splitLabel(o.label);
              return (
                <button
                  key={o.value}
                  role="option"
                  aria-selected={false}
                  disabled={busy !== null}
                  onClick={() => void answer(o.value)}
                  className={cx(
                    "flex w-full min-w-0 items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                    i === 0 ? "border-accent/50 bg-accent/[0.07] hover:bg-accent/[0.12]" : "border-line bg-surface hover:border-ink/25 hover:bg-ink/[0.03]",
                  )}
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-line bg-soft font-mono text-2xs text-ink3">
                    {busy === o.value ? <Spinner size={10} /> : i < 9 ? i + 1 : "·"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{name}</span>
                    {detail && <span className="mt-0.5 line-clamp-2 block break-words text-xs leading-relaxed text-ink3 [overflow-wrap:anywhere]" title={detail}>{detail}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {prompt.kind === "choice" && (
              <Button size="sm" variant="ghost" loading={busy === "__cancel"} disabled={busy !== null} onClick={() => void answer(null)}>Cancel</Button>
            )}
            {keys && !compact && <span className="ml-auto hidden items-center gap-1 text-2xs text-ink4 sm:inline-flex"><Kbd>1</Kbd>–<Kbd>{Math.min(9, prompt.options.length)}</Kbd> to pick</span>}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {prompt.options.map((o, i) => (
            <Button key={o.value} size="sm" variant={i === 0 ? "primary" : "outline"} loading={busy === o.value} disabled={busy !== null} onClick={() => void answer(o.value)}>
              {o.label}
            </Button>
          ))}
          {keys && yesNo && deny && !compact && (
            <span className="ml-auto hidden items-center gap-1 text-2xs text-ink4 sm:inline-flex">
              <Kbd>Y</Kbd> {prompt.options[0].label.toLowerCase()} <Kbd>N</Kbd> {deny.label.toLowerCase()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** "web-search — Search the web…" → name "web-search", detail "Search the web…". */
export function splitLabel(label: string): { name: string; detail: string | null } {
  const m = label.match(/^(.{1,60}?)\s+[—–-]{1,2}\s+([\s\S]+)$/);
  return m ? { name: m[1].trim(), detail: m[2].trim() } : { name: label, detail: null };
}

/** The "no" answer of a yes/no prompt: a deny-like label, else the last option. */
export function denyOption(prompt: PendingPrompt): PendingPrompt["options"][number] | null {
  if (prompt.options.length < 2) return null;
  return prompt.options.find((o) => /^(deny|no|don'?t|stop|reject|decline|never)\b/i.test(o.label)) ?? prompt.options[prompt.options.length - 1];
}
