/* ═══════════════════════════════════════════════════════════════
   A conversation surface: Chat and Code each have their own. Their
   sessions, messages, live stream, agent state and pending approvals are
   separate stores, fed by separate event streams, so nothing one does
   shows up in the other.
   ═══════════════════════════════════════════════════════════════ */

import { createContext, useContext } from "react";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { ChatMessage, PendingPrompt, ThoughtTrace } from "~/api/types";
import type { AgentState } from "./store";

export type Surface = "chat" | "code";

export interface ConversationState {
  surface: Surface;
  activeId: string | null;
  messages: ChatMessage[];
  streaming: string;
  loading: boolean;
  agent: AgentState;
  step: { total: number; current: number; tool: string } | null;
  prompts: PendingPrompt[];
  /** The current turn's thought process, streaming. */
  live: ThoughtTrace | null;
  /** The stop button was pressed and the runtime hasn't confirmed yet. */
  stopping: boolean;
  setStopping(stopping: boolean): void;
  /** Text to put in the box (an undone message); the composer takes it once. */
  draft: string | null;
  setDraft(draft: string | null): void;
  /** The conversation's plan checklist (update_plan), if Mercury made one. */
  plan: { steps: Array<{ label: string; status: "pending" | "active" | "done" }>; updatedAt: number } | null;
  setPlan(plan: ConversationState["plan"]): void;
  setLive(update: (live: ThoughtTrace) => ThoughtTrace): void;
  clearLive(): void;
  setActive(id: string | null): void;
  setMessages(messages: ChatMessage[]): void;
  addMessage(message: ChatMessage): void;
  appendStreaming(text: string): void;
  clearStreaming(): void;
  setLoading(loading: boolean): void;
  setAgent(agent: AgentState): void;
  setStep(step: ConversationState["step"]): void;
  addPrompt(prompt: PendingPrompt): void;
  removePrompt(id: string): void;
}

export type ConversationStore = UseBoundStore<StoreApi<ConversationState>>;

function makeConversation(surface: Surface): ConversationStore {
  return create<ConversationState>((set) => ({
    surface,
    activeId: null,
    messages: [],
    streaming: "",
    loading: false,
    agent: "idle",
    step: null,
    prompts: [],
    live: null,
    stopping: false,
    setStopping: (stopping) => set({ stopping }),
    draft: null,
    setDraft: (draft) => set({ draft }),
    plan: null,
    setPlan: (plan) => set({ plan }),
    setLive: (update) => set((s) => ({ live: update(s.live ?? { reasoning: "", steps: [], startedAt: Date.now() }) })),
    clearLive: () => set({ live: null }),
    setActive: (activeId) => set({ activeId, prompts: [], step: null, agent: "idle", live: null, stopping: false, plan: null }),
    setMessages: (messages) => set({ messages }),
    addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
    appendStreaming: (text) => set((s) => ({ streaming: s.streaming + text })),
    clearStreaming: () => set({ streaming: "" }),
    setLoading: (loading) => set({ loading }),
    setAgent: (agent) => set({ agent }),
    setStep: (step) => set({ step }),
    addPrompt: (prompt) => set((s) => ({ prompts: [...s.prompts.filter((p) => p.id !== prompt.id), prompt], agent: "needs-you" })),
    removePrompt: (id) => set((s) => {
      const prompts = s.prompts.filter((p) => p.id !== id);
      return { prompts, agent: prompts.length === 0 && s.agent === "needs-you" ? "working" : s.agent };
    }),
  }));
}

export const conversations: Record<Surface, ConversationStore> = {
  chat: makeConversation("chat"),
  code: makeConversation("code"),
};

export const ConversationContext = createContext<ConversationStore>(conversations.chat);

/** The conversation of the surface this component is rendered in. */
export function useConversation<T>(selector: (s: ConversationState) => T): T {
  return useContext(ConversationContext)(selector);
}

export function useConversationStore(): ConversationStore {
  return useContext(ConversationContext);
}

/** The list a conversation shows in: Code's (a Code session) or Chat's. */
export function listOf(thread: { id: string; title?: string | null }, codeIds: Set<string>): Surface {
  return codeIds.has(thread.id) || (thread.title ?? "").startsWith("Code · ") ? "code" : "chat";
}

/* ── Code sessions: which runtime sessions belong to Code, and their folder ── */

export interface CodeSession {
  id: string;
  folder: string | null;
  createdAt: string;
}

interface CodeSessionsState {
  scope: string;
  sessions: CodeSession[];
  load(scope: string): void;
  upsert(session: CodeSession): void;
  remove(id: string): void;
}

const keyFor = (scope: string) => `mercury.code.sessions.v1:${scope}`;

export const useCodeSessions = create<CodeSessionsState>((set, get) => ({
  scope: "",
  sessions: [],
  load(scope) {
    let sessions: CodeSession[] = [];
    try { sessions = JSON.parse(localStorage.getItem(keyFor(scope)) ?? "[]") as CodeSession[]; } catch { sessions = []; }
    set({ scope, sessions: Array.isArray(sessions) ? sessions : [] });
  },
  upsert(session) {
    const sessions = [session, ...get().sessions.filter((s) => s.id !== session.id)];
    try { localStorage.setItem(keyFor(get().scope), JSON.stringify(sessions)); } catch { /* ignore */ }
    set({ sessions });
  },
  remove(id) {
    const sessions = get().sessions.filter((s) => s.id !== id);
    try { localStorage.setItem(keyFor(get().scope), JSON.stringify(sessions)); } catch { /* ignore */ }
    set({ sessions });
  },
}));
