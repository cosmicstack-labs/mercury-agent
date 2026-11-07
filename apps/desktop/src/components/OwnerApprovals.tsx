import { KeyRound, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import * as api from "~/api/mercury";
import { setApprovalHandler } from "~/api/client";
import type { OwnerApproval } from "~/api/types";
import { Button } from "~/components/ui/Button";

/**
 * Security questions, both sides of them:
 *
 *  - WaitingForOwner: this app (connected to a remote Mercury) asked for
 *    something sensitive; the owner must approve it on their channel or that
 *    computer. Shown until they answer; the request then goes through by itself.
 *  - OwnerApprovalCards: this app IS on the Mercury computer; a device or a
 *    remote action is waiting for the owner here: Approve / Deny.
 */

interface Waiting { approvalId: string; code: string; where: string; error: string; expiresAt?: number; resolve: (ok: boolean) => void }

const useWaiting = create<{ waiting: Waiting | null; set: (w: Waiting | null) => void }>((set) => ({ waiting: null, set: (waiting) => set({ waiting }) }));

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Installed once: every 428 from the runtime waits here for the owner. */
export function installApprovalHandler(): void {
  setApprovalHandler(async (needed) => new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; useWaiting.getState().set(null); resolve(ok); };
    useWaiting.getState().set({ ...needed, resolve: finish });
    void (async () => {
      const until = needed.expiresAt ?? Date.now() + 10 * 60_000;
      while (!done && Date.now() < until + 5_000) {
        await pause(2000);
        if (done) return;
        try {
          const s = await api.security.status(needed.approvalId);
          if (s.status === "allowed") return finish(true);
          if (s.status === "denied" || s.status === "expired") return finish(false);
        } catch { /* keep waiting */ }
      }
      finish(false);
    })();
  }));
}

export function WaitingForOwner() {
  const w = useWaiting((s) => s.waiting);
  if (!w) return null;
  const what = w.error.replace(/^Waiting for the owner to approve: /, "").replace(/\. Approve it on[\s\S]*$/, "");
  return (
    <div className="fixed bottom-6 left-1/2 z-50 w-[min(520px,92vw)] -translate-x-1/2 rounded-xl border border-line bg-raised p-4 shadow-2xl" role="status">
      <div className="flex items-start gap-3">
        <KeyRound size={18} className="mt-0.5 shrink-0 text-amber" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Waiting for the owner's approval</p>
          <p className="mt-0.5 text-sm text-ink2">{what || "This needs the owner's OK."}</p>
          <p className="mt-1.5 text-xs text-ink3">Approve it on {w.where}. Code <span className="font-mono font-medium text-ink">{w.code}</span>. It continues by itself once approved.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => w.resolve(false)} aria-label="Stop waiting"><X size={13} /> Cancel</Button>
      </div>
    </div>
  );
}

const useLocalApprovals = create<{ items: OwnerApproval[]; upsert: (a: OwnerApproval) => void; remove: (id: string) => void; replace: (a: OwnerApproval[]) => void }>((set) => ({
  items: [],
  upsert: (a) => set((s) => ({ items: [...s.items.filter((x) => x.id !== a.id), a] })),
  remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
  replace: (items) => set({ items }),
}));

/** From the activity stream (sent only to apps on the Mercury computer). */
export function onOwnerApprovalEvent(data: Record<string, unknown>): void {
  const a = data as unknown as OwnerApproval & { change?: string };
  if (typeof a.id !== "string") return;
  if (a.change === "new" && a.status === "pending") useLocalApprovals.getState().upsert(a);
  else useLocalApprovals.getState().remove(a.id);
}

/** Questions already waiting when the app connects. */
export async function loadOwnerApprovals(): Promise<void> {
  try { useLocalApprovals.getState().replace((await api.security.approvals()).pending); } catch { /* remote, or an older Mercury */ }
}

export function OwnerApprovalCards({ local }: { local: boolean }) {
  const items = useLocalApprovals((s) => s.items);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!items.length) return; const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, [items.length]);
  useEffect(() => { if (local) void loadOwnerApprovals(); else useLocalApprovals.getState().replace([]); }, [local]);
  const live = items.filter((a) => a.expiresAt > now);
  if (!local || !live.length) return null;
  async function decide(a: OwnerApproval, d: "allow" | "deny") {
    setBusy(a.id);
    try { await api.security.decide(a.id, d); } catch { /* already answered elsewhere */ }
    useLocalApprovals.getState().remove(a.id);
    setBusy(null);
  }
  return (
    <div className="fixed right-4 top-14 z-50 flex w-[min(400px,92vw)] flex-col gap-2">
      {live.map((a) => (
        <div key={a.id} className="rounded-xl border border-amber/40 bg-raised p-3.5 shadow-2xl" role="alertdialog" aria-label={a.title}>
          <div className="flex items-start gap-2.5">
            <ShieldAlert size={17} className="mt-0.5 shrink-0 text-amber" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{a.kind === "pair" ? "A new device wants to connect" : `${a.who} wants to…`}</p>
              <p className="mt-0.5 text-sm text-ink2">{a.kind === "pair" ? a.who : a.title}</p>
              {(a.detail || a.ip) && <p className="mt-0.5 break-words font-mono text-xs text-ink3">{[a.detail, a.ip && a.kind === "action" ? `from ${a.ip}` : null].filter(Boolean).join(" · ")}</p>}
              <p className="mt-1 text-xs text-ink4">Code {a.code} · expires in {Math.max(1, Math.round((a.expiresAt - now) / 60_000))} min{a.kind === "pair" ? " · deny it if you didn't just sign in somewhere" : ""}</p>
            </div>
          </div>
          <div className="mt-2.5 flex justify-end gap-2">
            <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => void decide(a, "deny")}>Deny</Button>
            <Button size="sm" variant="primary" loading={busy === a.id} onClick={() => void decide(a, "allow")}><ShieldCheck size={13} /> {a.kind === "pair" ? "Approve device" : "Allow once"}</Button>
          </div>
        </div>
      ))}
    </div>
  );
}
