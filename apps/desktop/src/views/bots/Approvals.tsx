import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "~/api/mercury";
import type { BotApproval } from "~/api/types";
import { refreshApprovals } from "~/app/events";
import { useBots } from "~/app/store";
import { Button } from "~/components/ui/Button";

/**
 * A bot asking you mid-run: what it wants to do, how long it will wait, and
 * three answers. Allow once covers this run; Always allow is remembered in
 * that bot's own permissions; no answer in time is a no.
 */
export function ApprovalCard({ a }: { a: BotApproval }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const minutes = Math.max(0, Math.ceil((a.expiresAt - now) / 60_000));
  const [what, ...rest] = a.prompt.split(": ");
  const detail = rest.join(": ");

  async function answer(v: "yes" | "always" | "no") {
    setBusy(v);
    setProblem(null);
    try {
      await api.bots.answer(a.id, v);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void refreshApprovals();
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-amber/50 bg-amber/[0.05] p-4">
      <div className="flex items-start gap-2.5">
        <KeyRound size={16} className="mt-0.5 shrink-0 text-amber" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">{a.botName} asks to {what.toLowerCase()}</div>
          {detail && <code className="mt-1 block break-all rounded-md bg-ink/[0.06] px-2 py-1 font-mono text-xs text-ink" data-selectable>{detail}</code>}
          <p className="mt-1 text-xs text-ink3">It's waiting. {minutes > 0 ? `Without an answer in ${minutes} min, it's refused.` : "It's about to be refused."}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-[26px]">
        <Button size="sm" variant="primary" loading={busy === "yes"} disabled={!!busy} onClick={() => void answer("yes")}>Allow once</Button>
        <Button size="sm" variant="outline" loading={busy === "always"} disabled={!!busy} onClick={() => void answer("always")}>Always allow for {a.botName}</Button>
        <Button size="sm" variant="ghost" loading={busy === "no"} disabled={!!busy} onClick={() => void answer("no")}>Deny</Button>
        {problem && <span className="text-xs text-red">{problem}</span>}
      </div>
    </div>
  );
}

/** Every question waiting right now (for one bot, or all of them). */
export function PendingApprovals({ botId }: { botId?: string }) {
  const approvals = useBots((s) => s.approvals);
  useEffect(() => { void refreshApprovals(); }, []);
  const mine = approvals.filter((a) => !botId || a.botId === botId);
  if (mine.length === 0) return null;
  return <div className="flex flex-col gap-2">{mine.map((a) => <ApprovalCard key={a.id} a={a} />)}</div>;
}
