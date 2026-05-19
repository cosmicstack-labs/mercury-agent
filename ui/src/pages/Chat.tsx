import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
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
import { MessageBubble as MessageBubbleComponent } from "@/components/chat/MessageBubble";
import { StreamingMessage } from "@/components/chat/StreamingMessage";

// ─── Hooks ───────────────────────────────────────────────────

function useThreads() {
  const setThreads = useChatStore((s) => s.setThreads);
  const threads = useChatStore((s) => s.threads);
  const threadVersion = useChatStore((s) => s.threadVersion);
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
  }, [load, threadVersion]);

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

// ─── Slash Commands ──────────────────────────────────────────

interface SlashCommand {
  command: string;
  description: string;
  category: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/help", description: "Show all available commands", category: "General" },
  { command: "/progress", description: "Show current task progress", category: "General" },
  { command: "/halt", description: "Stop all sub-agents", category: "General" },
  { command: "/stop", description: "Stop all agents and clear tasks", category: "General" },
  { command: "/agents", description: "List active sub-agents and status", category: "Agents" },
  { command: "/agents kill", description: "Kill a specific sub-agent", category: "Agents" },
  { command: "/bg", description: "Run a shell command in background", category: "Background" },
  { command: "/bg:", description: "Delegate an LLM task to background", category: "Background" },
  { command: "/bg list", description: "Show all background tasks", category: "Background" },
  { command: "/bg current", description: "Move active task to background", category: "Background" },
  { command: "/bg stop", description: "Stop a background task", category: "Background" },
  { command: "/bg killall", description: "Stop all background tasks", category: "Background" },
  { command: "/bg clear", description: "Prune completed background tasks", category: "Background" },
  { command: "/models", description: "List available models", category: "Models" },
  { command: "/models use", description: "Switch to a different model", category: "Models" },
  { command: "/code", description: "Toggle programming mode", category: "Code" },
  { command: "/code plan", description: "Set plan-only mode", category: "Code" },
  { command: "/code execute", description: "Set execute mode", category: "Code" },
  { command: "/code off", description: "Disable programming mode", category: "Code" },
  { command: "/spotify", description: "Spotify status and controls", category: "Spotify" },
  { command: "/spotify play", description: "Play or search for music", category: "Spotify" },
  { command: "/spotify pause", description: "Pause playback", category: "Spotify" },
  { command: "/spotify next", description: "Skip to next track", category: "Spotify" },
  { command: "/spotify prev", description: "Previous track", category: "Spotify" },
  { command: "/spotify queue", description: "Show play queue", category: "Spotify" },
  { command: "/budget", description: "Show token budget status", category: "Budget" },
  { command: "/budget override", description: "Override budget for next request", category: "Budget" },
  { command: "/budget reset", description: "Reset daily usage counter", category: "Budget" },
  { command: "/budget set", description: "Set new daily budget limit", category: "Budget" },
  { command: "/memory", description: "Manage second-brain memory", category: "Memory" },
  { command: "/permissions", description: "Toggle permission mode", category: "General" },
  { command: "/ws", description: "Workspace file operations", category: "Workspace" },
  { command: "/exit", description: "Shutdown Mercury", category: "General" },
];

