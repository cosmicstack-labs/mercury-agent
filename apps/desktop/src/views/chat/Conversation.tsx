import { ArrowDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PlanCard } from "./PlanCard";
import { jumpLabel, useFollowBottom } from "./follow";
import { cx } from "~/lib/cx";
import { useConversation, useConversationStore } from "~/app/conversation";
import { answerPrompt } from "~/app/events";
import { StateLabel } from "~/components/indicators/StateOrb";
import { Approval } from "~/components/indicators/Approval";
import { ThinkingDots } from "~/components/indicators/Thinking";
import { Message, StreamingMessage } from "./Message";
import { Composer, type ComposerProps } from "./Composer";

const PAGE = 30;

/**
 * One conversation column: header, messages (newest PAGE, older on
 * scroll-up with the place kept), approvals, composer. It reads the
 * surface it is rendered in (ConversationContext), so Chat and Code use
 * the same component without sharing any state.
 */
export function Conversation({ header, empty, composer }: { header: ReactNode; empty: ReactNode; composer: ComposerProps }) {
  const store = useConversationStore();
  const messages = useConversation((s) => s.messages);
  const streaming = useConversation((s) => s.streaming);
  const loading = useConversation((s) => s.loading);
  const activeId = useConversation((s) => s.activeId);
  const agent = useConversation((s) => s.agent);
  const step = useConversation((s) => s.step);
  const prompts = useConversation((s) => s.prompts);
  const live = useConversation((s) => s.live);
  const stopping = useConversation((s) => s.stopping);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(PAGE);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const follow = useFollowBottom(scroller, content, activeId);
  const busy = !!streaming || stopping || agent === "thinking" || agent === "working" || agent === "streaming";

  // While the reader is up the page: count what arrived, and notice the reply ending.
  const [away, setAway] = useState<{ since: number; wasBusy: boolean } | null>(null);
  useEffect(() => {
    setAway(follow.following ? null : (a) => a ?? { since: messages.length, wasBusy: busy });
  }, [follow.following]); // eslint-disable-line react-hooks/exhaustive-deps
  const unseen = away ? messages.slice(away.since).filter((m) => m.role !== "user").length : 0;
  const finished = !!away?.wasBusy && !busy;

  // Sending a message follows again: you want to see the answer.
  const lastId = messages[messages.length - 1]?.id;
  const lastRole = messages[messages.length - 1]?.role;
  useEffect(() => { if (lastRole === "user") follow.jump(false); }, [lastId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setVisible(PAGE); }, [activeId]);
  const shown = messages.length > visible ? messages.slice(messages.length - visible) : messages;
  // Only your last message can be undone.
  const lastYours = [...messages].reverse().find((m) => m.role === "user")?.id;
  const hiddenCount = messages.length - shown.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    const p = prepend.current;
    if (!el || !p) return;
    el.scrollTop = p.top + (el.scrollHeight - p.height);
    prepend.current = null;
  }, [visible]);
  function loadEarlier() {
    const el = scroller.current;
    if (!el || hiddenCount <= 0) return;
    prepend.current = { height: el.scrollHeight, top: el.scrollTop };
    setVisible((v) => v + PAGE);
  }
  const isEmpty = !activeId && messages.length === 0 && !streaming;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4" data-tauri-drag-region>
        <div className="flex min-w-0 flex-1 items-center gap-3">{header}</div>
        <StateLabel state={agent} detail={step?.tool ? `${step.tool}${step.total ? ` ${step.current}/${step.total}` : ""}` : undefined} />
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        tabIndex={-1}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.onScroll();
          if (el.scrollTop < 160 && hiddenCount > 0 && !prepend.current) loadEarlier();
        }}
        className={cx("min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none", isEmpty && "flex flex-col")}
      >
        {/* Centred with auto margins, not justify-center: when the start screen
            is taller than the window, justify-center pushes its top under the
            header where it can't be scrolled to. Auto margins collapse instead. */}
        {isEmpty ? <div className="m-auto flex w-full justify-center py-8">{empty}</div> : (
          <div ref={content} className="mx-auto flex w-full min-w-0 max-w-[780px] flex-col gap-7 px-8 py-8 [&>*]:min-w-0">
            {loading && messages.length === 0 && <ThinkingDots label="Loading" />}
            {hiddenCount > 0 && (
              <button onClick={loadEarlier} className="self-center rounded-full border border-line px-3 py-1 text-xs text-ink3 hover:text-ink">
                {hiddenCount} earlier message{hiddenCount === 1 ? "" : "s"}
              </button>
            )}
            {shown.map((m) => <Message key={m.id} message={m} undoable={m.id === lastYours} />)}
            {(streaming || (live && (agent === "thinking" || agent === "working" || agent === "streaming" || agent === "needs-you"))) && (
              <StreamingMessage text={streaming} live={live} stopping={stopping} />
            )}
            {!streaming && !live && (agent === "thinking" || agent === "working") && (
              <ThinkingDots label={stopping ? "Stopping" : agent === "working" && step?.tool ? `Running ${step.tool}` : "Thinking"} className="pl-10" />
            )}
            {prompts.map((p, i) => (
              <div key={p.id} className="min-w-0 pl-10">
                <Approval prompt={p} onAnswer={(v) => answerPrompt(store, p, v)} keys={i === prompts.length - 1} />
              </div>
            ))}
          </div>
        )}
      </div>
      {!follow.following && !isEmpty && (
        <button
          onClick={() => follow.jump()}
          className="absolute bottom-4 left-1/2 flex h-8 -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-xs font-medium text-ink2 shadow-md transition-colors hover:border-line-strong hover:text-ink"
          aria-label="Jump to the latest message"
        >
          {busy && unseen === 0 ? <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent" aria-hidden="true" /> : null}
          {unseen > 0 && <span className="h-1.5 w-1.5 rounded-full bg-blue" aria-hidden="true" />}
          {jumpLabel({ busy, unseen, finished })}
          <ArrowDown size={13} aria-hidden="true" />
        </button>
      )}
      </div>

      <PlanCard surface={composer.surface} />
      <Composer {...composer} />
    </section>
  );
}
