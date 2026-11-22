import { Check, ExternalLink, Puzzle, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import * as api from "~/api/mercury";
import { apiUrl, authHeaders } from "~/api/client";
import type { OwnerTask } from "~/api/types";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";

/**
 * Owner tasks (ADR-048): something only the owner can do — type the letters
 * of a CAPTCHA, read out a code, finish a step on a page — with the image or
 * audio, and a box for the answer. Shown on every app connected to Mercury
 * (this computer or a remote one); the first answer from anywhere wins and
 * the card disappears everywhere.
 */

const useTasks = create<{ items: OwnerTask[]; upsert: (t: OwnerTask) => void; remove: (id: string) => void; replace: (t: OwnerTask[]) => void }>((set) => ({
  items: [],
  upsert: (t) => set((s) => ({ items: [...s.items.filter((x) => x.id !== t.id), t] })),
  remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
  replace: (items) => set({ items }),
}));

/** From the activity stream. */
export function onOwnerTaskEvent(data: Record<string, unknown>): void {
  const t = data as unknown as OwnerTask & { change?: string };
  if (typeof t.id !== "string") return;
  if (t.change === "new" && t.status === "pending") useTasks.getState().upsert(t);
  else useTasks.getState().remove(t.id);
}

/** Tasks already waiting when the app connects. */
export async function loadOwnerTasks(): Promise<void> {
  try { useTasks.getState().replace(await api.ownerTasks.pending()); } catch { /* an older Mercury */ }
}

/** The media is behind the Bearer token, which an <img>/<audio> can't send. */
function useMedia(url: string | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    let made: string | null = null;
    fetch(apiUrl(url), { headers: authHeaders() })
      .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
      .then((u) => { made = u; if (live) setSrc(u); else if (u) URL.revokeObjectURL(u); })
      .catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [url]);
  return src;
}

function TaskCard({ task, now }: { task: OwnerTask; now: number }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const media = useMedia(task.media?.url);
  const mins = Math.max(1, Math.round((task.expiresAt - now) / 60_000));

  async function send(kind: "answer" | "decline") {
    setBusy(true);
    setError(null);
    try {
      if (kind === "decline") await api.ownerTasks.decline(task.id);
      else await api.ownerTasks.answer(task.id, task.answerKind === "done" ? (answer.trim() || "done") : answer.trim());
      useTasks.getState().remove(task.id);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409 || status === 404) useTasks.getState().remove(task.id); // answered elsewhere, or gone
      else setError(e instanceof Error ? e.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  const canSend = task.answerKind === "done" || answer.trim().length > 0;
  return (
    <form
      className="rounded-xl border border-accent/40 bg-raised p-3.5 shadow-2xl"
      role="alertdialog"
      aria-label={task.title}
      onSubmit={(e) => { e.preventDefault(); if (canSend && !busy) void send("answer"); }}
    >
      <div className="flex items-start gap-2.5">
        <Puzzle size={17} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{task.who} needs you: {task.title}</p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink2">{task.prompt}</p>
          {task.link && (
            <a href={task.link} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-accent hover:underline">
              <ExternalLink size={11} aria-hidden="true" /> <span className="truncate">{task.link}</span>
            </a>
          )}
        </div>
      </div>
      {task.media && (
        <div className="mt-2.5 flex justify-center rounded-lg border border-line bg-white/95 p-2">
          {!media ? <p className="py-6 text-xs text-ink3">Loading…</p>
            : task.media.kind === "image" ? <img src={media} alt="What to solve" className="max-h-48 max-w-full object-contain" />
            : <audio src={media} controls className="w-full" />}
        </div>
      )}
      {task.answerKind === "text" && (
        <Input
          className="mt-2.5"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Your answer"
          aria-label="Your answer"
          autoComplete="off"
          spellCheck={false}
          maxLength={2000}
          autoFocus
        />
      )}
      {error && <p className="mt-1.5 text-xs text-red">{error}</p>}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <p className="text-xs text-ink4">Code {task.code} · expires in {mins} min · never a password or PIN</p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void send("decline")}>Skip</Button>
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!canSend}>
            {task.answerKind === "done" ? <><Check size={13} /> Done</> : <><Send size={13} /> Send</>}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** `connectionId`: a switch to another Mercury drops the old one's tasks and loads the new one's. */
export function OwnerTaskCards({ connectionId }: { connectionId: string }) {
  const items = useTasks((s) => s.items);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!items.length) return; const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, [items.length]);
  useEffect(() => { useTasks.getState().replace([]); void loadOwnerTasks(); }, [connectionId]);
  const live = items.filter((t) => t.expiresAt > now);
  if (!live.length) return null;
  return (
    <div className="fixed bottom-6 right-4 z-50 flex max-h-[80vh] w-[min(420px,92vw)] flex-col gap-2 overflow-y-auto">
      {live.map((t) => <TaskCard key={t.id} task={t} now={now} />)}
    </div>
  );
}