function SlashCommandMenu({
  filter,
  selectedIndex,
  onSelect,
}: {
  filter: string;
  selectedIndex: number;
  onSelect: (cmd: string) => void;
}) {
  const filtered = SLASH_COMMANDS.filter((c) =>
    c.command.startsWith(filter.toLowerCase())
  );

  if (filtered.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.15 }}
      className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover shadow-xl"
    >
      <div className="p-1">
        {filtered.map((cmd, i) => (
          <button
            key={cmd.command}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd.command);
            }}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              i === selectedIndex
                ? "bg-primary/10 text-primary"
                : "text-foreground hover:bg-muted"
            )}
          >
            <span className="font-mono font-medium text-xs shrink-0">
              {cmd.command}
            </span>
            <span className="text-muted-foreground text-xs truncate">
              {cmd.description}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">
              {cmd.category}
            </span>
          </button>
        ))}
      </div>
    </motion.div>
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
  const [showSlash, setShowSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Compute filtered commands for index bounds
  const slashFilter = showSlash ? text.split("\n")[0] : "";
  const filteredCommands = SLASH_COMMANDS.filter((c) =>
    c.command.startsWith(slashFilter.toLowerCase())
  );

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setShowSlash(false);
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function selectSlashCommand(cmd: string) {
    // If the command typically takes arguments, add a trailing space
    const needsArg = ["/bg", "/bg:", "/bg stop", "/models use", "/agents kill", "/spotify play", "/budget set"].includes(cmd);
    setText(needsArg ? cmd + " " : cmd);
    setShowSlash(false);
    setSlashIndex(0);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (showSlash && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectSlashCommand(filteredCommands[slashIndex].command);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSlash(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleChange(value: string) {
    setText(value);

    // Show slash menu when text starts with / and is a single line of just the command
    const firstLine = value.split("\n")[0];
    if (firstLine.startsWith("/") && !firstLine.includes(" ")) {
      setShowSlash(true);
      setSlashIndex(0);
    } else if (firstLine.startsWith("/") && firstLine.split(" ").length <= 2) {
      // Allow filtering for two-word commands like "/bg list"
      setShowSlash(true);
      setSlashIndex(0);
    } else {
      setShowSlash(false);
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
          <AnimatePresence>
            {showSlash && filteredCommands.length > 0 && (
              <SlashCommandMenu
                filter={slashFilter}
                selectedIndex={slashIndex}
                onSelect={selectSlashCommand}
              />
            )}
          </AnimatePresence>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              handleChange(e.target.value);
              handleInput();
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // Delay to allow click on menu item
              setTimeout(() => setShowSlash(false), 200);
            }}
            placeholder="Send a message... (type / for commands)"
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
  const { threadId: urlThreadId } = useParams<{ threadId?: string }>();
  const navigate = useNavigate();
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
  const bumpThreadVersion = useChatStore((s) => s.bumpThreadVersion);

  // Sync URL param → active thread
  useEffect(() => {
    if (urlThreadId && urlThreadId !== activeThreadId) {
      setActiveThread(urlThreadId);
    }
  }, [urlThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (thread.messages && thread.messages.length > 0) {
          thread.messages.forEach((m) => addMessage(m));
        }
      } catch {
        // Thread doesn't exist yet (new thread) — just clear
        clearMessages();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  async function handleSend(content: string) {
    // Ensure we have a thread ID — create one if needed
    let threadId = activeThreadId;
    if (!threadId) {
      threadId = `web:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setActiveThread(threadId);
    }

    // Optimistic user message
    addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    });

    // Immediately show waiting state
    setWaiting(true);

    // Persist user message to backend thread
    api.chat.threads.addMessage(threadId, "user", content)
      .then(() => bumpThreadVersion())
      .catch(() => {});

    try {
      await api.chat.send(content, threadId);
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
    const newId = `web:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setActiveThread(newId);
    clearMessages();
    reloadThreads();
    navigate(`/chat/${newId}`);
  }

  function handleSelectThread(id: string) {
    setActiveThread(id);
    navigate(`/chat/${id}`);
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
      <div
        className={cn(
          "hidden h-full shrink-0 border-r border-border bg-background transition-[width] duration-200 ease-in-out md:block overflow-hidden",
          sidebarOpen ? "w-[240px]" : "w-0 border-r-0"
        )}
      >
        <div className="h-full w-[240px]">
          <ThreadList
            threads={threads}
            activeThreadId={activeThreadId}
            onSelect={handleSelectThread}
            onDelete={handleDeleteThread}
            onNew={handleNewThread}
            onExport={handleExportThread}
          />
        </div>
      </div>

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
                  handleSelectThread(id);
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
                  {messages.map((msg) => {
                    // Permission prompt detection for system messages
                    if (msg.role === "system") {
                      try {
                        const parsed = JSON.parse(msg.content);
                        if (parsed.id && (parsed.tool || parsed.description)) {
                          return <PermissionPrompt key={msg.id} data={parsed} />;
                        }
                      } catch {
                        // not a permission prompt, render as regular message
                      }
                    }
                    return <MessageBubbleComponent key={msg.id} message={msg} />;
                  })}
                  {isStreaming && streamingText && (
                    <StreamingMessage text={streamingText} />
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
