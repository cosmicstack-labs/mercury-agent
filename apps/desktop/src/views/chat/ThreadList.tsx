import { Bookmark, BookmarkMinus, Pencil, Search, SquarePen, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "~/lib/cx";
import * as api from "~/api/mercury";
import type { ChatThread } from "~/api/types";
import { refreshThreads, renameThread, setThreadSaved } from "~/app/events";
import { useNotify } from "~/app/notify/store";
import { Dialog } from "~/components/ui/Dialog";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";

const PAGE = 40;

/**
 * Sessions of one surface, most recently active first, grouped by day, with
 * New and search on top. Renders a page at a time and adds the next page as
 * the list scrolls.
 */
export function ThreadList({ threads, activeId, onOpen, onNew, newLabel, searchLabel, renderMeta, pinned, savedOnly = false, onLeaveSaved, onShowSaved }: {
  threads: ChatThread[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  newLabel: string;
  searchLabel: string;
  renderMeta?: (t: ChatThread) => React.ReactNode;
  /** Shown above the sessions (e.g. the live Optimus voice session). */
  pinned?: React.ReactNode;
  /** Only the saved threads, newest save first (⌘⇧S or the bookmark by search); the list doesn't mark them otherwise. */
  savedOnly?: boolean;
  onLeaveSaved?: () => void;
  /** Opens the saved list; the button shows only once something is saved. */
  onShowSaved?: () => void;
}) {
  const unread = useNotify((s) => s.unread);
  const waiting = useNotify((s) => s.waiting);
  const [limit, setLimit] = useState(PAGE);
  const [query, setQuery] = useState("");
  const [renameTarget, setRenameTarget] = useState<ChatThread | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  const titleLength = Array.from(normalizedTitle).length;
  const sentinel = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = savedOnly
      ? threads.filter((t) => t.savedAt).sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""))
      : [...threads].sort((a, b) => stamp(b).localeCompare(stamp(a)));
    return q ? sorted.filter((t) => (t.title || t.alias || "").toLowerCase().includes(q)) : sorted;
  }, [threads, query, savedOnly]);
  const hasSaved = useMemo(() => threads.some((t) => t.savedAt), [threads]);
  const page = filtered.slice(0, limit);
  const groups = useMemo<Array<[string, ChatThread[]]>>(() => (savedOnly ? (page.length ? [["Saved", page]] : []) : groupByDay(page)), [page, savedOnly]);

  useEffect(() => { setLimit(PAGE); }, [query]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((l) => (l < filtered.length ? l + PAGE : l));
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length]);

  async function remove(t: ChatThread) {
    try {
      await api.chat.deleteThread(t.id);
      if (activeId === t.id) onNew();
      void refreshThreads();
    } catch { /* keep */ }
  }

  async function saveTitle(event: React.FormEvent) {
    event.preventDefault();
    if (!renameTarget || saving || !titleLength || titleLength > 120) return;
    setSaving(true);
    setRenameError(null);
    try {
      await renameThread(renameTarget.id, normalizedTitle);
      setRenameTarget(null);
    } catch (error) { setRenameError(error instanceof Error ? error.message : "Could not save the chat name."); }
    finally { setSaving(false); }
  }

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-line bg-soft">
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-3" data-tauri-drag-region>
        <button onClick={onNew} className="flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-base font-medium text-ink shadow-sm hover:border-line-strong" data-no-drag>
          <SquarePen size={17} aria-hidden="true" />
          <span className="flex-1 text-left">{newLabel}</span>
          <kbd className="font-mono text-xs text-ink4">⌘N</kbd>
        </button>
        <div className="flex items-center gap-1">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-ink4 hover:bg-ink/[0.04] focus-within:bg-ink/[0.05]">
            <Search size={16} aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchLabel} className="w-full bg-transparent text-base text-ink placeholder:text-ink4" aria-label={searchLabel} />
          </label>
          {onShowSaved && (savedOnly || hasSaved) && (
            <button
              onClick={savedOnly ? onLeaveSaved : onShowSaved}
              className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-ink/[0.05]", savedOnly ? "bg-ink/[0.07] text-ink" : "text-ink4 hover:text-ink")}
              aria-label={savedOnly ? "Show all chats" : "Show saved chats"}
              aria-pressed={savedOnly}
              title={savedOnly ? "All chats (⌘⇧S)" : "Saved chats (⌘⇧S)"}
              data-no-drag>
              <Bookmark size={16} aria-hidden="true" fill={savedOnly ? "currentColor" : "none"} />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {savedOnly && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-ink/[0.04] px-3 py-2">
            <Bookmark size={15} className="shrink-0 text-ink3" aria-hidden="true" />
            <span className="flex-1 text-sm font-medium text-ink">Saved</span>
            <button onClick={onLeaveSaved} className="flex items-center gap-1 text-xs text-ink4 hover:text-ink" aria-label="Back to all chats">
              <X size={13} /> <kbd className="font-mono">esc</kbd>
            </button>
          </div>
        )}
        {!savedOnly && pinned}
        {!savedOnly && threads.some((t) => unread[t.id] && t.id !== activeId) && (
          <div className="flex justify-end px-3 pb-1">
            <button onClick={() => { const seen = useNotify.getState().seen; for (const t of threads) if (unread[t.id]) seen(t.id); }} className="text-xs text-ink4 hover:text-ink">Mark all as read</button>
          </div>
        )}
        {filtered.length === 0 && <p className="px-3 pt-2 text-base text-ink4">{query ? "Nothing matches." : savedOnly ? "Nothing saved yet. Open a chat and press ⌘S, or the bookmark at the top." : "No sessions yet."}</p>}
        {groups.map(([day, list]) => (
          <div key={day} className="mb-5">
            {!savedOnly && <div className="px-3 pb-1.5 text-xs font-medium uppercase tracking-wider text-ink4">{day}</div>}
            {list.map((t) => (
              <div key={t.id} className={cx("group flex items-center rounded-lg", activeId === t.id ? "bg-ink/[0.07]" : "hover:bg-ink/[0.05]")}>
                <button onClick={() => onOpen(t.id)} className="min-w-0 flex-1 px-3 py-2.5 text-left text-base" title={t.title || "Untitled"}>
                  <span className="flex items-center gap-2">
                    <span className={cx("min-w-0 flex-1 truncate", activeId === t.id ? "text-ink" : unread[t.id] ? "font-medium text-ink" : "text-ink2 group-hover:text-ink")}>{(t.title || "Untitled").replace(/^Code · /, "")}</span>
                    {t.id in waiting
                      ? <span className="h-2 w-2 shrink-0 rounded-full bg-amber" aria-label="Waiting for you" title="Waiting for your answer" />
                      : unread[t.id] && activeId !== t.id ? <span className="h-2 w-2 shrink-0 rounded-full bg-blue" aria-label="New" title="Something new" /> : null}
                  </span>
                  {renderMeta?.(t)}
                </button>
                <button
                  onClick={() => { setRenameTarget(t); setTitle(t.title || ""); setRenameError(null); }}
                  className={cx("mr-1 rounded p-1 text-ink4 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100", activeId === t.id ? "opacity-100" : "opacity-0")}
                  aria-label={`Rename ${t.title || "chat"}`} title="Rename chat">
                  <Pencil size={15} />
                </button>
                {savedOnly ? (
                  <button onClick={() => void setThreadSaved(t.id, false).catch(() => {})} className="mr-1 hidden rounded p-1 text-ink4 hover:text-ink group-hover:block" aria-label="Unsave" title="Unsave">
                    <BookmarkMinus size={15} />
                  </button>
                ) : (
                  <button onClick={() => void remove(t)} className="mr-1 hidden rounded p-1 text-ink4 hover:text-red group-hover:block" aria-label="Delete thread">
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
        <div ref={sentinel} className="h-px" aria-hidden="true" />
      </div>
      <Dialog open={renameTarget !== null} onOpenChange={open => { if (!open && !saving) setRenameTarget(null); }} title="Rename chat" description="Choose a name up to 120 characters. Mercury will keep the name you choose.">
        <form onSubmit={saveTitle} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="chat-title" className="text-sm font-medium">Chat name</label>
            <Input id="chat-title" value={title} disabled={saving} autoFocus onFocus={event => event.target.select()} onChange={event => setTitle(event.target.value)} aria-describedby="chat-title-length" />
            <p id="chat-title-length" className={cx("text-xs", titleLength > 120 ? "text-red" : "text-ink3")}>{titleLength}/120 characters</p>
            {renameError && <p role="alert" className="text-sm text-red">{renameError}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button type="submit" disabled={saving || !titleLength || titleLength > 120}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </Dialog>
    </aside>
  );
}

function stamp(t: ChatThread): string {
  return t.updatedAt || t.createdAt || "";
}

function groupByDay(threads: ChatThread[]): Array<[string, ChatThread[]]> {
  const out = new Map<string, ChatThread[]>();
  const today = startOfDay(new Date());
  for (const t of threads) {
    const diff = Math.floor((today - startOfDay(new Date(stamp(t)))) / 86_400_000);
    const key = Number.isNaN(diff) ? "Earlier" : diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? "Previous 7 days" : diff < 30 ? "Previous 30 days" : "Older";
    const list = out.get(key) ?? [];
    list.push(t);
    out.set(key, list);
  }
  return [...out.entries()];
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
