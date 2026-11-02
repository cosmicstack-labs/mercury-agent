import { Clock } from "lucide-react";
import { useState } from "react";
import * as api from "~/api/mercury";
import { useChat, useUi } from "~/app/store";
import { openThread } from "~/app/events";
import { surfaceOf } from "~/app/notify/notify";
import { Button } from "~/components/ui/Button";
import { ConfirmButton } from "~/components/ui/kit";

/**
 * In place of "Thinking" while this chat's message waits its turn: Mercury
 * works on one thing at a time, and another chat is ahead. Says which one and
 * what it's doing, and offers to open it or to go first (which stops it).
 */
export function WaitingNotice({ threadId, waiting }: { threadId: string | null; waiting: { position: number; busyWith?: string; busySessionId?: string } }) {
  const threads = useChat((s) => s.threads);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const other = waiting.busySessionId ? threads.find((t) => t.id === waiting.busySessionId) : undefined;
  const otherName = other?.title || other?.alias || (waiting.busySessionId ? "another chat" : "another task");
  const ahead = waiting.position > 1 ? ` ${waiting.position - 1} more ${waiting.position - 1 === 1 ? "message is" : "messages are"} ahead of yours.` : " Yours is next.";

  async function goFirst() {
    if (!threadId) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.chat.queueFirst(threadId);
      await api.chat.stop();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openOther() {
    const id = waiting.busySessionId;
    if (!id) return;
    const surface = surfaceOf(id);
    useUi.getState().setView(surface);
    void openThread(surface, id);
  }

  return (
    <div className="ml-10 flex flex-col gap-2.5 rounded-xl border border-line bg-soft px-4 py-3" role="status">
      <div className="flex items-start gap-2.5">
        <Clock size={15} className="mt-0.5 shrink-0 text-ink3" aria-hidden="true" />
        <p className="text-sm text-ink2">
          <span className="font-medium text-ink">Waiting.</span> Mercury works on one thing at a time and is finishing{" "}
          {waiting.busyWith ? <>“{waiting.busyWith}”</> : "something"} in <span className="text-ink">{otherName}</span>.{ahead}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-[25px]">
        {waiting.busySessionId && <Button size="sm" variant="ghost" onClick={openOther}>Open that chat</Button>}
        {threadId && (
          <ConfirmButton size="sm" variant="ghost" confirmLabel="Stop it and start yours?" loading={busy} onConfirm={() => void goFirst()}>
            Do mine first
          </ConfirmButton>
        )}
        {problem && <span className="text-xs text-red">{problem}</span>}
      </div>
    </div>
  );
}
