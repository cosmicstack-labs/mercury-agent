import { Layers, MessageSquareText, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { artifactsApi, formatBytes, type ArtifactItem, type ArtifactKind } from "~/api/artifacts";
import { openThread } from "~/app/events";
import { useCodeSessions } from "~/app/conversation";
import { useUi } from "~/app/store";
import { ArtifactThumb } from "~/components/artifacts/ArtifactCard";
import { ArtifactViewer } from "~/components/artifacts/ArtifactViewer";
import { Button } from "~/components/ui/Button";
import { Spinner } from "~/components/ui/bits";
import { SearchField } from "~/components/ui/kit";
import { cx } from "~/lib/cx";

/**
 * Artifacts: everything Mercury made (images, videos, audio, PDFs,
 * documents, notes), newest first. Search, a tab per kind, a page at a time
 * as you scroll. Each card says which conversation made it; open the
 * conversation, or narrow to it. Deleting a conversation deletes its
 * artifacts (Mercury's copies; your files stay).
 */

type Tab = "all" | ArtifactKind;
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "all", label: "All" }, { id: "image", label: "Images" }, { id: "video", label: "Videos" }, { id: "audio", label: "Audio" },
  { id: "pdf", label: "PDFs" }, { id: "document", label: "Documents" }, { id: "text", label: "Notes" }, { id: "file", label: "Files" },
];

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export function ArtifactsView() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const codeSessions = useCodeSessions((s) => s.sessions);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [thread, setThread] = useState<{ id: string; title: string } | null>(null);
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);
  const visible = view === "artifacts";

  const load = useCallback(async (more: boolean) => {
    const my = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const page = await artifactsApi.list({ kind: tab, q: query.trim() || undefined, threadId: thread?.id, cursor: more ? cursor : null, limit: 40 });
      if (my !== reqId.current) return;
      setItems((cur) => (more ? [...cur, ...page.items.filter((x) => !cur.some((c) => c.id === x.id))] : page.items));
      setCursor(page.nextCursor);
      setCounts(page.counts);
      setLoaded(true);
    } catch (e) {
      if (my === reqId.current) setError(errorText(e));
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, [tab, query, thread, cursor]);

  // New filters: start over (search waits for a pause in typing).
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => void load(false), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [visible, tab, query, thread]); // eslint-disable-line react-hooks/exhaustive-deps

  // A page at a time as you reach the bottom.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting && cursor && !loading) void load(true); }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loading, load]);

  const openConversation = (threadId: string) => {
    const code = codeSessions.some((s) => s.id === threadId);
    setView(code ? "code" : "chat");
    void openThread(code ? "code" : "chat", threadId);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-5" data-tauri-drag-region>
          <span className="text-base font-semibold text-ink" data-tauri-drag-region>Artifacts</span>
          <span className="text-xs text-ink4" data-tauri-drag-region>{counts.all ?? 0} made by Mercury</span>
          <span className="flex-1" data-tauri-drag-region />
          <SearchField value={query} onChange={setQuery} placeholder="Search by name or path" className="w-[260px]" />
          <Button variant="ghost" size="sm" icon onClick={() => void load(false)} loading={loading && loaded} aria-label="Refresh"><RefreshCw size={14} /></Button>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-4 py-2">
          {TABS.filter((t) => t.id === "all" || (counts[t.id] ?? 0) > 0 || tab === t.id).map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} aria-pressed={tab === t.id}
              className={cx("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm", tab === t.id ? "bg-ink/[0.08] text-ink" : "text-ink3 hover:bg-ink/[0.04] hover:text-ink")}>
              {t.label}<span className="font-mono text-2xs text-ink4">{t.id === "all" ? counts.all ?? 0 : counts[t.id] ?? 0}</span>
            </button>
          ))}
          {thread && (
            <span className="ml-2 flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-ink2">
              <MessageSquareText size={11} /> {thread.title}
              <button onClick={() => setThread(null)} className="text-ink4 hover:text-ink" aria-label="Show all conversations"><X size={11} /></button>
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && <p className="mb-3 text-sm text-red">{error}</p>}
          {!loaded && <div className="p-6"><Spinner size={16} /></div>}
          {loaded && items.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-20 text-center">
              <Layers size={26} className="text-ink4" />
              <p className="max-w-[420px] text-sm text-ink3">
                {query || tab !== "all" || thread ? "Nothing matches." : "When Mercury makes something for you (an image, a video, a PDF, a report) it shows up here, with the conversation it came from."}
              </p>
            </div>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {items.map((a) => (
              <div key={a.id} className={cx("group flex flex-col overflow-hidden rounded-xl border bg-surface text-left transition-colors", selected === a.id ? "border-accent/60" : "border-line hover:border-ink/25")}>
                <button onClick={() => setSelected(a.id)} className="aspect-[4/3] w-full overflow-hidden" aria-label={`Open ${a.name}`}>
                  <ArtifactThumb id={a.id} kind={a.kind} name={a.name} />
                </button>
                <div className="flex flex-col gap-0.5 px-2.5 py-2">
                  <button onClick={() => setSelected(a.id)} className="truncate text-left text-sm text-ink" title={a.name}>{a.name}</button>
                  <span className="text-2xs text-ink4">{formatBytes(a.size)} · {when(a.createdAt)}</span>
                  {a.threadExists && a.threadTitle && (
                    <button onClick={() => setThread({ id: a.threadId, title: a.threadTitle! })} className="truncate text-left text-2xs text-ink3 hover:text-ink hover:underline" title="Only this conversation's artifacts">
                      {a.threadTitle}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div ref={sentinel} className="h-8" />
          {loading && loaded && <div className="flex justify-center py-3"><Spinner size={14} /></div>}
        </div>
      </div>

      {selected && (
        <aside className="flex w-[46%] min-w-[380px] max-w-[720px] shrink-0 flex-col border-l border-line bg-soft">
          <div className="flex h-[52px] items-center justify-end px-3" data-tauri-drag-region>
            <Button size="sm" variant="ghost" icon onClick={() => setSelected(null)} aria-label="Close preview"><X size={15} /></Button>
          </div>
          <div className="min-h-0 flex-1">
            <ArtifactViewer key={selected} id={selected} onOpenThread={openConversation}
              onDeleted={() => { setItems((cur) => cur.filter((x) => x.id !== selected)); setSelected(null); void load(false); }} />
          </div>
        </aside>
      )}
    </div>
  );
}
