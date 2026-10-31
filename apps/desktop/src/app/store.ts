/* ═══════════════════════════════════════════════════════════════
   App state. Views are all mounted at once and switched by `view`, so
   moving between Chat, Code, Bots, Plugins and Skills is a state change,
   never a page load.
   ═══════════════════════════════════════════════════════════════ */

import { create } from "zustand";
import type { BotStatus, ChatThread, PendingPrompt } from "~/api/types";

export type View = "chat" | "artifacts" | "code" | "bots" | "brain" | "plugins" | "skills" | "settings";

/** What the agent is doing right now; drives the StateOrb everywhere. */
export type AgentState = "idle" | "thinking" | "streaming" | "working" | "needs-you" | "offline";

interface UiState {
  view: View;
  setView(view: View): void;
  /** Chat is showing the live Optimus voice session instead of a thread. */
  voiceOpen: boolean;
  setVoiceOpen(open: boolean): void;
  sidebar: boolean;
  toggleSidebar(): void;
  /** A Settings section to open next (e.g. "models" from the Cloud banner); Settings consumes it. */
  settingsSection: string | null;
  openSettings(section: string): void;
  clearSettingsSection(): void;
  /** A plugin whose linking panel Plugins should open (e.g. WhatsApp from Settings → Channels). */
  pluginFocus: string | null;
  openPlugin(id: string): void;
  clearPluginFocus(): void;
}

export const useUi = create<UiState>((set) => ({
  view: "chat",
  setView: (view) => set({ view }),
  voiceOpen: false,
  setVoiceOpen: (voiceOpen) => set({ voiceOpen }),
  sidebar: true,
  toggleSidebar: () => set((s) => ({ sidebar: !s.sidebar })),
  settingsSection: null,
  openSettings: (section) => set({ view: "settings", settingsSection: section }),
  clearSettingsSection: () => set({ settingsSection: null }),
  pluginFocus: null,
  openPlugin: (id) => set({ view: "plugins", pluginFocus: id }),
  clearPluginFocus: () => set({ pluginFocus: null }),
}));

interface RuntimeState {
  connected: boolean;
  agent: AgentState;
  provider: string;
  model: string;
  step: { total: number; current: number; tool: string } | null;
  prompts: PendingPrompt[];
  setConnected(connected: boolean): void;
  setAgent(agent: AgentState): void;
  setProvider(provider: string, model: string): void;
  setStep(step: RuntimeState["step"]): void;
  addPrompt(prompt: PendingPrompt): void;
  removePrompt(id: string): void;
}

export const useRuntimeState = create<RuntimeState>((set, get) => ({
  connected: false,
  agent: "offline",
  provider: "",
  model: "",
  step: null,
  prompts: [],
  setConnected: (connected) => set({ connected, agent: connected ? (get().agent === "offline" ? "idle" : get().agent) : "offline" }),
  setAgent: (agent) => set({ agent }),
  setProvider: (provider, model) => set({ provider, model }),
  setStep: (step) => set({ step }),
  addPrompt: (prompt) => set((s) => ({ prompts: [...s.prompts.filter((p) => p.id !== prompt.id), prompt], agent: "needs-you" })),
  removePrompt: (id) => set((s) => {
    const prompts = s.prompts.filter((p) => p.id !== id);
    return { prompts, agent: prompts.length === 0 && s.agent === "needs-you" ? "working" : s.agent };
  }),
}));

interface ThreadsState {
  /** Every session the runtime has; each surface filters its own. */
  threads: ChatThread[];
  setThreads(threads: ChatThread[]): void;
}

export const useChat = create<ThreadsState>((set) => ({
  threads: [],
  setThreads: (threads) => set({ threads }),
}));

interface BotsState {
  bots: BotStatus[];
  available: boolean;
  activity: Record<string, string>;
  setBots(bots: BotStatus[], available: boolean): void;
  setActivity(botId: string, label: string | null): void;
}

export const useBots = create<BotsState>((set) => ({
  bots: [],
  available: true,
  activity: {},
  setBots: (bots, available) => set({ bots, available }),
  setActivity: (botId, label) => set((s) => {
    const activity = { ...s.activity };
    if (label === null) delete activity[botId];
    else activity[botId] = label;
    return { activity };
  }),
}));
