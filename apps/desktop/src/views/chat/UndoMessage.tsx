import { Loader2, Undo2 } from "lucide-react";
import { useState } from "react";
import type { ChatMessage } from "~/api/types";
import { useConversationStore } from "~/app/conversation";
import { turnRunning, undoLast } from "~/app/events";
import { Button } from "~/components/ui/Button";
import { Dialog } from "~/components/ui/Dialog";

/**
 * Undo on your last message: it leaves the conversation (with Mercury's
 * reply) and comes back to the box to change. While Mercury is still
 * working on it, ask first: undoing stops that work.
 */
export function UndoMessage({ message }: { message: ChatMessage }) {
  const store = useConversationStore();
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setAsking(false);
    setError(null);
    setWorking(true);
    try {
      await undoLast(store, message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't undo that.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <button
        onClick={() => (turnRunning(store) ? setAsking(true) : void run())}
        disabled={working}
        className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-ink4 hover:bg-ink/[0.06] hover:text-ink disabled:opacity-60"
        aria-label="Undo this message"
        title="Take this message back to edit it"
      >
        {working ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
        {working ? "Undoing…" : "Undo"}
      </button>
      {error && <span className="px-1.5 text-xs text-red" role="alert">{error}</span>}
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title="Stop and undo?"
        description="Mercury is still working on this message. Undo stops that work, removes your message and the reply so far, and puts your message back in the box to edit."
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAsking(false)}>Keep working</Button>
          <Button variant="primary" onClick={() => void run()}>Stop and undo</Button>
        </div>
      </Dialog>
    </>
  );
}
