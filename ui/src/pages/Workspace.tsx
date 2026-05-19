import { useState, useEffect, useRef, useCallback } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  X,
  GitBranch,
  GitCommit as GitCommitIcon,
  GitPullRequest,
  Plus,
  Minus,
  Check,
  Upload,
  Download,
  RefreshCw,
  Terminal as TerminalIcon,
  MessageSquare,
  Send,
  Loader2,
  Circle,
  FileCode,
  FileText,
  FolderTree,
  ArrowUp,
  ArrowDown,
  Search,
  MoreHorizontal,
  Copy,
  Eye,
  Zap,
  Play,
  Sparkles,
  FolderInput,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import api from "@/lib/api";
import type {
  WorkspaceTree,
  WorkspaceFile,
  WorkspaceInfo,
  GitStatus,
  GitFile,
  GitBranch as GitBranchType,
  GitCommit,
  TerminalResult,
} from "@/lib/api";
import { useChatStore } from "@/stores/chat";
import { useSSE } from "@/hooks/useSSE";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

interface OpenTab {
  path: string;
  name: string;
  content: string;
  language: string;
  dirty: boolean;
  originalContent: string;
}

interface TerminalEntry {
  id: string;
  command: string;
  output: string;
  exitCode: number;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".md": "markdown", ".txt": "text", ".css": "css", ".html": "html",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".sql": "sql",
    ".xml": "xml", ".svg": "xml", ".dockerfile": "docker",
    ".env": "text", ".gitignore": "text", ".c": "c", ".cpp": "cpp",
    ".h": "c", ".hpp": "cpp", ".rb": "ruby", ".php": "php",
    ".swift": "swift", ".kt": "kotlin", ".scala": "scala",
    ".lua": "lua", ".r": "r", ".dart": "dart", ".graphql": "graphql",
    ".scss": "scss", ".less": "less", ".vue": "markup",
    ".prisma": "text", ".proto": "protobuf",
  };
  return map[ext.toLowerCase()] || "text";
}

function fileIcon(name: string, isDir: boolean, isOpen?: boolean) {
  if (isDir) {
    return isOpen
      ? <FolderOpen className="h-4 w-4 text-mercury-400" />
      : <Folder className="h-4 w-4 text-mercury-400/70" />;
  }
  const ext = name.includes(".") ? "." + name.split(".").pop()! : "";
  const codeExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".sh"];
  if (codeExts.includes(ext)) return <FileCode className="h-4 w-4 text-blue-400" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}

function statusColor(status: string): string {
  switch (status) {
    case "modified": return "text-amber-400";
    case "added": return "text-emerald-400";
    case "deleted": return "text-red-400";
    case "untracked": return "text-gray-400";
    case "renamed": return "text-purple-400";
    default: return "text-muted-foreground";
  }
}

function statusIcon(status: string) {
  switch (status) {
    case "modified": return <span className="text-amber-400 text-xs font-bold">M</span>;
    case "added": return <span className="text-emerald-400 text-xs font-bold">A</span>;
    case "deleted": return <span className="text-red-400 text-xs font-bold">D</span>;
    case "untracked": return <span className="text-gray-400 text-xs font-bold">U</span>;
    case "renamed": return <span className="text-purple-400 text-xs font-bold">R</span>;
    default: return <span className="text-muted-foreground text-xs">?</span>;
  }
}

// ═══════════════════════════════════════════════════════════════
//  File Explorer Panel (Left)
// ═══════════════════════════════════════════════════════════════

