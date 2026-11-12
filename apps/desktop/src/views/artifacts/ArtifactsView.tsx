import { Check, ChevronLeft, ChevronRight, HardDrive, Maximize2, Layers, ListChecks, MessageSquareText, MoreHorizontal, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { OutputFolder } from "./OutputFolder";
import { CleanupDialog, freedText } from "./Cleanup";
import { Lightbox } from "~/components/artifacts/Lightbox";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "~/components/ui/Menu";
import { ConfirmButton } from "~/components/ui/kit";
import type { ArtifactUsage } from "~/api/artifacts";

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

/** One card: an artifact, or a batch made together (five images for one ask). */
type Entry = { id: string; items: ArtifactItem[] };

/** Batches gathered into one card, at the place of their newest member. */
export function groupBatches(items: ArtifactItem[]): Entry[] {
  const out: Entry[] = [];
  const byBatch = new Map<string, Entry>();
  for (const a of items) {
    const known = a.batch ? byBatch.get(a.batch) : undefined;
    if (known) { known.items.push(a); continue; }
    const e = { id: a.batch ? `batch:${a.batch}` : a.id, items: [a] };
    if (a.batch) byBatch.set(a.batch, e);
    out.push(e);
  }
  return out;
}

/** A batch's cover: its first four, as a mosaic. */
function BatchCover({ items }: { items: ArtifactItem[] }) {
  const shown = items.slice(0, 4);
  return (
    <span className={cx("grid h-full w-full gap-px bg-line", shown.length > 1 ? "grid-cols-2" : "grid-cols-1", shown.length > 2 && "grid-rows-2")}>
      {shown.map((a, i) => (
        <span key={a.id} className={cx("overflow-hidden", shown.length === 3 && i === 0 && "row-span-2")}>
          <ArtifactThumb id={a.id} kind={a.kind} name={a.name} />
        </span>
      ))}
    </span>
  );
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
  /** The batch the open artifact belongs to, to step through it. */
  const [selectedBatch, setSelectedBatch] = useState<ArtifactItem[] | null>(null);
  const entries = useMemo(() => groupBatches(items), [items]);
  const [fullscreen, setFullscreen] = useState(false);
  const batchIndex = selectedBatch ? Math.max(0, selectedBatch.findIndex((x) => x.id === selected)) : 0;
  const step = (d: number) => {
    if (!selectedBatch) return;
    setSelected(selectedBatch[(batchIndex + d + selectedBatch.length) % selectedBatch.length].id);
  };
  // ← → step through the open batch (not while typing in the search box, nor under the full-screen slider).
  useEffect(() => {
    if (!selectedBatch || fullscreen) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
  const select = (e: Entry) => { setSelected(e.items[0].id); setSelectedBatch(e.items.length > 1 ? e.items : null); };
  const sentinel = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);
  const visible = view === "artifacts";

  // Clean up (behind the ⋯ menu): space taken, bulk deletes, and picking several to delete.
  const [usage, setUsage] = useState<ArtifactUsage | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const refreshUsage = () => artifactsApi.usage().then(setUsage).catch(() => setUsage(null));
  const togglePick = (e: Entry) => setPicked((cur) => {
    const next = new Set(cur);
    const on = e.items.every((x) => next.has(x.id));
    for (const x of e.items) { if (on) next.delete(x.id); else next.add(x.id); }
    return next;
  });
  const stopPicking = () => { setPicking(false); setPicked(new Set()); };
  const pickedBytes = items.filter((x) => picked.has(x.id)).reduce((n, x) => n + x.size, 0);
  const deletePicked = async () => {
    setDeleting(true);
    try {
      const r = await artifactsApi.removeMany({ ids: [...picked] });
      setBulkNote(freedText(r));
      if (selected && picked.has(selected)) { setSelected(null); setSelectedBatch(null); }
      stopPicking();
      void load(false);
      void refreshUsage();
    } catch (e) {
      setBulkNote(errorText(e));
    } finally {
      setDeleting(false);
    }
  };

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

  useEffect(() => { if (visible) void refreshUsage(); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <Button variant="ghost" size="sm" icon onClick={() => { void load(false); void refreshUsage(); }} loading={loading && loaded} aria-label="Refresh"><RefreshCw size={14} /></Button>
          {usage && (
            <Menu align="end" trigger={<Button variant="ghost" size="sm" icon aria-label="More: storage and clean up"><MoreHorizontal size={15} /></Button>}>
              <MenuLabel>Storage · {formatBytes(usage.bytes)}</MenuLabel>
              <MenuItem onSelect={() => { setBulkNote(null); setPicking(true); }}><span className="flex items-center gap-2"><ListChecks size={13} /> Select…</span></MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => setCleanupOpen(true)}><span className="flex items-center gap-2"><HardDrive size={13} /> Clean up…</span></MenuItem>
            </Menu>
          )}
        </div>
        {picking && (
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-accent/[0.06] px-5 py-2" role="toolbar" aria-label="Selected artifacts">
            <span className="text-sm text-ink">{picked.size ? `${picked.size} selected · ${formatBytes(pickedBytes)}` : "Select artifacts to delete"}</span>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(items.map((x) => x.id)))} disabled={!items.length}>Select all shown</Button>
            {picked.size > 0 && <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>}
            <span className="flex-1" />
            <ConfirmButton size="sm" variant="secondary" disabled={!picked.size || deleting} confirmLabel={`Delete ${picked.size}?`} onConfirm={() => void deletePicked()}>
              <Trash2 size={13} /> Delete
            </ConfirmButton>
            <Button size="sm" variant="ghost" onClick={stopPicking}>Done</Button>
          </div>
        )}
        {bulkNote && !picking && (
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-1.5 text-xs text-accent" role="status">
            <span className="flex-1">{bulkNote}</span>
            <button onClick={() => setBulkNote(null)} className="text-ink4 hover:text-ink" aria-label="Dismiss"><X size={12} /></button>
          </div>
        )}
        <CleanupDialog open={cleanupOpen} onOpenChange={setCleanupOpen} onChanged={() => { void load(false); void refreshUsage(); setSelected(null); setSelectedBatch(null); }} />
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

        <OutputFolder visible={visible} onTidied={() => void load(false)} />
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
            {entries.map((e) => {
              const a = e.items[0];
              const batch = e.items.length > 1;
              const isPicked = picking && e.items.every((x) => picked.has(x.id));
              const on = picking ? isPicked : batch ? e.items.some((x) => x.id === selected) : selected === a.id;
              const open = () => (picking ? togglePick(e) : select(e));
              return (
                <div key={e.id} className={cx("group flex flex-col overflow-hidden rounded-xl border bg-surface text-left transition-colors", on ? "border-accent/60" : "border-line hover:border-ink/25")}>
                  <button onClick={open} aria-pressed={picking ? isPicked : undefined} className="relative aspect-[4/3] w-full overflow-hidden" aria-label={picking ? `Select ${batch ? `${e.items.length} images` : a.name}` : batch ? `Open ${e.items.length} images` : `Open ${a.name}`}>
                    {picking && (
                      <span className={cx("absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-md border", isPicked ? "border-accent bg-accent text-white" : "border-ink/30 bg-surface/90")} aria-hidden="true">
                        {isPicked && <Check size={12} strokeWidth={3} />}
                      </span>
                    )}
                    {batch ? <BatchCover items={e.items} /> : <ArtifactThumb id={a.id} kind={a.kind} name={a.name} />}
                    {batch && <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-surface/90 px-1.5 py-0.5 text-2xs text-ink2"><Layers size={10} />{e.items.length}</span>}
                  </button>
                  <div className="flex flex-col gap-0.5 px-2.5 py-2">
                    <button onClick={open} className="truncate text-left text-sm text-ink" title={batch ? a.prompt ?? a.name : a.name}>
                      {batch ? (a.prompt ?? `${e.items.length} images`) : a.name}
                    </button>
                    <span className="text-2xs text-ink4">{batch ? `${e.items.length} images · ${formatBytes(e.items.reduce((n, x) => n + x.size, 0))}` : formatBytes(a.size)} · {when(a.createdAt)}</span>
                    {a.threadExists && a.threadTitle && (
                      <button onClick={() => setThread({ id: a.threadId, title: a.threadTitle! })} className="truncate text-left text-2xs text-ink3 hover:text-ink hover:underline" title="Only this conversation's artifacts">
                        {a.threadTitle}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div ref={sentinel} className="h-8" />
          {loading && loaded && <div className="flex justify-center py-3"><Spinner size={14} /></div>}
        </div>
      </div>

      {fullscreen && selectedBatch && (
        <Lightbox
          items={selectedBatch.map((x) => ({ ...x, path: x.originalPath }))}
          index={batchIndex}
          onIndex={(i) => setSelected(selectedBatch[i].id)}
          onClose={() => setFullscreen(false)}
        />
      )}
      {selected && (
        <aside className="flex w-[46%] min-w-[380px] max-w-[720px] shrink-0 flex-col border-l border-line bg-soft">
          <div className="flex h-[52px] items-center gap-2 px-3" data-tauri-drag-region>
            {selectedBatch && (
              <>
                <Button size="sm" variant="ghost" icon onClick={() => step(-1)} aria-label="Previous"><ChevronLeft size={15} /></Button>
                <span className="font-mono text-xs text-ink3" data-tauri-drag-region>{batchIndex + 1} / {selectedBatch.length}</span>
                <Button size="sm" variant="ghost" icon onClick={() => step(1)} aria-label="Next"><ChevronRight size={15} /></Button>
              </>
            )}
            <span className="flex-1" data-tauri-drag-region />
            {selectedBatch && selectedBatch.every((x) => x.kind === "image") && (
              <Button size="sm" variant="ghost" icon onClick={() => setFullscreen(true)} aria-label="Full screen"><Maximize2 size={14} /></Button>
            )}
            <Button size="sm" variant="ghost" icon onClick={() => { setSelected(null); setSelectedBatch(null); }} aria-label="Close preview"><X size={15} /></Button>
          </div>
          {selectedBatch && (
            <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-2" aria-label="Images in this batch">
              {selectedBatch.map((x) => (
                <button key={x.id} onClick={() => setSelected(x.id)} aria-pressed={x.id === selected} aria-label={`Show ${x.name}`}
                  className={cx("h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2", x.id === selected ? "border-accent" : "border-transparent opacity-70 hover:opacity-100")}>
                  <ArtifactThumb id={x.id} kind={x.kind} name={x.name} />
                </button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1">
            <ArtifactViewer key={selected} id={selected} onOpenThread={openConversation}
              onDeleted={() => {
                const rest = selectedBatch?.filter((x) => x.id !== selected) ?? [];
                setItems((cur) => cur.filter((x) => x.id !== selected));
                // Deleting one of a batch moves to the next one; the last one closes it.
                setSelected(rest[0]?.id ?? null);
                setSelectedBatch(rest.length > 1 ? rest : null);
                void load(false);
                void refreshUsage();
              }} />
          </div>
        </aside>
      )}
    </div>
  );
}
