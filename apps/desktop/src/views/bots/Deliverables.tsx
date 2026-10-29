import { Copy, Download, FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "~/api/mercury";
import { apiUrl, authHeaders } from "~/api/client";
import type { Deliverable } from "~/api/types";
import { Button } from "~/components/ui/Button";
import { Badge, Empty, Spinner } from "~/components/ui/bits";
import { ConfirmButton, SearchField } from "~/components/ui/kit";
import { BotAvatar } from "~/components/BotAvatar";
import { Markdown } from "~/components/Markdown";
import { cx } from "~/lib/cx";

/**
 * Deliverables: the files bots produced. For a fleet lead, the whole
 * fleet's files (lead + every crew member), each marked with who made it;
 * for one bot, only its own. List on the left, the file on the right.
 */
export function Deliverables({ bots }: { bots: Array<{ id: string; name: string; hasAvatar?: boolean }> }) {
  const [items, setItems] = useState<Deliverable[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const ids = bots.map((b) => b.id).join(",");

  async function load() {
    setLoading(true);
    const all = await Promise.all(bots.map((b) => api.bots.outputs(b.id).then((r) => r.outputs).catch(() => [] as Deliverable[])));
    const merged = all.flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
    setItems(merged);
    setLoading(false);
  }
  useEffect(() => { setSelected(null); void load(); }, [ids]);

  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [ids]);
  const q = query.trim().toLowerCase();
  const shown = items.filter((d) => !q || d.name.toLowerCase().includes(q));
  const current = shown.find((d) => key(d) === selected) ?? shown[0] ?? null;

  if (loading) return <div className="flex h-40 items-center justify-center text-ink3"><Spinner size={18} /></div>;
  if (items.length === 0) return <Empty title="No deliverables yet" body={bots.length > 1 ? "Nothing from this fleet so far." : "Nothing from this bot so far."} />;

  return (
    <div className="flex min-h-[420px] gap-4">
      <div className="flex w-[300px] shrink-0 flex-col gap-2">
        <SearchField value={query} onChange={setQuery} placeholder={`Search ${items.length} files`} />
        <div className="flex max-h-[560px] flex-col gap-1 overflow-y-auto pr-1">
          {shown.map((d) => {
            const bot = byId.get(d.botId);
            const active = current && key(current) === key(d);
            return (
              <button key={key(d)} onClick={() => setSelected(key(d))} className={cx("flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left", active ? "bg-ink/[0.07]" : "hover:bg-ink/[0.05]")}>
                <FileText size={16} className="mt-0.5 shrink-0 text-ink3" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm text-ink">{d.name}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink4">
                    {bots.length > 1 && bot && <><BotAvatar id={bot.id} name={bot.name} hasAvatar={bot.hasAvatar} size={14} /> <span className="truncate">{bot.name}</span> ·</>}
                    {date(d.mtimeMs)} · {size(d.bytes)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {current ? <Preview d={current} onDeleted={() => void load()} /> : <Empty title="No file matches" />}
      </div>
    </div>
  );
}

function Preview({ d, onDeleted }: { d: Deliverable; onDeleted: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    setText(null); setError(null);
    api.bots.outputPreview(d.botId, d.name)
      .then((r) => { if (live) { setText(r.preview); setTruncated(r.truncated); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [d.botId, d.name]);

  async function download() {
    const res = await fetch(apiUrl(api.bots.outputDownloadPath(d.botId, d.name)), { headers: authHeaders() });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = d.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const isMarkdown = /\.(md|markdown|txt)$/i.test(d.name);
  return (
    <div className="flex h-full flex-col rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium text-ink">{d.name}</div>
          <div className="text-xs text-ink4">{date(d.mtimeMs)} · {size(d.bytes)} {d.final && <Badge tone="accent" className="ml-1">final</Badge>}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => { if (text) void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }} disabled={!text}><Copy size={14} /> {copied ? "Copied" : "Copy"}</Button>
        <Button size="sm" variant="ghost" onClick={() => void download()}><Download size={14} /> Download</Button>
        <ConfirmButton size="sm" confirmLabel="Delete?" onConfirm={() => void api.bots.deleteOutput(d.botId, d.name).then(onDeleted)}>Delete</ConfirmButton>
      </div>
      <div className="max-h-[560px] min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error && <p className="text-sm text-red">{error}</p>}
        {text === null && !error && <Spinner size={16} className="text-ink3" />}
        {text !== null && (isMarkdown ? <Markdown text={text} /> : <pre className="whitespace-pre-wrap font-mono text-xs text-ink" data-selectable>{text}</pre>)}
        {truncated && <p className="mt-3 text-xs text-ink4">Preview shows the first 64 KB. Download for the full file.</p>}
      </div>
    </div>
  );
}

function key(d: Deliverable): string {
  return `${d.botId}/${d.name}`;
}

export function date(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
