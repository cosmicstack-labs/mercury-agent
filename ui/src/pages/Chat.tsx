import { useState, useEffect, useRef, useCallback } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  FolderOpen,
  Settings,
  ArrowDown,
  Send,
  Loader2,
  MessageSquare,
  Check,
  X,
  Zap,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { useChatStore } from "@/stores/chat";
import { useSSE } from "@/hooks/useSSE";
import api from "@/lib/api";
import type { ChatMessage, ChatThread } from "@/lib/api";

import { ThreadList } from "@/components/chat/ThreadList";
import { WorkspacePanel } from "@/components/chat/WorkspacePanel";
import { ModelSwitcher } from "@/components/chat/ModelSwitcher";
import { CodeModeToggle } from "@/components/chat/CodeModeToggle";

// ─── Hooks ───────────────────────────────────────────────────

function useThreads() {
  const setThreads = useChatStore((s) => s.setThreads);
  const threads = useChatStore((s) => s.threads);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api.chat.threads.list();
      setThreads(data.threads);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [setThreads]);

  useEffect(() => {
    load();
  }, [load]);

  return { threads, loading, reload: load };
}

function useAutoScroll(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const userScrolledUp = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      userScrolledUp.current = false;
      setAtBottom(true);
    }
  }, []);

  useEffect(() => {
    if (!userScrolledUp.current) {
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 80;
    const isAtBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setAtBottom(isAtBottom);
    if (!isAtBottom) {
      userScrolledUp.current = true;
    } else {
      userScrolledUp.current = false;
    }
  }, []);

  return { containerRef, atBottom, scrollToBottom, handleScroll };
}

// ─── Sub-components ──────────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  // Permission prompt detection
  let permData: {
    id: string;
    tool?: string;
    description?: string;
  } | null = null;
  if (isSystem) {
    try {
      const parsed = JSON.parse(message.content);
      if (parsed.id && (parsed.tool || parsed.description)) {
        permData = parsed;
      }
    } catch {
      // not a permission prompt, render as text
    }
  }

  if (permData) {
    return <PermissionPrompt data={permData} />;
  }

  return (
    <div
      className={cn(
        "flex w-full",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : isSystem
              ? "bg-destructive/10 text-destructive border border-destructive/20"
              : "bg-muted text-foreground"
        )}
      >
        <div className="whitespace-pre-wrap break-words">
          {message.content}
        </div>
        {message.steps && message.steps.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.steps.map((step, i) => (
              <span
                key={i}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                  step.status === "done"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : step.status === "error"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-primary/10 text-primary"
                )}
              >
                {step.status === "running" && (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                )}
                {step.tool}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed text-foreground">
        <div className="whitespace-pre-wrap break-words">{text}</div>
        <span className="inline-block h-4 w-1 animate-pulse bg-primary ml-0.5" />
      </div>
    </div>
  );
}

function WaitingIndicator() {
  return (
    <div className="flex w-full justify-start">
      <div className="flex items-center gap-2 rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        Thinking...
      </div>
    </div>
  );
}

