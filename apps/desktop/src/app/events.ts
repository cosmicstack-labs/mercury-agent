/* ═══════════════════════════════════════════════════════════════
   Live events from the runtime → app state. Each conversation surface
   (Chat, Code) has its own event stream scoped to its own session, so
   their activity never mixes; plus one bots stream. Nothing polls for
   what streams.
   ═══════════════════════════════════════════════════════════════ */

import { useEffect } from "react";
import { openStream } from "~/api/stream";
import * as api from "~/api/mercury";
import { ApiError, http } from "~/api/client";
import type { BotActivityEvent, ChatMessage, CodeMode, PendingPrompt } from "~/api/types";
import { useBots, useChat, useRuntimeState, type AgentState } from "./store";
import { conversations, useCodeSessions, type ConversationStore, type Surface } from "./conversation";
import type { ArtifactRef } from "~/api/artifacts";
import { useNotify } from "./notify/store";

export function useRuntimeEvents(enabled: boolean): void {
  const chatId = conversations.chat((s) => s.activeId);
  const codeId = conversations.code((s) => s.activeId);

  useSurfaceStream(enabled, "chat", chatId, true);
  useSurfaceStream(enabled, "code", codeId, false);

  useEffect(() => {
    if (!enabled) return;
    const stream = openStream("/api/bots/events", {
      onEvent: (event, raw) => {
        if (event !== "bot_activity") return;
        const ev = safeJson<BotActivityEvent>(raw);
        if (!ev || ev.kind === "thinking") return;
        useBots.getState().setActivity(ev.botId, ev.kind === "turn-end" ? null : ev.label);
        if (ev.kind === "turn-end" || ev.kind === "turn-start") void refreshBots();
      },
    });
    return () => stream.close();
  }, [enabled]);

  // The chrome (rail, status bar) shows one agent state: the busiest surface.
  useEffect(() => {
    const rank: Record<AgentState, number> = { "needs-you": 5, working: 4, streaming: 3, thinking: 2, idle: 1, offline: 0 };
    const sync = () => {
      if (!useRuntimeState.getState().connected) return;
      const a = conversations.chat.getState();
      const b = conversations.code.getState();
      const top = rank[a.agent] >= rank[b.agent] ? a : b;
      useRuntimeState.setState({ agent: top.agent, step: top.step, prompts: [...a.prompts, ...b.prompts] });
    };
    const offA = conversations.chat.subscribe(sync);
    const offB = conversations.code.subscribe(sync);
    return () => { offA(); offB(); };
  }, []);
}

/**
 * One stream per surface. Unscoped (no session yet) the runtime would send
 * every web event; only the chat surface listens unscoped, so a brand-new
 * Code view never shows Chat's traffic.
 */
function useSurfaceStream(enabled: boolean, surface: Surface, sessionId: string | null, tracksConnection: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (!sessionId && surface !== "chat") return;
    const store = conversations[surface];
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const stream = openStream(`/api/chat/events${query}`, {
      onOpen: () => { if (tracksConnection) useRuntimeState.getState().setConnected(true); },
      onClose: (reason) => { if (tracksConnection && reason !== "closed") useRuntimeState.getState().setConnected(false); },
      onEvent: (event, raw) => handleEvent(store, event, raw),
    });
    return () => stream.close();
  }, [enabled, surface, sessionId, tracksConnection]);
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Artifacts that arrived before their reply did: attached when it lands. */
const pendingArtifacts = new WeakMap<ConversationStore, ArtifactRef[]>();

