import { Plus } from "lucide-react";
import { FieldMic } from "~/components/dictation/Dictation";
import { useCallback, useEffect, useRef, useState } from "react";
import { brain, MEMORY_TYPES, type BrainMemory } from "~/api/brain";
import { Button } from "~/components/ui/Button";
import { Badge, Empty, Spinner } from "~/components/ui/bits";
import { ConfirmButton, SearchField } from "~/components/ui/kit";
import { Menu, MenuItem } from "~/components/ui/Menu";
import { cx } from "~/lib/cx";

const PAGE = 40;

/**
 * Everything Mercury believes about you, newest first, a page at a time
 * (the next page loads as you scroll). Search runs on the runtime's full
 * text index. Each memory can be edited in place or forgotten.
 */
export function Memories({ focusId }: { focusId?: string | null }) {
  const [items, setItems] = useState<BrainMemory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const searching = q.trim().length > 1;

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const r = await brain.memories({ limit: PAGE, offset });
      setItems((cur) => (offset === 0 ? r.memories : [...cur, ...r.memories.filter((m) => !cur.some((c) => c.id === m.id))]));
      setTotal(r.total);
    } catch { /* keep what we have */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!searching) { void loadPage(0); return; }
    const t = setTimeout(() => {
      setLoading(true);
      void brain.search(q.trim(), 60).then((r) => { setItems(r.memories); setTotal(r.memories.length); }).finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, searching, loadPage]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || searching) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting) && !loading && items.length < total) void loadPage(items.length); }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, total, loading, searching, loadPage]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-6 pb-3 pt-4">
        <SearchField value={q} onChange={setQ} placeholder="Search everything Mercury knows" className="w-[360px]" />
        <span className="text-sm text-ink3">{searching ? `${items.length} found` : `${items.length} of ${total}`}</span>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => setAdding((a) => !a)}><Plus size={14} /> Add a memory</Button>
      </div>
      {adding && <AddMemory onDone={(m) => { setAdding(false); if (m) setItems((cur) => [m, ...cur]); }} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {items.length === 0 && !loading && <Empty title={searching ? "Nothing matches" : "Nothing remembered yet"} />}
        <div className="flex flex-col gap-2">
          {items.map((m) => <MemoryRow key={m.id} m={m} focused={focusId === m.id} onRemoved={() => setItems((cur) => cur.filter((x) => x.id !== m.id))} onSaved={(u) => setItems((cur) => cur.map((x) => (x.id === u.id ? u : x)))} />)}
        </div>
        <div ref={sentinel} className="h-8">{loading && <Spinner size={14} className="text-ink3" />}</div>
      </div>
    </div>
  );
}

function MemoryRow({ m, focused, onRemoved, onSaved }: { m: BrainMemory; focused: boolean; onRemoved: () => void; onSaved: (m: BrainMemory) => void }) {
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(m.summary);
  const [detail, setDetail] = useState(m.detail ?? "");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [focused]);

  async function save() {
    setBusy(true);
    try {
      await brain.updateMemory(m.id, { summary: summary.trim(), detail: detail.trim() || null });
      onSaved({ ...m, summary: summary.trim(), detail: detail.trim() || null, updatedAt: Date.now() });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className={cx("group rounded-xl border bg-surface px-4 py-3", focused ? "border-accent/60" : "border-line")}>
      <div className="flex items-center gap-2 text-xs text-ink4">
        <Badge>{m.type}</Badge>
        {m.evidenceKind === "owner" && <Badge tone="accent">you said</Badge>}
        <span>{new Date(m.updatedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>
        <span>· confidence {Math.round(m.confidence * 100)}%</span>
        <span className="flex-1" />
        {!editing && (
          <span className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
            <ConfirmButton size="sm" confirmLabel="Forget?" onConfirm={() => void brain.deleteMemory(m.id).then(onRemoved)}>Forget</ConfirmButton>
          </span>
        )}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="relative"><textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} className="w-full rounded-md border border-line bg-bg py-2 pl-3 pr-10 text-base text-ink focus:border-accent/60" aria-label="Memory" /><FieldMic value={summary} onChange={setSummary} /></div>
          <div className="relative"><textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={2} placeholder="Detail (optional)" className="w-full rounded-md border border-line bg-bg py-2 pl-3 pr-10 text-sm text-ink2 focus:border-accent/60" aria-label="Detail" /><FieldMic value={detail} onChange={setDetail} /></div>
          <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button><Button size="sm" variant="primary" loading={busy} disabled={!summary.trim()} onClick={() => void save()}>Save</Button></div>
        </div>
      ) : (
        <>
          <p className="mt-1.5 text-base leading-relaxed text-ink" data-selectable>{m.summary}</p>
          {m.detail && <p className="mt-1 text-sm text-ink3" data-selectable>{m.detail}</p>}
        </>
      )}
    </div>
  );
}

function AddMemory({ onDone }: { onDone: (m: BrainMemory | null) => void }) {
  const [type, setType] = useState<string>("preference");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-6 mb-3 flex items-center gap-2 rounded-xl border border-line bg-surface p-3">
      <Menu trigger={<button className="h-9 rounded-md border border-line px-3 text-sm capitalize text-ink">{type}</button>}>
        {MEMORY_TYPES.map((t) => <MenuItem key={t} selected={t === type} onSelect={() => setType(t)}>{t}</MenuItem>)}
      </Menu>
      <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Something Mercury should know…" className="h-9 flex-1 rounded-md border border-line bg-bg px-3 text-sm text-ink focus:border-accent/60" autoFocus
        onKeyDown={(e) => { if (e.key === "Enter" && summary.trim()) { setBusy(true); void brain.addMemory({ type, summary: summary.trim() }).then((m) => onDone(m)).finally(() => setBusy(false)); } }} />
      <Button size="md" variant="primary" loading={busy} disabled={!summary.trim()} onClick={() => { setBusy(true); void brain.addMemory({ type, summary: summary.trim() }).then((m) => onDone(m)).finally(() => setBusy(false)); }}>Remember</Button>
      <Button size="md" variant="ghost" onClick={() => onDone(null)}>Cancel</Button>
    </div>
  );
}