function PermissionPrompt({
  data,
}: {
  data: { id: string; tool?: string; description?: string };
}) {
  const [resolving, setResolving] = useState(false);

  async function handle(action: string) {
    setResolving(true);
    try {
      await api.chat.permission(data.id, action);
    } catch {
      // ignore
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[85%] rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
          <Zap className="h-4 w-4" />
          Permission Required
        </div>
        {data.tool && (
          <p className="mt-1 text-xs text-muted-foreground">
            Tool: <span className="font-medium text-foreground">{data.tool}</span>
          </p>
        )}
        {data.description && (
          <p className="mt-1 text-sm text-foreground">{data.description}</p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={resolving}
            onClick={() => handle("allow")}
          >
            {resolving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            Allow
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            disabled={resolving}
            onClick={() => handle("deny")}
          >
            <X className="h-3 w-3" />
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatInput({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleInput() {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }

  return (
    <div className="border-t border-border bg-background/80 backdrop-blur-xl px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              handleInput();
            }}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            rows={1}
            className={cn(
              "w-full resize-none rounded-xl border border-border bg-muted/40 px-4 py-3 pr-12 text-sm text-foreground placeholder:text-muted-foreground",
              "focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40",
              "transition-all duration-150"
            )}
            style={{ maxHeight: 200 }}
          />
        </div>
        <Button
          size="icon"
          disabled={disabled || !text.trim()}
          onClick={handleSubmit}
          className="h-10 w-10 shrink-0 rounded-xl"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────

export function ChatPage() {
  const { connected } = useSSE();
  const { threads, loading: threadsLoading, reload: reloadThreads } = useThreads();

  // Store state
  const messages = useChatStore((s) => s.messages);
  const streamingText = useChatStore((s) => s.streamingText);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const waiting = useChatStore((s) => s.waiting);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const provider = useChatStore((s) => s.provider);
  const model = useChatStore((s) => s.model);
  const totalSteps = useChatStore((s) => s.totalSteps);
  const completedSteps = useChatStore((s) => s.completedSteps);
  const currentStepTool = useChatStore((s) => s.currentStepTool);
  const setActiveThread = useChatStore((s) => s.setActiveThread);
  const addMessage = useChatStore((s) => s.addMessage);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setWaiting = useChatStore((s) => s.setWaiting);
  const clearStreaming = useChatStore((s) => s.clearStreaming);
  const resetSteps = useChatStore((s) => s.resetSteps);

  // Panel state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  // Auto-scroll
  const { containerRef, atBottom, scrollToBottom, handleScroll } =
    useAutoScroll([messages, streamingText, waiting]);

  // Load thread messages when switching
  useEffect(() => {
    if (!activeThreadId) {
      clearMessages();
      return;
    }
    (async () => {
      try {
        const thread = await api.chat.threads.get(activeThreadId);
        clearMessages();
        thread.messages.forEach((m) => addMessage(m));
      } catch {
        // thread may not exist anymore
        clearMessages();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  async function handleSend(content: string) {
    // Optimistic user message
    addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    });

    try {
      await api.chat.send(content, activeThreadId ?? undefined);
      // Reload threads in background to pick up new thread
      reloadThreads();
    } catch {
      setWaiting(false);
      clearStreaming();
      resetSteps();
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: "Failed to send message. Please try again.",
        timestamp: new Date().toISOString(),
      });
    }
  }

  async function handleDeleteThread(id: string) {
    try {
      await api.chat.threads.delete(id);
      if (activeThreadId === id) {
        setActiveThread(null);
        clearMessages();
      }
      reloadThreads();
    } catch {
      // ignore
    }
  }

  function handleNewThread() {
    setActiveThread(null);
    clearMessages();
  }

  function handleExportThread(id: string) {
    const thread = threads.find((t) => t.id === id);
    if (!thread) return;
    const content = thread.messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n---\n\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${thread.title || "conversation"}-${id.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const isBusy = isStreaming || waiting;
  const hasSteps = totalSteps > 0;
  const stepProgress =
    totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* ── Thread Sidebar (desktop) ── */}
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 240, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="hidden h-full shrink-0 overflow-hidden border-r border-border bg-background md:block"
          >
            <div className="h-full w-[240px]">
              <ThreadList
                threads={threads}
                activeThreadId={activeThreadId}
                onSelect={setActiveThread}
                onDelete={handleDeleteThread}
                onNew={handleNewThread}
                onExport={handleExportThread}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Mobile sidebar overlay ── */}
      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
              onClick={() => setSidebarOpen(false)}
            />
            <motion.div
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="fixed inset-y-0 left-0 z-50 w-[260px] bg-background shadow-xl md:hidden"
            >
              <ThreadList
                threads={threads}
                activeThreadId={activeThreadId}
                onSelect={(id) => {
                  setActiveThread(id);
                  setSidebarOpen(false);
                }}
                onDelete={handleDeleteThread}
                onNew={() => {
                  handleNewThread();
                  setSidebarOpen(false);
                }}
                onExport={handleExportThread}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Main Chat Area ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex h-12 items-center gap-2 border-b border-border bg-background/80 backdrop-blur-xl px-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeftOpen className="h-4 w-4" />
            )}
          </Button>

          {/* Logo */}
          <span className="hidden text-sm font-bold mercury-gradient-text sm:inline">
            Mercury
          </span>

          <div className="mx-1 h-4 w-px bg-border" />

          <ModelSwitcher currentProvider={provider} currentModel={model} />

          <div className="flex-1" />

          <CodeModeToggle />

          {/* Connection indicator */}
          <div
            className={cn(
              "h-2 w-2 rounded-full",
              connected ? "bg-emerald-500" : "bg-destructive"
            )}
            title={connected ? "Connected" : "Disconnected"}
          />

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setWorkspaceOpen(!workspaceOpen)}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hidden md:inline-flex"
            onClick={() => (window.location.href = "/settings")}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </header>

        {/* Messages */}
        <div className="relative flex-1 min-h-0">
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto"
          >
            <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
              {threadsLoading && messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : messages.length === 0 && !isStreaming && !waiting ? (
                <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
                  <div className="rounded-2xl bg-primary/10 p-4">
                    <MessageSquare className="h-8 w-8 text-primary" />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground">
                    Start a conversation
                  </h3>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    Send a message to begin. Mercury is ready to assist you.
                  </p>
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <MessageBubble key={msg.id} message={msg} />
                  ))}
                  {isStreaming && streamingText && (
                    <StreamingBubble text={streamingText} />
                  )}
                  {waiting && !isStreaming && <WaitingIndicator />}
                </>
              )}
            </div>
          </div>

          {/* Scroll-to-bottom */}
          <AnimatePresence>
            {!atBottom && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="absolute bottom-4 right-4"
              >
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 rounded-full shadow-lg border-border bg-background/90 backdrop-blur-sm"
                  onClick={scrollToBottom}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Step progress */}
        {hasSteps && (
          <div className="px-4 py-1.5">
            <div className="mx-auto max-w-3xl">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
                <span>
                  Step {completedSteps} of {totalSteps}
                  {currentStepTool && (
                    <span className="ml-1 text-foreground font-medium">
                      — {currentStepTool}
                    </span>
                  )}
                </span>
              </div>
              <Progress value={stepProgress} className="h-1" />
            </div>
          </div>
        )}

        {/* Chat input */}
        <ChatInput onSend={handleSend} disabled={isBusy} />
      </div>

      {/* ── Workspace Panel ── */}
      <AnimatePresence mode="wait">
        {workspaceOpen && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 320, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="hidden h-full shrink-0 overflow-hidden md:block"
          >
            <div className="h-full w-[320px]">
              <WorkspacePanel
                open={workspaceOpen}
                onClose={() => setWorkspaceOpen(false)}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
