import { ChevronRight, File, Folder, GitCompare, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as api from "~/api/mercury";
import { useUi } from "~/app/store";
import { conversations } from "~/app/conversation";
import { Button } from "~/components/ui/Button";
import { Badge, Segmented, Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";

type Tab = "changes" | "files";
type Selection = { kind: "diff" | "file"; path: string } | null;

interface GitFile { path: string; status: string; staged: boolean }
interface TreeItem { name: string; path: string; isDirectory: boolean }

/**
 * The project beside the conversation: what changed (live), the files, and
 * a preview of whatever is selected — all in this side panel, never in
 * the conversation.
 */
export function ProjectPanel({ folder }: { folder: string }) {
  const view = useUi((s) => s.view);
  const [tab, setTab] = useState<Tab>("changes");
  const [isGit, setIsGit] = useState<boolean | null>(null);
  const [files, setFiles] = useState<GitFile[]>([]);
  const [meta, setMeta] = useState<{ branch: string; ahead: number; behind: number } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [width, setWidth] = useState(380);

  const loadGit = useCallback(async () => {
    try {
      const info = await api.workspace.info();
      setIsGit(info.isGit);
      if (!info.isGit) { setFiles([]); setMeta(null); return; }
      const s = await api.git.status();
      setFiles(s.files);
      setMeta({ branch: s.branch, ahead: s.ahead, behind: s.behind });
    } catch {
      setIsGit(false);
    }
  }, []);

  // Real time: poll while Code is on screen, and right after every turn.
  useEffect(() => {
    if (view !== "code") return;
    void loadGit();
    const timer = setInterval(() => void loadGit(), 3000);
    const off = conversations.code.subscribe((s, prev) => { if (s.agent === "idle" && prev.agent !== "idle") void loadGit(); });
    return () => { clearInterval(timer); off(); };
  }, [view, folder, loadGit]);

  useEffect(() => { setSelection(null); }, [folder]);

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-line bg-soft" style={{ width }}>
      <Resizer onResize={(dx) => setWidth((w) => Math.min(720, Math.max(300, w - dx)))} />
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-3">
        <Segmented<Tab> value={tab} onChange={setTab} options={[{ value: "changes", label: `Changes${files.length ? ` · ${files.length}` : ""}` }, { value: "files", label: "Files" }]} />
        <div className="flex-1" />
        <Button variant="ghost" size="sm" icon onClick={() => void loadGit()} aria-label="Refresh"><RefreshCw size={14} /></Button>
      </div>

      <div className={cx("min-h-0 overflow-y-auto", selection ? "h-[38%] shrink-0 border-b border-line" : "flex-1")}>
        {tab === "changes" && (
          isGit === null ? <Centered><Spinner size={16} /></Centered>
          : !isGit ? <Centered>This folder is not a Git repository, so changes aren't tracked. Files are still browsable.</Centered>
          : (
            <div className="p-2">
              {meta && <div className="px-2 pb-2 pt-1 font-mono text-xs text-ink3">{meta.branch}{meta.ahead ? ` ↑${meta.ahead}` : ""}{meta.behind ? ` ↓${meta.behind}` : ""}</div>}
              {files.length === 0 && <p className="px-2 py-3 text-sm text-ink3">No changes. Edits Mercury makes appear here as they happen.</p>}
              {files.map((f) => (
                <button key={`${f.path}:${f.staged}`} onClick={() => setSelection({ kind: "diff", path: f.path })}
                  className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", selection?.path === f.path ? "bg-ink/[0.08]" : "hover:bg-ink/[0.05]")}>
                  <StatusLetter status={f.status} />
                  <span className="min-w-0 flex-1 truncate text-ink">{f.path.split("/").pop()}</span>
                  <span className="max-w-[45%] truncate font-mono text-2xs text-ink4">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                  {f.staged && <Badge>staged</Badge>}
                </button>
              ))}
            </div>
          )
        )}
        {tab === "files" && <FileTree onOpen={(path) => setSelection({ kind: "file", path })} selected={selection?.kind === "file" ? selection.path : null} />}
      </div>

      {selection && <Preview selection={selection} onClose={() => setSelection(null)} />}
    </aside>
  );
}

function StatusLetter({ status }: { status: string }) {
  const s = status.trim().charAt(0) || "?";
  const tone = s === "A" || s === "?" ? "text-accent" : s === "D" ? "text-red" : s === "M" ? "text-amber" : "text-ink3";
  return <span className={cx("w-4 shrink-0 text-center font-mono text-xs font-semibold", tone)} title={status}>{s === "?" ? "U" : s}</span>;
}

function FileTree({ onOpen, selected }: { onOpen: (path: string) => void; selected: string | null }) {
  return <div className="p-2"><Dir path="" depth={0} onOpen={onOpen} selected={selected} initiallyOpen /></div>;
}

function Dir({ path, depth, onOpen, selected, initiallyOpen }: { path: string; depth: number; onOpen: (p: string) => void; selected: string | null; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(initiallyOpen));
  const [items, setItems] = useState<TreeItem[] | null>(null);
  useEffect(() => {
    if (!open || items) return;
    void api.workspace.tree(path || undefined).then((t) => setItems(t.items.filter((i) => !/^(\.git|node_modules|\.DS_Store)$/.test(i.name)))).catch(() => setItems([]));
  }, [open, path, items]);
  const children = items === null && open ? <div className="py-1 pl-6 text-ink4"><Spinner size={12} /></div> : (
    open && items?.map((i) => i.isDirectory
      ? <Dir key={i.path} path={i.path} depth={depth + 1} onOpen={onOpen} selected={selected} />
      : (
        <button key={i.path} onClick={() => onOpen(i.path)} style={{ paddingLeft: 8 + (depth + 1) * 14 }}
          className={cx("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm", selected === i.path ? "bg-ink/[0.08] text-ink" : "text-ink2 hover:bg-ink/[0.05] hover:text-ink")}>
          <File size={13} className="shrink-0 text-ink4" /><span className="truncate">{i.name}</span>
        </button>
      ))
  );
  if (depth === 0) return <>{children}</>;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} style={{ paddingLeft: 8 + depth * 14 - 14 }} className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-sm text-ink2 hover:bg-ink/[0.05] hover:text-ink">
        <ChevronRight size={13} className={cx("shrink-0 text-ink4 transition-transform", open && "rotate-90")} />
        <Folder size={13} className="shrink-0 text-ink3" /><span className="truncate">{path.split("/").pop()}</span>
      </button>
      {children}
    </div>
  );
}