function FileExplorer({
  onOpenFile,
  openFiles,
}: {
  onOpenFile: (path: string) => void;
  openFiles: string[];
}) {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(["."]));
  const [dirContents, setDirContents] = useState<Map<string, WorkspaceTree>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDir();
  }, []);

  async function loadDir(path?: string) {
    try {
      const data = await api.workspace.tree(path);
      if (!path || path === ".") {
        setTree(data);
        setLoading(false);
      } else {
        setDirContents((prev) => new Map(prev).set(path, data));
      }
    } catch {
      setLoading(false);
    }
  }

  function toggleDir(path: string) {
    const next = new Set(expandedDirs);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!dirContents.has(path)) {
        loadDir(path);
      }
    }
    setExpandedDirs(next);
  }

  function renderItems(items: WorkspaceTree["items"], parentPath: string) {
    return items.map((item) => {
      const fullPath = parentPath === "." ? item.name : `${parentPath}/${item.name}`;
      const isExpanded = expandedDirs.has(fullPath);
      const isOpen = openFiles.includes(fullPath);

      if (item.isDirectory) {
        const subTree = dirContents.get(fullPath);
        return (
          <div key={fullPath}>
            <button
              onClick={() => toggleDir(fullPath)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors",
                "hover:bg-muted/60"
              )}
            >
              {isExpanded
                ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              }
              {fileIcon(item.name, true, isExpanded)}
              <span className="truncate">{item.name}</span>
            </button>
            {isExpanded && subTree && (
              <div className="ml-3 border-l border-border/30 pl-1">
                {renderItems(subTree.items, fullPath)}
              </div>
            )}
          </div>
        );
      }

      return (
        <button
          key={fullPath}
          onClick={() => onOpenFile(fullPath)}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors",
            isOpen
              ? "bg-primary/10 text-primary"
              : "hover:bg-muted/60 text-foreground/80"
          )}
        >
          <span className="w-3" />
          {fileIcon(item.name, false)}
          <span className="truncate">{item.name}</span>
        </button>
      );
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <FolderTree className="h-4 w-4 text-mercury-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Explorer
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadDir()}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
      <ScrollArea className="flex-1 px-1 py-1">
        {tree && renderItems(tree.items, ".")}
      </ScrollArea>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  Editor Tabs Panel (Center)
// ═══════════════════════════════════════════════════════════════

