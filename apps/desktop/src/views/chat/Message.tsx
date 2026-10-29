import { Check, ChevronRight, Copy, Square, Wrench } from "lucide-react";
import { memo, useState } from "react";
import type { ChatMessage, ThoughtTrace } from "~/api/types";
import { Mark } from "~/components/Logo";
import { Markdown } from "~/components/Markdown";
import { StreamCaret } from "~/components/indicators/Thinking";
import { ActionResult } from "~/components/indicators/Activity";
import { Attachments } from "~/components/Attachments";
import { ThoughtProcess } from "~/components/ThoughtProcess";
import { cx } from "~/lib/cx";
import { isStopNote } from "~/app/events";
import { UserAvatar, useDisplayName } from "~/components/UserAvatar";
import { usePulse } from "~/app/pulse";
import { ArtifactStrip } from "~/components/artifacts/ArtifactCard";
import { UndoMessage } from "./UndoMessage";
import { ReadAloudButton, ReadAloudNotice, useReadingThis } from "~/components/readAloud/ReadAloud";

/**
 * One entry in a conversation. Each kind the runtime stores gets its own
 * rendering:
 *  - user          on the right, in a soft bubble, your avatar beside it
 *  - assistant     on the left, full width: the mark and Mercury's name, then prose (markdown)
 *  - tool-call     a collapsed "used N tools" row; open it for each call
 *  - system        a muted note
 */
export const Message = memo(function Message({ message, undoable = false }: { message: ChatMessage; undoable?: boolean }) {
  const you = useDisplayName();
  if (message.role === "user") {
    const files = message.attachments ?? [];
    // "(Attached: a.png)" is the runtime's text for a files-only turn; the files say it better.
    const text = files.length > 0 && /^\(Attached: .*\)$/.test(message.content.trim()) ? "" : message.content;
    return (
      <div className="group flex justify-end gap-3 pt-2">
        <div className="flex min-w-0 max-w-[80%] flex-col items-end gap-1.5">
          {files.length > 0 && <Attachments items={files} />}
          {text && (
            <p className="whitespace-pre-wrap break-words rounded-[22px] rounded-tr-md bg-ink/[0.065] px-4 py-2.5 text-base leading-[1.6] text-ink [overflow-wrap:anywhere]" data-selectable>
              {text}
            </p>
          )}
          <MessageMeta timestamp={message.timestamp} copy={text || undefined} align="end" undo={undoable ? message : undefined} />
        </div>
        <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center" title={you} aria-hidden="true"><UserAvatar size={26} /></span>
      </div>
    );
  }
  if (message.kind === "tool-call" || message.role === "tool") {
    return <ToolActivity content={message.content} />;
  }
  if (message.role === "system") {
    return (
      <div className="pl-10">
        <p className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink3" data-selectable>{message.content}</p>
      </div>
    );
  }
  // Stopped turns: from this session (message.stopped) or from history (the runtime's note).
  const stopped = message.stopped || isStopNote(message.content);
  const body = stopped && isStopNote(message.content) ? "" : message.content;
  return (
    <div className="group flex gap-4">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true"><Mark size={22} /></span>
      <div className="min-w-0 flex-1">
        <Speaker who="mercury" />
        {message.trace && <ThoughtProcess trace={message.trace} />}
        {message.steps && message.steps.length > 0 && (
          <div className="mb-3 flex flex-col gap-1">
            {message.steps.map((s, i) => <ActionResult key={i} tool={s.tool} status={s.status} detail={s.result} />)}
          </div>
        )}
        {body && <Markdown text={body} />}
        {stopped && <StoppedMarker partial={!!body} />}
        {message.artifacts && message.artifacts.length > 0 && <ArtifactStrip items={message.artifacts} />}
        <MessageMeta timestamp={message.timestamp} copy={body || undefined} listen={body ? { id: message.id, text: body } : undefined} />
        <ReadAloudNotice id={message.id} />
      </div>
    </div>
  );
});

/** The honest end of a stopped turn: nothing after this was done. */
function StoppedMarker({ partial }: { partial: boolean }) {
  return (
    <div className={cx("flex items-center gap-2 text-sm text-ink3", partial && "mt-3")}>
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink/[0.07]"><Square size={9} className="fill-current" aria-hidden="true" /></span>
      {partial ? "Stopped by you. The answer above is incomplete." : "Stopped by you before an answer was written."}
    </div>
  );
}

