import { useCallback } from "react";
import { useChatStore } from "@/stores/chat";
import * as api from "@/lib/api";
import type { ChatThread } from "@/lib/api";

export function useThreads() {
  const threads = useChatStore((s) => s.threads);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const setThreads = useChatStore((s) => s.setThreads);
  const setActiveThread = useChatStore((s) => s.setActiveThread);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const addMessage = useChatStore((s) => s.addMessage);

  const loadThreads = useCallback(async () => {
    const res = await api.chat.threads.list();
    setThreads(res.threads);
  }, [setThreads]);

  const loadThread = useCallback(
    async (id: string) => {
      const thread: ChatThread = await api.chat.threads.get(id);
      clearMessages();
      if (thread.messages) {
        for (const msg of thread.messages) {
          addMessage(msg);
        }
      }
      setActiveThread(id);
    },
    [clearMessages, addMessage, setActiveThread]
  );

  const switchThread = useCallback(
    (id: string) => {
      setActiveThread(id);
      loadThread(id);
    },
    [setActiveThread, loadThread]
  );

  const deleteThread = useCallback(
    async (id: string) => {
      await api.chat.threads.delete(id);
      setThreads(
        useChatStore.getState().threads.filter((t) => t.id !== id)
      );
      if (useChatStore.getState().activeThreadId === id) {
        setActiveThread(null);
        clearMessages();
      }
    },
    [setThreads, setActiveThread, clearMessages]
  );

  const exportThread = useCallback((id: string) => {
    const thread = useChatStore
      .getState()
      .threads.find((t) => t.id === id);
    if (!thread) return;

    const blob = new Blob([JSON.stringify(thread, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mercury-thread-${id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const startNewThread = useCallback(() => {
    clearMessages();
    setActiveThread(null);
  }, [clearMessages, setActiveThread]);

  return {
    threads,
    activeThreadId,
    loadThreads,
    loadThread,
    switchThread,
    deleteThread,
    exportThread,
    startNewThread,
  };
}
