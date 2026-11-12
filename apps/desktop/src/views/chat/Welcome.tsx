import { BookOpen, CalendarCheck, CornerDownLeft, History, ListChecks, RefreshCw, Sparkles, Telescope } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as api from "~/api/mercury";
import { ErrorBoundary } from "~/components/ErrorBoundary";
import { Mark } from "~/components/Logo";

/* ═══════════════════════════════════════════════════════════════
   A new chat: a greeting, a line from the agent about what the owner is
   up to, and four things they might want next — made by the runtime from
   what it knows about them (GET /api/suggestions), different on each new
   chat. Picking one puts it in the box to send or edit.

   Deliberately small: it must fit without scrolling. Nothing here may
   break a new chat: a failed request leaves its part out, and the page is
   guarded (SafeWelcome) so a crash shows the plain greeting.
   ═══════════════════════════════════════════════════════════════ */

const ICON = { continue: History, create: Sparkles, plan: CalendarCheck, check: ListChecks, learn: BookOpen, explore: Telescope } as const;
const PLAIN = "Ask, delegate, or think out loud. I'll remember what matters.";

export function Welcome({ onPick }: { onPick: (prompt: string) => void }) {
  const [pick, setPick] = useState<api.SuggestionPick | null>(null);
  const [round, setRound] = useState(0);

  const load = useCallback(() => {
    api.suggestions.pick(4).then((p) => { setPick(p); setRound((r) => r + 1); }).catch(() => { /* an older runtime, or none yet: the greeting alone */ });
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex w-full max-w-[640px] flex-col items-center gap-4 px-6 pb-20 text-center">
      <div className="relative flex items-center justify-center">
        <span aria-hidden="true" className="absolute h-28 w-28 rounded-full animate-breathe" style={{ background: "radial-gradient(closest-side, rgb(var(--glow) / 0.22), rgb(var(--glow) / 0))" }} />
        <Mark size={56} className="relative" />
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight text-ink">{pick?.greeting ?? "Mercury Agent"}</h2>
        <p className="max-w-[460px] text-base text-ink3">{pick?.subtitle ?? PLAIN}</p>
      </div>

      {pick && pick.items.length > 0 && (
        <div className="mt-2 flex w-full flex-col gap-2">
          <div key={round} className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
            {pick.items.map((s, i) => {
              const Icon = ICON[s.kind] ?? Sparkles;
              return (
                <button
                  key={s.id}
                  onClick={() => { onPick(s.prompt); void api.suggestions.used(s.id).catch(() => {}); }}
                  title={s.prompt}
                  className="suggest-in group flex min-w-0 items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:border-ink/25 hover:bg-raised"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><Icon size={14} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{s.title}</span>
                    {s.why && <span className="mt-0.5 block truncate text-xs text-ink4">{s.why}</span>}
                  </span>
                  <CornerDownLeft size={13} className="mt-1 shrink-0 text-ink4 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                </button>
              );
            })}
          </div>
          <button onClick={load} className="mx-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink4 hover:text-ink2">
            <RefreshCw size={11} /> More ideas
          </button>
        </div>
      )}
    </div>
  );
}

/** The page, guarded: if anything in it breaks, a plain greeting and the box, never an error card. */
export function SafeWelcome({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <ErrorBoundary label="Welcome" fallback={() => (
      <div className="flex flex-col items-center gap-3 px-6 pb-20 text-center">
        <Mark size={56} />
        <h2 className="text-2xl font-bold tracking-tight text-ink">Mercury Agent</h2>
        <p className="max-w-[460px] text-base text-ink3">{PLAIN}</p>
      </div>
    )}>
      <Welcome onPick={onPick} />
    </ErrorBoundary>
  );
}