export function handleEvent(store: ConversationStore, event: string, raw: string): void {
  const conv = store.getState();
  const data = safeJson<Record<string, unknown>>(raw) ?? {};
  // A scoped stream may still carry another session's events on old runtimes.
  const eventSession = typeof data.sessionId === "string" ? data.sessionId : null;
  if (eventSession && conv.activeId && eventSession !== conv.activeId) return;
  switch (event) {
    case "connected":
    case "provider":
      useRuntimeState.getState().setProvider(String(data.provider ?? ""), String(data.model ?? ""));
      break;
    case "thinking":
      conv.setAgent("thinking");
      conv.setLive((l) => l);
      break;
    case "plan": {
      const steps = Array.isArray(data.steps) ? (data.steps as Array<{ label: string; status: "pending" | "active" | "done" }>) : [];
      if (steps.length) conv.setPlan({ steps, updatedAt: Number(data.updatedAt) || Date.now() });
      break;
    }
    case "artifacts": {
      const items = Array.isArray(data.items) ? (data.items as ArtifactRef[]) : [];
      if (!items.length) break;
      const last = conv.messages[conv.messages.length - 1];
      const turnOver = conv.agent === "idle" || conv.agent === "needs-you";
      if (turnOver && last?.role === "assistant") {
        conv.setMessages([...conv.messages.slice(0, -1), { ...last, artifacts: [...(last.artifacts ?? []), ...items] }]);
      } else {
        pendingArtifacts.set(store, [...(pendingArtifacts.get(store) ?? []), ...items]);
      }
      break;
    }
    case "reasoning":
      if (data.done === true) break;
      if (typeof data.text === "string" && data.text) conv.setLive((l) => ({ ...l, reasoning: (l.reasoning + data.text).slice(-20_000) }));
      break;
    case "step_start": {
      const tool = String(data.tool ?? "");
      conv.setStep({ total: Number(data.totalSteps ?? 0), current: Number(data.step ?? data.stepNumber ?? 0), tool });
      conv.setAgent("working");
      conv.setLive((l) => ({ ...l, steps: [...l.steps, { id: Number(data.step ?? l.steps.length + 1), tool, label: String(data.label ?? tool), status: "running" as const, startedAt: Date.now() }].slice(-100) }));
      break;
    }
    case "step_done": {
      const tool = String(data.tool ?? "");
      const summary = typeof data.summary === "string" ? data.summary : undefined;
      const failed = !!summary && /^(error|failed|denied|blocked)\b/i.test(summary.trim());
      conv.setStep({ total: Number(data.totalSteps ?? 0), current: Number(data.stepNumber ?? 0), tool });
      conv.setLive((l) => {
        const steps = [...l.steps];
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i].status === "running" && steps[i].tool === tool) { steps[i] = { ...steps[i], status: failed ? "error" : "done", summary, endedAt: Date.now() }; break; }
        }
        return { ...l, steps };
      });
      break;
    }
    case "text_delta":
      conv.setAgent("streaming");
      conv.appendStreaming(String(data.text ?? ""));
      break;
    case "text_done": {
      const text = String(data.fullText ?? data.text ?? raw);
      // The runtime's reply to a stop is its "⏹ Task stopped" note: end the turn as stopped.
      if (isStopNote(text) || (store.getState().stopping && !text.trim())) { finishStopped(store); void refreshThreads(); break; }
      const live = store.getState().live;
      const trace = live && (live.reasoning || live.steps.length) ? { ...live, endedAt: Date.now(), steps: live.steps.map((st) => st.status === "running" ? { ...st, status: "done" as const, endedAt: Date.now() } : st) } : undefined;
      conv.clearStreaming();
      conv.clearLive();
      const artifacts = pendingArtifacts.get(store);
      pendingArtifacts.delete(store);
      conv.addMessage({ id: crypto.randomUUID(), role: "assistant", content: text, timestamp: new Date().toISOString(), ...(trace ? { trace } : {}), ...(artifacts?.length ? { artifacts } : {}) });
      conv.setStep(null);
      store.getState().setAgent(store.getState().prompts.length ? "needs-you" : "idle");
      void refreshThreads();
      break;
    }
    case "permission_request":
      conv.addPrompt(toPrompt("permission", data, String(data.prompt ?? "")));
      break;
    case "permission_continue":
      conv.addPrompt(toPrompt("continue", data, String(data.question ?? "")));
      break;
    case "choice_prompt":
      conv.addPrompt(toPrompt("choice", data, String(data.question ?? "")));
      break;
    case "permission_resolved":
    case "choice_resolved":
      if (typeof data.id === "string") conv.removePrompt(data.id);
      break;
    case "error": {
      const message = typeof data.message === "string" ? data.message : raw || "Something went wrong";
      conv.clearStreaming();
      conv.clearLive();
      conv.setStep(null);
      conv.setAgent("idle");
      conv.addMessage({ id: crypto.randomUUID(), role: "system", content: message, timestamp: new Date().toISOString() });
      conv.setStopping(false);
      break;
    }
    default:
      break;
  }
}

