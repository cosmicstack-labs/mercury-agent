import { AlertTriangle, BellRing, CheckCircle2, Hand, X } from "lucide-react";
import { useEffect } from "react";
import { askPermission, openFromAlert, sendTest } from "~/app/notify/notify";
import { useNotify, type Alert } from "~/app/notify/store";
import { cx } from "~/lib/cx";

/**
 * In-app alerts: what a notification would have said, shown inside the
 * window (the window is in front, or system notifications are off). A
 * "needs you" alert stays until handled; the rest fade after a while.
 */

const STAY_MS: Record<Alert["kind"], number | null> = { needs: null, ask: null, done: 9000, failed: 14000 };

export function Alerts() {
  const alerts = useNotify((s) => s.alerts);
  if (!alerts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-12 z-[60] flex w-[340px] flex-col gap-2" aria-live="polite">
      {alerts.map((a) => <AlertCard key={a.id} alert={a} />)}
    </div>
  );
}

function AlertCard({ alert: a }: { alert: Alert }) {
  const dismiss = useNotify((s) => s.dismiss);
  const setPrefs = useNotify((s) => s.setPrefs);
  useEffect(() => {
    const ms = STAY_MS[a.kind];
    if (!ms) return;
    const t = window.setTimeout(() => dismiss(a.id), ms);
    return () => window.clearTimeout(t);
  }, [a.id, a.kind, dismiss]);

  const Icon = a.kind === "needs" ? Hand : a.kind === "failed" ? AlertTriangle : a.kind === "ask" ? BellRing : CheckCircle2;
  const tone = a.kind === "needs" ? "text-amber" : a.kind === "failed" ? "text-red" : "text-accent";
  return (
    <div role={a.kind === "needs" ? "alert" : "status"} className="pointer-events-auto flex animate-fade-in gap-3 rounded-xl border border-line bg-surface/95 p-3 shadow-xl backdrop-blur">
      <Icon size={18} className={cx("mt-0.5 shrink-0", tone)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{a.title}</div>
        <p className="mt-0.5 line-clamp-2 text-sm text-ink2">{a.body}</p>
        <div className="mt-2 flex gap-2">
          {a.sessionId && (
            <button onClick={() => { dismiss(a.id); openFromAlert(a.sessionId!); }} className="rounded-md bg-ink/[0.07] px-2.5 py-1 text-xs font-medium text-ink hover:bg-ink/[0.12]">
              {a.kind === "needs" ? "Answer" : "Open"}
            </button>
          )}
          {a.kind === "ask" && (
            <>
              <button onClick={() => { dismiss(a.id); setPrefs({ system: true }); void askPermission().then(() => sendTest()); }} className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:opacity-90">Turn on</button>
              <button onClick={() => { dismiss(a.id); setPrefs({ system: false }); }} className="rounded-md px-2.5 py-1 text-xs text-ink3 hover:text-ink">Not now</button>
            </>
          )}
        </div>
      </div>
      <button onClick={() => dismiss(a.id)} className="h-fit rounded p-0.5 text-ink4 hover:text-ink" aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}