function Preview({ selection, onClose }: { selection: NonNullable<Selection>; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setText(null); setError(null);
    const load = selection.kind === "diff"
      ? api.git.diff(selection.path).then((r) => r.diff || "(no diff — the file may be new and untracked)")
      : api.workspace.file(selection.path).then((f) => f.content + (f.truncated ? "\n… (truncated)" : ""));
    load.then((t) => { if (live) setText(t); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [selection.kind, selection.path]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        {selection.kind === "diff" ? <GitCompare size={13} className="text-ink3" /> : <File size={13} className="text-ink3" />}
        <span className="min-w-0 flex-1 truncate font-mono text-ink2" title={selection.path}>{selection.path}</span>
        <button onClick={onClose} className="rounded p-0.5 text-ink4 hover:text-ink" aria-label="Close preview"><X size={14} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-bg">
        {error && <p className="p-3 text-sm text-red">{error}</p>}
        {text === null && !error && <div className="p-3 text-ink3"><Spinner size={14} /></div>}
        {text !== null && (selection.kind === "diff" ? <Diff text={text} /> : <pre className="p-3 font-mono text-[12.5px] leading-relaxed text-ink" data-selectable>{text}</pre>)}
      </div>
    </div>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="py-2 font-mono text-[12.5px] leading-relaxed" data-selectable>
      {text.split("\n").map((line, i) => (
        <div key={i} className={cx("px-3",
          line.startsWith("+") && !line.startsWith("+++") && "bg-accent/10 text-ink",
          line.startsWith("-") && !line.startsWith("---") && "bg-red/10 text-ink",
          line.startsWith("@@") && "text-cyan",
          (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) && "text-ink4",
          !/^[+\-@]|^diff |^index /.test(line) && "text-ink2")}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink3">{children}</div>;
}

function Resizer({ onResize }: { onResize: (dx: number) => void }) {
  return (
    <div
      className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize"
      onPointerDown={(e) => {
        let last = e.clientX;
        const move = (ev: PointerEvent) => { onResize(ev.clientX - last); last = ev.clientX; };
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize project panel"
    />
  );
}