function toPrompt(kind: PendingPrompt["kind"], data: Record<string, unknown>, text: string): PendingPrompt {
  const rawOptions = Array.isArray(data.options) ? data.options : [];
  const options = rawOptions.map((o) => {
    if (typeof o === "string") return { value: o, label: labelFor(o) };
    const obj = o as { value?: string; label?: string };
    return { value: String(obj.value ?? ""), label: String(obj.label ?? obj.value ?? "") };
  });
  return { id: String(data.id ?? crypto.randomUUID()), kind, text, options, targetId: typeof data.targetId === "string" ? data.targetId : undefined, raisedAt: Date.now() };
}

function labelFor(value: string): string {
  switch (value) {
    case "yes": return "Allow";
    case "always": return "Always allow";
    case "no": return "Deny";
    default: return value;
  }
}

export async function refreshThreads(): Promise<void> {
  try {
    const { threads } = await api.chat.threads();
    useChat.getState().setThreads(threads);
    useNotify.getState().keepOnly(new Set(threads.map((t) => t.id)));
  } catch { /* offline: keep what we have */ }
}

/**
 * Save a thread to come back to, or unsave it. Shows at once; puts it back
 * if the runtime says no.
 */
export async function setThreadSaved(threadId: string, saved: boolean): Promise<void> {
  const mark = (savedAt: string | undefined) => {
    const { threads, setThreads } = useChat.getState();
    setThreads(threads.map((t) => (t.id === threadId ? { ...t, savedAt } : t)));
  };
  const before = useChat.getState().threads.find((t) => t.id === threadId)?.savedAt;
  mark(saved ? new Date().toISOString() : undefined);
  try {
    const res = await api.chat.save(threadId, saved);
    mark(res.savedAt ?? undefined);
  } catch (err) {
    mark(before);
    throw err;
  }
}

export async function refreshBots(): Promise<void> {
  try {
    const { bots, available } = await api.bots.list();
    useBots.getState().setBots(bots, available);
  } catch { /* bots unavailable on this runtime */ }
}

export async function openThread(surface: Surface, id: string | null): Promise<void> {
  const store = conversations[surface];
  store.getState().setActive(id);
  store.getState().clearStreaming();
  if (!id) {
    store.getState().setMessages([]);
    return;
  }
  store.getState().setLoading(true);
  useNotify.getState().seen(id);
  // Prompts still waiting here (asked while you were elsewhere, perhaps from a notification).
  void http.get<{ prompts?: Array<Record<string, unknown>> }>(`/api/chat/pending?sessionId=${encodeURIComponent(id)}`)
    .then((r) => {
      if (store.getState().activeId !== id) return;
      for (const p of r.prompts ?? []) {
        const kind = p.type === "choice_prompt" ? "choice" : p.type === "permission_continue" ? "continue" : "permission";
        store.getState().addPrompt(toPrompt(kind, p, String(p.prompt ?? p.question ?? "")));
      }
    })
    .catch(() => { /* older Mercury */ });
  // The plan Mercury was working through in this conversation, if any.
  void http.get<{ plan: { steps: Array<{ label: string; status: "pending" | "active" | "done" }>; updatedAt: number } | null }>(`/api/chat/plan?sessionId=${encodeURIComponent(id)}`)
    .then((r) => { if (store.getState().activeId === id && r.plan?.steps?.length) store.getState().setPlan(r.plan); })
    .catch(() => { /* older Mercury: no plans */ });
  try {
    const thread = await api.chat.thread(id);
    store.getState().setMessages(thread.messages ?? []);
  } catch {
    store.getState().setMessages([]);
  } finally {
    store.getState().setLoading(false);
  }
}

export interface CodeTurn {
  mode: Exclude<CodeMode, "off">;
  folder: string | null;
}

export async function sendMessage(surface: Surface, content: string, attachments: Array<{ name: string; data: string; mime?: string }> = [], code?: CodeTurn): Promise<void> {
  const store = conversations[surface];
  let id = store.getState().activeId;
  if (!id) {
    const thread = await api.chat.createThread(surface === "code" ? `Code · ${content.slice(0, 40)}` : undefined);
    id = thread.id;
    store.getState().setActive(id);
    store.getState().setMessages([]);
    if (surface === "code") useCodeSessions.getState().upsert({ id, folder: code?.folder ?? null, createdAt: new Date().toISOString() });
  }
  const shown = content || `(Attached: ${attachments.map((a) => a.name).join(", ")})`;
  const optimistic: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: shown,
    timestamp: new Date().toISOString(),
    ...(attachments.length
      ? { attachments: attachments.map((a) => ({ name: a.name, kind: a.mime?.startsWith("image/") ? "image" : "document", mime: a.mime, src: a.mime?.startsWith("image/") ? `data:${a.mime};base64,${a.data}` : undefined })) }
      : {}),
  };
  store.getState().addMessage(optimistic);
  store.getState().setAgent("thinking");
  store.getState().setLive(() => ({ reasoning: "", steps: [], startedAt: Date.now() }));
  await api.chat.send(content, id, attachments.map(({ name, data }) => ({ name, data })), code ? { programming: code.mode, cwd: code.folder ?? undefined } : undefined);
  void refreshThreads();
}