/** Who is speaking: a small name line beside the avatar, so turns never blur together. */
function Speaker({ who }: { who: "you" | "mercury" }) {
  const you = useDisplayName();
  const agent = usePulse((s) => s.agentName);
  return (
    <div className={cx("flex h-6 items-center text-sm font-semibold", who === "you" ? "text-ink2" : "mb-1.5 text-ink")}>
      {who === "you" ? you : agent || "Mercury"}
    </div>
  );
}

/** Time and copy, shown on hover so the conversation stays quiet. */
function MessageMeta({ timestamp, copy, listen, undo, align = "start" }: { timestamp: string; copy?: string; listen?: { id: string; text: string }; undo?: ChatMessage; align?: "start" | "end" }) {
  const [copied, setCopied] = useState(false);
  const reading = useReadingThis(listen?.id ?? "");
  const time = formatTime(timestamp);
  return (
    <div className={cx("-mb-2 flex h-6 items-center gap-1 transition-opacity group-hover:opacity-100 focus-within:opacity-100", reading ? "opacity-100" : "opacity-0", align === "end" ? "mt-0 flex-row-reverse" : "mt-2")}>
      {copy && (
        <button
          onClick={() => { void navigator.clipboard.writeText(copy).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-ink4 hover:bg-ink/[0.06] hover:text-ink"
          aria-label={align === "end" ? "Copy message" : "Copy answer"}
        >
          {copied ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      {listen && <ReadAloudButton id={listen.id} text={listen.text} />}
      {undo && <UndoMessage message={undo} />}
      {time && <span className="px-1.5 text-xs text-ink4">{time}</span>}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

interface ToolLine {
  tool: string;
  args: string;
  status: "done" | "error";
  detail: string;
}

/** "[Tool activity …]\n- web_search query=… → ok (22 lines)" → structured rows. */
export function parseToolActivity(content: string): ToolLine[] {
  const lines: ToolLine[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2);
    const arrow = body.lastIndexOf("→");
    const head = arrow === -1 ? body : body.slice(0, arrow).trim();
    const tail = arrow === -1 ? "" : body.slice(arrow + 1).trim();
    const space = head.indexOf(" ");
    const tool = space === -1 ? head : head.slice(0, space);
    const args = space === -1 ? "" : head.slice(space + 1);
    const failed = /^(error|failed|denied|blocked)/i.test(tail);
    lines.push({ tool, args, status: failed ? "error" : "done", detail: tail.replace(/^ok\s*/i, "") });
  }
  return lines;
}

function ToolActivity({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const calls = parseToolActivity(content);
  if (calls.length === 0) return null;
  const names = [...new Set(calls.map((c) => c.tool))];
  const failed = calls.filter((c) => c.status === "error").length;
  return (
    <div className="pl-10">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-md py-1 text-sm text-ink3 hover:text-ink" aria-expanded={open}>
        <ChevronRight size={14} className={cx("transition-transform", open && "rotate-90")} aria-hidden="true" />
        <Wrench size={13} aria-hidden="true" />
        <span>Used {calls.length} tool{calls.length === 1 ? "" : "s"}</span>
        <span className="truncate font-mono text-xs text-ink4">{names.slice(0, 4).join(" · ")}{names.length > 4 ? " …" : ""}</span>
        {failed > 0 && <span className="text-xs text-red">{failed} failed</span>}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1 pl-5">
          {calls.map((c, i) => <ActionResult key={i} tool={c.tool} status={c.status} detail={[c.args, c.detail].filter(Boolean).join(" · ")} />)}
        </div>
      )}
    </div>
  );
}

/** The answer being written, with its thought process above it (open while it runs). */
export function StreamingMessage({ text, live, stopping = false }: { text: string; live: ThoughtTrace | null; stopping?: boolean }) {
  return (
    <div className="flex gap-4">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true"><Mark size={22} /></span>
      <div className="min-w-0 flex-1">
        <Speaker who="mercury" />
        {live && <ThoughtProcess trace={live} live={!text} stopping={stopping} />}
        {stopping && text && <div className="mb-2 text-sm text-ink3">Stopping…</div>}
        {text && <><Markdown text={text} streaming /><StreamCaret /></>}
      </div>
    </div>
  );
}
