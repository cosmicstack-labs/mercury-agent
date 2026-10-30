import { FolderOpen, GitBranch, PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "~/api/mercury";
import type { CodeMode } from "~/api/types";
import { useChat, useUi } from "~/app/store";
import { conversations, ConversationContext, useCodeSessions } from "~/app/conversation";
import { openThread, type CodeTurn } from "~/app/events";
import { Button } from "~/components/ui/Button";
import { Tooltip } from "~/components/ui/Tooltip";
import { CodeHome } from "./CodeHome";
import { useRuntimeState } from "~/app/store";
import { useHealth } from "~/app/health";
import { ThreadList } from "~/views/chat/ThreadList";
import { Conversation } from "~/views/chat/Conversation";
import { useConnections } from "~/shell/connections";
import { ProjectPanel } from "./ProjectPanel";
import { FolderPicker } from "./FolderPicker";

type Mode = Exclude<CodeMode, "off">;

const MODES: Array<{ value: Mode; label: string; hint: string }> = [
  { value: "auto", label: "Auto", hint: "Plans and builds in one flow" },
  { value: "plan", label: "Plan", hint: "Plans first and waits for you" },
  { value: "execute", label: "Execute", hint: "Carries out the plan" },
];

/**
 * Mercury Code: its own sessions, its own conversation, a project folder
 * per session, and the project on the right (changes in real time, files,
 * preview). Programming is always on here — only how it works (Auto, Plan,
 * Execute) is a choice — and it applies to this session only: the runtime
 * swaps it in per turn, so Chat and the terminal are untouched.
 */
export function CodeView() {
  const view = useUi((s) => s.view);
  const threads = useChat((s) => s.threads);
  const sessions = useCodeSessions((s) => s.sessions);
  const upsert = useCodeSessions((s) => s.upsert);
  const loadSessions = useCodeSessions((s) => s.load);
  const activeId = conversations.code((s) => s.activeId);
  const connection = useConnections((s) => s.connections.find((c) => c.id === s.activeId));
  const [listOpen, setListOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [mode, setMode] = useState<Mode>("auto");
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [branch, setBranch] = useState<string>("");
  const [draft, setDraft] = useState<string | null>(null);
  const model = useRuntimeState((s) => s.model);
  const health = useHealth();
  const cycleMode = () => setMode((m) => MODES[(MODES.findIndex((x) => x.value === m) + 1) % MODES.length].value);

  useEffect(() => { if (connection) loadSessions(`${connection.id}@${connection.baseUrl}`); }, [connection?.id, connection?.baseUrl, loadSessions]);

  const session = sessions.find((s) => s.id === activeId) ?? null;
  const folder = session?.folder ?? pendingFolder;

  // Git and file endpoints follow the runtime's workspace root: point it at this session's folder.
  useEffect(() => {
    if (!folder || view !== "code") return;
    void api.workspace.setRoot(folder).then(() => api.workspace.info()).then((i) => setBranch(i.isGit ? i.branch : "")).catch(() => setBranch(""));
  }, [folder, view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== "code") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && !e.shiftKey) { e.preventDefault(); void openThread("code", null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  function chooseFolder(path: string) {
    setPicking(false);
    if (session) upsert({ ...session, folder: path });
    else setPendingFolder(path);
  }

  const ids = new Set(sessions.map((s) => s.id));
  const codeThreads = threads.filter((t) => ids.has(t.id));
  const folderOf = (id: string) => sessions.find((s) => s.id === id)?.folder ?? null;
  const turn: CodeTurn = { mode, folder };

  return (
    <ConversationContext.Provider value={conversations.code}>
      <div className="flex h-full min-h-0">
        {listOpen && (
          <ThreadList
            threads={codeThreads}
            activeId={activeId}
            onOpen={(id) => void openThread("code", id)}
            onNew={() => { setPendingFolder(folder); void openThread("code", null); }}
            newLabel="New session"
            searchLabel="Search sessions"
            renderMeta={(t) => { const f = folderOf(t.id); return f ? <span className="block truncate font-mono text-xs text-ink4">{shortPath(f)}</span> : null; }}
          />
        )}

        <Conversation
          header={
            <>
              <Tooltip label={listOpen ? "Hide sessions" : "Show sessions"} side="bottom">
                <Button variant="ghost" size="sm" icon onClick={() => setListOpen((o) => !o)} aria-label="Toggle sessions"><PanelLeft size={16} /></Button>
              </Tooltip>
              <button onClick={() => setPicking(true)} className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-sm hover:border-line-strong" title={folder ?? "Choose a project folder"}>
                <FolderOpen size={15} className="shrink-0 text-ink3" />
                <span className="truncate font-medium text-ink">{folder ? baseName(folder) : "Open a folder…"}</span>
              </button>
              {branch && <span className="flex items-center gap-1 font-mono text-xs text-ink3"><GitBranch size={13} />{branch}</span>}
              <div className="flex-1" />
              <Tooltip label={panelOpen ? "Hide project" : "Show project"} side="bottom">
                <Button variant="ghost" size="sm" icon onClick={() => setPanelOpen((o) => !o)} aria-label="Toggle project panel"><PanelRight size={16} /></Button>
              </Tooltip>
            </>
          }
          empty={
            <CodeHome
              folder={folder}
              branch={branch}
              version={health?.version ?? ""}
              model={model}
              mode={mode}
              recent={codeThreads.filter((t) => !folder || folderOf(t.id) === folder).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))}
              onPickFolder={() => setPicking(true)}
              onOpenSession={(id) => void openThread("code", id)}
              onSuggest={(t) => setDraft(t)}
            />
          }
          composer={{ surface: "code", placeholder: 'Try "fix the failing test in src/…"', code: turn, blockedReason: folder ? undefined : "Open a project folder first", mono: true, draft, onDraftConsumed: () => setDraft(null), onCycleMode: cycleMode, modeLabel: mode }}
        />

        {panelOpen && folder && <ProjectPanel folder={folder} />}
      </div>
      <FolderPicker open={picking} onOpenChange={setPicking} onPick={chooseFolder} initial={folder ?? ""} local={connection?.kind === "local"} />
    </ConversationContext.Provider>
  );
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");
}
