import { create } from "zustand";
import type { ChatMessage, ChatThread, ChatSettings } from "@/lib/api";

export interface ChatState {
  // Messages
  messages: ChatMessage[];
  streamingText: string;
  isStreaming: boolean;
  waiting: boolean;

  // Threads
  threads: ChatThread[];
  activeThreadId: string | null;

  // Provider info
  provider: string;
  model: string;

  // Tool execution
  totalSteps: number;
  completedSteps: number;
  currentStepTool: string;

  // Settings
  settings: ChatSettings | null;

  // Actions
  addMessage: (msg: ChatMessage) => void;
  updateLastAssistantMessage: (content: string) => void;
  appendStreamingText: (text: string) => void;
  clearStreaming: () => void;
  setStreaming: (streaming: boolean) => void;
  setWaiting: (waiting: boolean) => void;
  setThreads: (threads: ChatThread[]) => void;
  setActiveThread: (id: string | null) => void;
  setProvider: (provider: string) => void;
  setModel: (model: string) => void;
  setSteps: (total: number, completed: number, tool: string) => void;
  resetSteps: () => void;
  setSettings: (settings: ChatSettings) => void;
  clearMessages: () => void;
  threadVersion: number;
  bumpThreadVersion: () => void;
}

const STORAGE_KEY = "mercury-chat-active-thread";

function getStoredThreadId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  streamingText: "",
  isStreaming: false,
  waiting: false,

  threads: [],
  activeThreadId: getStoredThreadId(),

  provider: "",
  model: "",

  totalSteps: 0,
  completedSteps: 0,
  currentStepTool: "",

  settings: null,

  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  updateLastAssistantMessage: (content) =>
    set((state) => {
      const msgs = [...state.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          msgs[i] = { ...msgs[i], content };
          break;
        }
      }
      return { messages: msgs };
    }),

  appendStreamingText: (text) =>
    set((state) => ({
      streamingText: state.streamingText + text,
      isStreaming: true,
    })),

  clearStreaming: () => set({ streamingText: "", isStreaming: false }),

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  setWaiting: (waiting) => set({ waiting }),

  setThreads: (threads) => set({ threads }),

  setActiveThread: (id) => {
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    set({ activeThreadId: id });
  },

  setProvider: (provider) => set({ provider }),

  setModel: (model) => set({ model }),

  setSteps: (total, completed, tool) =>
    set({ totalSteps: total, completedSteps: completed, currentStepTool: tool }),

  resetSteps: () =>
    set({ totalSteps: 0, completedSteps: 0, currentStepTool: "" }),

  setSettings: (settings) => set({ settings }),

  clearMessages: () => set({ messages: [], streamingText: "", isStreaming: false }),

  threadVersion: 0,
  bumpThreadVersion: () => set((state) => ({ threadVersion: state.threadVersion + 1 })),
}));