/** The note the runtime sends back when a turn is stopped (agent.ts, "⏹ Task stopped. …"). */
export function isStopNote(text: string): boolean {
  return /^\s*⏹\s*Task (stopped|halted)\b/.test(text);
}

/**
 * Stop button. Marks what was running as stopped straight away (so the
 * screen never claims a step finished), asks the runtime to stop, and ends
 * the turn when its confirmation arrives, or after a few seconds if it
 * never does (an older runtime, or the turn ended on its own meanwhile).
 */
export async function stopTurn(store: ConversationStore): Promise<void> {
  const s = store.getState();
  if (s.stopping) return;
  s.setStopping(true);
  if (s.live) s.setLive((l) => ({ ...l, steps: l.steps.map((st) => (st.status === "running" ? { ...st, status: "stopped" as const, endedAt: Date.now() } : st)) }));
  try {
    await api.chat.stop();
  } catch (err) {
    store.getState().setStopping(false);
    throw err;
  }
  setTimeout(() => { if (store.getState().stopping) finishStopped(store); }, 8000);
}

/** Is Mercury working on this conversation right now (or still stopping)? */
export function turnRunning(store: ConversationStore): boolean {
  const s = store.getState();
  return s.stopping || !!s.streaming || (s.agent !== "idle" && s.agent !== "offline");
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Undo your last message: stop the turn if it's running (and wait for it
 * to end), take the message and Mercury's reply out of the conversation
 * (the runtime forgets them too), and put your text back in the box.
 */
export async function undoLast(store: ConversationStore, message: ChatMessage): Promise<void> {
  const threadId = store.getState().activeId;
  if (!threadId) throw new Error("No conversation is open.");
  if (turnRunning(store)) {
    await stopTurn(store);
    for (let waited = 0; turnRunning(store) && waited < 12_000; waited += 150) await pause(150);
  }
  // The runtime may still be writing the stopped turn: give it a moment.
  let result: Awaited<ReturnType<typeof api.chat.undo>> | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await api.chat.undo(threadId, message.content);
      break;
    } catch (err) {
      const busy = err instanceof ApiError && err.status === 409 && err.data.busy === true;
      if (!busy || attempt >= 25) throw err;
      await pause(400);
    }
  }
  const s = store.getState();
  if (s.activeId !== threadId) return;
  const at = s.messages.findIndex((m) => m.id === message.id);
  s.setMessages(at >= 0 ? s.messages.slice(0, at) : s.messages);
  s.setDraft(result.content);
}

/** End the current turn as stopped: keep the partial answer, mark the trace, say so. */
function finishStopped(store: ConversationStore): void {
  const s = store.getState();
  const partial = s.streaming;
  const live = s.live;
  const now = Date.now();
  const busy = s.agent === "thinking" || s.agent === "working" || s.agent === "streaming";
  s.clearStreaming();
  s.clearLive();
  s.setStep(null);
  s.setStopping(false);
  // Nothing was running any more (the answer finished first): nothing to mark.
  if (!busy && !partial && !live) return;
  const trace = live && (live.reasoning || live.steps.length)
    ? { ...live, stopped: true, endedAt: now, steps: live.steps.map((st) => (st.status === "running" ? { ...st, status: "stopped" as const, endedAt: now } : st)) }
    : undefined;
  s.addMessage({ id: crypto.randomUUID(), role: "assistant", content: partial, stopped: true, timestamp: new Date().toISOString(), ...(trace ? { trace } : {}) });
  s.setAgent(s.prompts.length ? "needs-you" : "idle");
}

export async function answerPrompt(store: ConversationStore, prompt: PendingPrompt, value: string | null): Promise<void> {
  await api.chat.answer(prompt.id, value ?? "", prompt.targetId);
  store.getState().removePrompt(prompt.id);
}