function EditorPanel({
  tabs,
  activeTab,
  onSelectTab,
  onCloseTab,
  onSave,
  onContentChange,
}: {
  tabs: OpenTab[];
  activeTab: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onSave: (path: string) => void;
  onContentChange: (path: string, content: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const current = tabs.find((t) => t.path === activeTab);

  // Handle keyboard shortcuts
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (activeTab) onSave(activeTab);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeTab, onSave]);

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <div className="rounded-2xl bg-primary/10 p-6">
          <FileCode className="h-12 w-12 text-primary/60" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground">No files open</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Select a file from the explorer to start editing
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-0 overflow-x-auto border-b border-border bg-muted/20">
        {tabs.map((tab) => (
          <button
            key={tab.path}
            onClick={() => onSelectTab(tab.path)}
            className={cn(
              "group flex items-center gap-2 border-r border-border/30 px-3 py-1.5 text-[13px] transition-colors",
              tab.path === activeTab
                ? "bg-background text-foreground border-b-2 border-b-primary"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            )}
          >
            {fileIcon(tab.name, false)}
            <span className="max-w-[120px] truncate">{tab.name}</span>
            {tab.dirty && (
              <Circle className="h-2 w-2 fill-primary text-primary" />
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.path); }}
              className="ml-1 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          </button>
        ))}
      </div>

      {/* Editor area */}
      {current && (
        <div className="relative flex flex-col flex-1 min-h-0">
          {/* Info bar */}
          <div className="flex items-center justify-between border-b border-border/30 bg-muted/10 px-3 py-1">
            <span className="text-xs text-muted-foreground font-mono">{current.path}</span>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {current.language}
              </Badge>
              {current.dirty && (
                <Button size="sm" variant="ghost" className="h-5 gap-1 px-2 text-[10px]" onClick={() => onSave(current.path)}>
                  <span className="text-primary">Save</span>
                  <span className="text-muted-foreground">Cmd+S</span>
                </Button>
              )}
            </div>
          </div>

          {/* Code content — syntax highlighted with editable overlay */}
          <div className="flex-1 min-h-0 overflow-auto bg-[#282c34]" ref={scrollRef} onClick={() => textareaRef.current?.focus()}>
            <div className="relative" style={{ minWidth: "fit-content" }}>
              {/* Syntax highlighted layer (visual) */}
              <SyntaxHighlighter
                language={current.language}
                style={oneDark}
                showLineNumbers
                lineNumberStyle={{
                  minWidth: "3em",
                  paddingRight: "1em",
                  color: "rgba(255,255,255,0.25)",
                  fontSize: "13px",
                  lineHeight: "20px",
                  userSelect: "none",
                }}
                customStyle={{
                  margin: 0,
                  padding: "0.5rem 0",
                  background: "transparent",
                  fontSize: "13px",
                  lineHeight: "20px",
                  fontFamily: "var(--font-mono, 'Geist Mono', ui-monospace, monospace)",
                }}
                codeTagProps={{
                  style: {
                    fontSize: "13px",
                    lineHeight: "20px",
                    fontFamily: "var(--font-mono, 'Geist Mono', ui-monospace, monospace)",
                  },
                }}
                wrapLongLines={false}
              >
                {current.content || " "}
              </SyntaxHighlighter>
              {/* Transparent textarea overlay for editing */}
              <textarea
                ref={textareaRef}
                value={current.content}
                onChange={(e) => onContentChange(current.path, e.target.value)}
                spellCheck={false}
                className={cn(
                  "absolute top-0 left-0 w-full h-full resize-none bg-transparent text-transparent caret-white",
                  "font-mono text-[13px] leading-[20px]",
                  "focus:outline-none",
                  "whitespace-pre",
                  "pointer-events-none focus:pointer-events-auto"
                )}
                style={{
                  tabSize: 2,
                  padding: "0.5rem 0 0.5rem 4.5em",
                  fontFamily: "var(--font-mono, 'Geist Mono', ui-monospace, monospace)",
                  overflow: "hidden",
                }}
                onFocus={() => {
                  // Enable pointer events while editing
                  if (textareaRef.current) {
                    textareaRef.current.style.pointerEvents = "auto";
                  }
                }}
                onBlur={() => {
                  // Disable pointer events when not editing so scroll passes through
                  if (textareaRef.current) {
                    textareaRef.current.style.pointerEvents = "none";
                  }
                }}
                onWheel={(e) => {
                  // Forward wheel events to parent scroll container while focused
                  if (scrollRef.current) {
                    scrollRef.current.scrollTop += e.deltaY;
                    scrollRef.current.scrollLeft += e.deltaX;
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  Git Panel (Right)
// ═══════════════════════════════════════════════════════════════

function GitPanel() {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [showBranches, setShowBranches] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const refresh = useCallback(async (showToast: boolean = false) => {
    setRefreshing(true);
    try {
      const [statusData, branchData, logData] = await Promise.all([
        api.git.status(),
        api.git.branches(),
        api.git.log(15),
      ]);
      setGitStatus(statusData);
      setBranches(branchData.branches);
      setCommits(logData.commits);
      if (showToast) {
        setFeedback({ type: "success", msg: "Refreshed" });
        setTimeout(() => setFeedback(null), 1500);
      }
    } catch (err: any) {
      setFeedback({ type: "error", msg: err.message });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function showFeedbackMsg(type: "success" | "error", msg: string) {
    setFeedback({ type, msg });
    setTimeout(() => setFeedback(null), 3000);
  }

  async function handleStage(files: string[]) {
    setActionLoading("stage");
    try {
      await api.git.stage(files);
      await refresh();
    } catch (err: any) {
      showFeedbackMsg("error", err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleUnstage(files: string[]) {
    setActionLoading("unstage");
    try {
      await api.git.unstage(files);
      await refresh();
    } catch (err: any) {
      showFeedbackMsg("error", err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCommit() {
    if (!commitMsg.trim()) return;
    setActionLoading("commit");
    try {
      const result = await api.git.commit(commitMsg.trim());
      setCommitMsg("");
      showFeedbackMsg("success", "Committed successfully");
      await refresh();
    } catch (err: any) {
      showFeedbackMsg("error", err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePush() {
    setActionLoading("push");
    try {
      const result = await api.git.push();
      showFeedbackMsg("success", result.message || "Pushed");
      await refresh();
    } catch (err: any) {
      showFeedbackMsg("error", err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePull() {
    setActionLoading("pull");
    try {
      const result = await api.git.pull();
      showFeedbackMsg("success", result.message || "Pulled");
      await refresh();
    } catch (err: any) {
      showFeedbackMsg("error", err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCheckout(branch: string) {
    setActionLoading("checkout");
    try {
      await api.git.checkout(branch);
      showFeedbackMsg("success", `Switched to ${branch}`);
      setShowBranches(false);
      await refresh();
    } catch (err: any) {
      showFeedbackMsg("error", err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleGenerateMessage() {
    setActionLoading("generate");
    try {
      // Auto-stage all unstaged files first
      const unstaged = gitStatus?.files.filter((f) => !f.staged) || [];
      if (unstaged.length > 0) {
        await api.git.stage(["."]);
        await refresh();
      }
      const result = await api.git.generateCommitMessage();
      const msg = typeof result === "string" ? result : result?.message || "";
      if (msg) {
        setCommitMsg(msg);
        showFeedbackMsg("success", "Message generated");
      } else {
        showFeedbackMsg("error", "No message returned");
      }
    } catch (err: any) {
      showFeedbackMsg("error", err.message);
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  const stagedFiles = gitStatus?.files.filter((f) => f.staged) || [];
  const unstagedFiles = gitStatus?.files.filter((f) => !f.staged) || [];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <GitBranch className="h-4 w-4 text-mercury-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Source Control
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handlePull} disabled={!!actionLoading}>
            <Download className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handlePush} disabled={!!actionLoading}>
            <Upload className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => refresh(true)}
            disabled={!!actionLoading || refreshing}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-3">
          {/* Feedback */}
          <AnimatePresence>
            {feedback && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs",
                  feedback.type === "success"
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                    : "bg-red-500/10 text-red-400 border border-red-500/20"
                )}
              >
                {feedback.msg}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Branch info */}
          <div className="space-y-1">
            <button
              onClick={() => setShowBranches(!showBranches)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60"
            >
              <GitBranch className="h-3.5 w-3.5 text-primary" />
              <span className="font-medium">{gitStatus?.branch || "—"}</span>
              {gitStatus && gitStatus.ahead > 0 && (
                <Badge variant="outline" className="text-[10px] px-1 py-0">
                  <ArrowUp className="h-2.5 w-2.5 mr-0.5" />{gitStatus.ahead}
                </Badge>
              )}
              {gitStatus && gitStatus.behind > 0 && (
                <Badge variant="outline" className="text-[10px] px-1 py-0">
                  <ArrowDown className="h-2.5 w-2.5 mr-0.5" />{gitStatus.behind}
                </Badge>
              )}
              <ChevronRight className={cn("ml-auto h-3 w-3 transition-transform", showBranches && "rotate-90")} />
            </button>

            {/* Branch picker */}
            <AnimatePresence>
              {showBranches && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="ml-2 space-y-0.5 border-l border-border/30 pl-2 py-1">
                    {branches.filter((b) => !b.name.startsWith("remotes/")).map((b) => (
                      <button
                        key={b.name}
                        onClick={() => !b.isCurrent && handleCheckout(b.name)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors",
                          b.isCurrent
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        )}
                        disabled={b.isCurrent || !!actionLoading}
                      >
                        {b.isCurrent && <Check className="h-3 w-3" />}
                        <span className="truncate">{b.name}</span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Commit input */}
          <div className="space-y-1.5">
            <div className="relative">
              <textarea
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                placeholder="Commit message..."
                rows={2}
                className={cn(
                  "w-full resize-none rounded-lg border border-border bg-muted/30 px-3 py-2 pr-9 text-sm text-foreground",
                  "placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
                )}
              />
              {/* Generate button inside textarea */}
              <button
                onClick={handleGenerateMessage}
                disabled={!!actionLoading}
                title="AI generate commit message"
                className={cn(
                  "absolute right-2 top-2 rounded-md p-1.5 transition-colors border border-border/50",
                  "text-primary/70 hover:text-primary hover:bg-primary/10 bg-background/80",
                  actionLoading === "generate" && "animate-pulse"
                )}
              >
                {actionLoading === "generate"
                  ? <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  : <Sparkles className="h-4 w-4" />
                }
              </button>
            </div>
            <Button
              size="sm"
              className="w-full h-7 gap-1.5 text-xs"
              disabled={!commitMsg.trim() || stagedFiles.length === 0 || !!actionLoading}
              onClick={handleCommit}
            >
              {actionLoading === "commit"
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <Check className="h-3 w-3" />
              }
              Commit ({stagedFiles.length} staged)
            </Button>
          </div>

          {/* Staged Changes */}
          {stagedFiles.length > 0 && (
            <div>
              <div className="flex items-center justify-between px-1 mb-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Staged ({stagedFiles.length})
                </span>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => handleUnstage(stagedFiles.map((f) => f.path))}>
                  <Minus className="h-3 w-3" />
                </Button>
              </div>
              <div className="space-y-0.5">
                {stagedFiles.map((f) => (
                  <div
                    key={`staged-${f.path}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted/40 group"
                  >
                    {statusIcon(f.status)}
                    <span className="flex-1 truncate font-mono">{f.path}</span>
                    <button
                      onClick={() => handleUnstage([f.path])}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Minus className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unstaged Changes */}
          {unstagedFiles.length > 0 && (
            <div>
              <div className="flex items-center justify-between px-1 mb-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Changes ({unstagedFiles.length})
                </span>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => handleStage(unstagedFiles.map((f) => f.path))}>
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
              <div className="space-y-0.5">
                {unstagedFiles.map((f) => (
                  <div
                    key={`unstaged-${f.path}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted/40 group"
                  >
                    {statusIcon(f.status)}
                    <span className="flex-1 truncate font-mono">{f.path}</span>
                    <button
                      onClick={() => handleStage([f.path])}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Plus className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stagedFiles.length === 0 && unstagedFiles.length === 0 && (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No changes detected
            </div>
          )}

          {/* Recent Commits */}
          <div>
            <button
              onClick={() => setShowLog(!showLog)}
              className="flex w-full items-center gap-1.5 px-1 mb-1"
            >
              <ChevronRight className={cn("h-3 w-3 text-muted-foreground transition-transform", showLog && "rotate-90")} />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Recent Commits
              </span>
            </button>
            <AnimatePresence>
              {showLog && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="space-y-0.5">
                    {commits.map((commit) => (
                      <div
                        key={commit.hash}
                        className="rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors"
                      >
                        <div className="flex items-start gap-2">
                          <GitCommitIcon className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs text-foreground line-clamp-2 leading-snug">
                              {commit.message}
                            </p>
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              <span className="font-mono">{commit.short}</span>
                              <span className="mx-1">·</span>
                              {commit.date}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  Bottom Panel — Terminal + Chat Input
// ═══════════════════════════════════════════════════════════════

function BottomPanel({
  projectInfo,
  codeMode,
  isMaximized,
  onToggleMaximize,
}: {
  projectInfo: WorkspaceInfo | null;
  codeMode: { state: string; active: boolean } | null;
  isMaximized: boolean;
  onToggleMaximize: () => void;
}) {
  const [activeBottomTab, setActiveBottomTab] = useState<"terminal" | "chat">("terminal");
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>([]);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLoading, setTerminalLoading] = useState(false);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1);
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInputRef = useRef<HTMLInputElement>(null);

  // Chat state
  const [chatInput, setChatInput] = useState("");
  const { connected } = useSSE();
  const streamingText = useChatStore((s) => s.streamingText);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const waiting = useChatStore((s) => s.waiting);
  const messages = useChatStore((s) => s.messages);
  const addMessage = useChatStore((s) => s.addMessage);
  const setWaiting = useChatStore((s) => s.setWaiting);
  const clearStreaming = useChatStore((s) => s.clearStreaming);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const setActiveThread = useChatStore((s) => s.setActiveThread);
  const bumpThreadVersion = useChatStore((s) => s.bumpThreadVersion);

  const isBusy = isStreaming || waiting;

  // Scroll terminal to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalHistory]);

  async function handleTerminalExec() {
    const cmd = terminalInput.trim();
    if (!cmd || terminalLoading) return;
    setTerminalInput("");
    setCmdHistory((prev) => [...prev, cmd]);
    setCmdHistoryIdx(-1);
    setTerminalLoading(true);

    try {
      const result = await api.terminal.exec(cmd);
      setTerminalHistory((prev) => [
        ...prev,
        {
          id: `${Date.now()}`,
          command: cmd,
          output: result.output || result.error || "",
          exitCode: result.exitCode,
          timestamp: Date.now(),
        },
      ]);
    } catch (err: any) {
      setTerminalHistory((prev) => [
        ...prev,
        {
          id: `${Date.now()}`,
          command: cmd,
          output: err.message,
          exitCode: 1,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setTerminalLoading(false);
      termInputRef.current?.focus();
    }
  }

  function handleTerminalKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTerminalExec();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdHistory.length > 0) {
        const newIdx = cmdHistoryIdx < 0 ? cmdHistory.length - 1 : Math.max(0, cmdHistoryIdx - 1);
        setCmdHistoryIdx(newIdx);
        setTerminalInput(cmdHistory[newIdx]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (cmdHistoryIdx >= 0) {
        const newIdx = cmdHistoryIdx + 1;
        if (newIdx >= cmdHistory.length) {
          setCmdHistoryIdx(-1);
          setTerminalInput("");
        } else {
          setCmdHistoryIdx(newIdx);
          setTerminalInput(cmdHistory[newIdx]);
        }
      }
    }
  }

  async function handleChatSend() {
    const content = chatInput.trim();
    if (!content || isBusy) return;
    setChatInput("");

    let threadId = activeThreadId;
    if (!threadId) {
      threadId = `web:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setActiveThread(threadId);
    }

    addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    });
    setWaiting(true);

    api.chat.threads.addMessage(threadId, "user", content)
      .then(() => bumpThreadVersion())
      .catch(() => {});

    try {
      await api.chat.send(content, threadId);
    } catch {
      setWaiting(false);
      clearStreaming();
    }
  }

  // Get last few messages for the chat feed
  const recentMessages = messages.slice(-6);

  return (
    <div className="flex h-full flex-col">
      {/* Status bar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1 text-[11px]">
        {/* Mode indicator */}
        <div className="flex items-center gap-1.5">
          {codeMode?.active ? (
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] px-1.5 py-0 gap-1",
                codeMode.state === "execute"
                  ? "border-emerald-500/40 text-emerald-400"
                  : "border-amber-500/40 text-amber-400"
              )}
            >
              <Zap className="h-2.5 w-2.5" />
              {codeMode.state === "execute" ? "Execute" : "Plan"}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
              Chat
            </Badge>
          )}
        </div>

        <span className="h-3 w-px bg-border" />

        {/* Project info */}
        {projectInfo && (
          <>
            <span className="text-muted-foreground font-mono truncate max-w-[200px]">
              {projectInfo.projectName}
            </span>
            <span className="h-3 w-px bg-border" />
            <span className="text-muted-foreground font-mono truncate max-w-[300px]" title={projectInfo.cwd}>
              {projectInfo.cwd}
            </span>
            {projectInfo.isGit && (
              <>
                <span className="h-3 w-px bg-border" />
                <div className="flex items-center gap-1 text-muted-foreground">
                  <GitBranch className="h-3 w-3" />
                  <span className="font-mono">{projectInfo.branch}</span>
                </div>
              </>
            )}
          </>
        )}

        <span className="flex-1" />

        {/* Connection indicator */}
        <div className="flex items-center gap-1 text-muted-foreground">
          <div className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-red-500")} />
          <span>{connected ? "Connected" : "Disconnected"}</span>
        </div>
      </div>

      {/* Tab headers */}
      <div className="flex items-center justify-between border-b border-border bg-muted/10">
        <div className="flex items-center">
          <button
            onClick={() => setActiveBottomTab("terminal")}
            className={cn(
              "flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium transition-colors border-b-2",
              activeBottomTab === "terminal"
                ? "border-b-primary text-foreground"
                : "border-b-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <TerminalIcon className="h-3.5 w-3.5" />
            Terminal
          </button>
          <button
            onClick={() => setActiveBottomTab("chat")}
            className={cn(
              "flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium transition-colors border-b-2",
              activeBottomTab === "chat"
                ? "border-b-primary text-foreground"
                : "border-b-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
            {isBusy && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
          </button>
        </div>
        <button
          onClick={onToggleMaximize}
          className="mr-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={isMaximized ? "Restore panel" : "Maximize panel"}
          aria-label={isMaximized ? "Restore panel" : "Maximize panel"}
        >
          {isMaximized ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeBottomTab === "terminal" ? (
          <div className="flex h-full flex-col bg-[#0d1117]">
            <div ref={terminalRef} className="flex-1 overflow-auto p-2 font-mono text-[13px]">
              {terminalHistory.map((entry) => (
                <div key={entry.id} className="mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-emerald-400">$</span>
                    <span className="text-gray-200">{entry.command}</span>
                  </div>
                  {entry.output && (
                    <pre className={cn(
                      "whitespace-pre-wrap text-[12px] leading-relaxed mt-0.5 pl-4",
                      entry.exitCode === 0 ? "text-gray-400" : "text-red-400"
                    )}>
                      {entry.output}
                    </pre>
                  )}
                </div>
              ))}
              {terminalLoading && (
                <div className="flex items-center gap-2 text-gray-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span className="text-xs">Running...</span>
                </div>
              )}
            </div>

            {/* Terminal input */}
            <div className="flex items-center gap-2 border-t border-gray-800 bg-[#0d1117] px-3 py-2">
              <span className="text-emerald-400 font-mono text-sm">$</span>
              <input
                ref={termInputRef}
                value={terminalInput}
                onChange={(e) => setTerminalInput(e.target.value)}
                onKeyDown={handleTerminalKeyDown}
                placeholder="Type a command..."
                className="flex-1 bg-transparent font-mono text-[13px] text-gray-200 placeholder:text-gray-600 focus:outline-none"
                autoFocus
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {/* Chat messages feed */}
            <ScrollArea className="flex-1 px-3 py-2">
              <div className="space-y-2">
                {recentMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      "rounded-lg px-3 py-2 text-sm",
                      msg.role === "user"
                        ? "bg-primary/10 text-foreground ml-8"
                        : msg.role === "system"
                          ? "bg-red-500/10 text-red-400"
                          : "bg-muted text-foreground mr-8"
                    )}
                  >
                    {msg.role === "assistant" ? (
                      <MarkdownRenderer content={msg.content} />
                    ) : (
                      <p className="whitespace-pre-wrap text-[13px]">{msg.content}</p>
                    )}
                  </div>
                ))}
                {isStreaming && streamingText && (
                  <div className="rounded-lg bg-muted px-3 py-2 mr-8">
                    <MarkdownRenderer content={streamingText} />
                    <span className="inline-block h-3.5 w-[2px] animate-pulse bg-primary ml-0.5" />
                  </div>
                )}
                {waiting && !isStreaming && (
                  <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground mr-8">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    Thinking...
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Chat input */}
            <div className="flex items-center gap-2 border-t border-border px-3 py-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleChatSend();
                  }
                }}
                placeholder="Ask Mercury..."
                disabled={isBusy}
                className={cn(
                  "flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none",
                  isBusy && "opacity-50"
                )}
              />
              <Button
                size="icon"
                className="h-7 w-7 shrink-0"
                disabled={isBusy || !chatInput.trim()}
                onClick={handleChatSend}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  Main Workspace Page
// ═══════════════════════════════════════════════════════════════

export function WorkspacePage() {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<WorkspaceInfo | null>(null);
  const [codeMode, setCodeMode] = useState<{ state: string; active: boolean } | null>(null);
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(280);
  const [bottomHeight, setBottomHeight] = useState(260);
  const [bottomMaximized, setBottomMaximized] = useState(false);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [folderInput, setFolderInput] = useState("");
  const [folderError, setFolderError] = useState("");
  const [folderLoading, setFolderLoading] = useState(false);
  const [workspaceKey, setWorkspaceKey] = useState(0);

  // Load project info and code mode
  useEffect(() => {
    api.workspace.info().then(setProjectInfo).catch(() => {});
    api.code.status().then((s) => setCodeMode({ state: s.state, active: s.active })).catch(() => {});
  }, []);

  async function handleChangeWorkspace() {
    const path = folderInput.trim();
    if (!path) return;
    setFolderLoading(true);
    setFolderError("");
    try {
      await api.workspace.setRoot(path);
      const info = await api.workspace.info();
      setProjectInfo(info);
      setShowFolderPicker(false);
      setFolderInput("");
      // Reset all panels and close all tabs
      setTabs([]);
      setActiveTab(null);
      setWorkspaceKey((k) => k + 1);
    } catch (err: any) {
      setFolderError(err.message || "Invalid path");
    } finally {
      setFolderLoading(false);
    }
  }

  // Open a file in a tab
  async function openFile(path: string) {
    // Check if already open
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      setActiveTab(path);
      return;
    }

    try {
      const file = await api.workspace.file(path);
      const ext = file.ext || (path.includes(".") ? "." + path.split(".").pop()! : "");
      const newTab: OpenTab = {
        path,
        name: file.name,
        content: file.content,
        language: extToLanguage(ext),
        dirty: false,
        originalContent: file.content,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTab(path);
    } catch {
      // Could not open file
    }
  }

  function closeTab(path: string) {
    setTabs((prev) => prev.filter((t) => t.path !== path));
    if (activeTab === path) {
      const remaining = tabs.filter((t) => t.path !== path);
      setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
    }
  }

  async function saveTab(path: string) {
    const tab = tabs.find((t) => t.path === path);
    if (!tab || !tab.dirty) return;

    try {
      await api.workspace.saveFile(path, tab.content);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === path
            ? { ...t, dirty: false, originalContent: t.content }
            : t
        )
      );
    } catch {
      // Save failed
    }
  }

  function updateTabContent(path: string, content: string) {
    setTabs((prev) =>
      prev.map((t) =>
        t.path === path
          ? { ...t, content, dirty: content !== t.originalContent }
          : t
      )
    );
  }

  // Resizer handlers
  function useResizer(
    direction: "horizontal" | "vertical",
    setValue: React.Dispatch<React.SetStateAction<number>>,
    min: number,
    max: number,
    invert: boolean = false
  ) {
    const dragging = useRef(false);

    const onMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startPos = direction === "horizontal" ? e.clientX : e.clientY;
      let currentValue: number;
      setValue((v) => { currentValue = v; return v; });

      function onMouseMove(e2: MouseEvent) {
        if (!dragging.current) return;
        const rawDelta = direction === "horizontal"
          ? e2.clientX - startPos
          : startPos - e2.clientY; // inverted for bottom panel
        const delta = invert ? -rawDelta : rawDelta;
        setValue(Math.min(max, Math.max(min, currentValue! + delta)));
      }

      function onMouseUp() {
        dragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      }

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    }, [direction, setValue, min, max, invert]);

    return { onMouseDown };
  }

  const leftResizer = useResizer("horizontal", setLeftWidth, 160, 400);
  // Right panel's resizer sits on its LEFT edge, so mouse delta is inverted
  const rightResizer = useResizer("horizontal", setRightWidth, 200, 450, true);
  const bottomResizer = useResizer("vertical", setBottomHeight, 120, 500);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Workspace header bar */}
      <div className="flex items-center gap-3 border-b border-border bg-muted/20 px-4 py-1.5">
        <div className="flex items-center gap-2 text-sm">
          <FolderInput className="h-4 w-4 text-mercury-400" />
          <span className="font-medium text-foreground">
            {projectInfo?.projectName || "Workspace"}
          </span>
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[300px]" title={projectInfo?.cwd}>
            {projectInfo?.cwd || "—"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => { setShowFolderPicker(!showFolderPicker); setFolderInput(projectInfo?.cwd || ""); setFolderError(""); }}
        >
          Change Folder
        </Button>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setShowLeft(!showLeft)}
        >
          {showLeft ? "Hide Explorer" : "Show Explorer"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setShowRight(!showRight)}
        >
          {showRight ? "Hide Git" : "Show Git"}
        </Button>
      </div>

      {/* Folder picker dropdown */}
      <AnimatePresence>
        {showFolderPicker && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden border-b border-border"
          >
            <div className="flex items-center gap-2 bg-muted/10 px-4 py-2">
              <input
                value={folderInput}
                onChange={(e) => { setFolderInput(e.target.value); setFolderError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleChangeWorkspace(); if (e.key === "Escape") setShowFolderPicker(false); }}
                placeholder="/path/to/project"
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
                autoFocus
              />
              <Button
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={handleChangeWorkspace}
                disabled={folderLoading || !folderInput.trim()}
              >
                {folderLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Open
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => setShowFolderPicker(false)}
              >
                Cancel
              </Button>
            </div>
            {folderError && (
              <p className="px-4 pb-2 text-xs text-red-400">{folderError}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main content area (horizontal split) */}
      {!bottomMaximized && (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left Panel — File Explorer */}
          {showLeft && (
            <>
              <div style={{ width: leftWidth }} className="shrink-0 overflow-hidden border-r border-border">
                <FileExplorer key={workspaceKey} onOpenFile={openFile} openFiles={tabs.map((t) => t.path)} />
              </div>
              {/* Left resizer */}
              <div
                {...leftResizer}
                className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
              />
            </>
          )}

          {/* Center Panel — Editor Tabs */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <EditorPanel
              tabs={tabs}
              activeTab={activeTab}
              onSelectTab={setActiveTab}
              onCloseTab={closeTab}
              onSave={saveTab}
              onContentChange={updateTabContent}
            />
          </div>

          {/* Right resizer */}
          {showRight && (
            <div
              {...rightResizer}
              className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
            />
          )}

          {/* Right Panel — Git */}
          {showRight && (
            <div style={{ width: rightWidth }} className="shrink-0 overflow-hidden border-l border-border">
              <GitPanel key={workspaceKey} />
            </div>
          )}
        </div>
      )}

      {/* Bottom resizer (hidden when maximized) */}
      {!bottomMaximized && (
        <div
          {...bottomResizer}
          className="h-1 shrink-0 cursor-row-resize hover:bg-primary/30 active:bg-primary/50 transition-colors border-t border-border"
        />
      )}

      {/* Bottom Panel — Terminal + Chat */}
      <div
        style={bottomMaximized ? undefined : { height: bottomHeight }}
        className={cn(
          "overflow-hidden",
          bottomMaximized ? "flex-1 min-h-0" : "shrink-0"
        )}
      >
        <BottomPanel
          projectInfo={projectInfo}
          codeMode={codeMode}
          isMaximized={bottomMaximized}
          onToggleMaximize={() => setBottomMaximized((v) => !v)}
        />
      </div>
    </div>
  );
}
