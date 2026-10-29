import { Copy, Download, FileText, FolderOpen, MessageSquareText, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { artifactBlobUrl, artifactText, artifactsApi, formatBytes, KIND_LABEL, type ArtifactItem, type ArtifactKind } from "~/api/artifacts";
import { Markdown } from "~/components/Markdown";
import { Button } from "~/components/ui/Button";
import { Badge, Spinner } from "~/components/ui/bits";
import { ConfirmButton } from "~/components/ui/kit";
import { useConnections } from "~/shell/connections";
import { isTauri } from "~/shell/tauri";
import { cx } from "~/lib/cx";
import { ArtifactIcon } from "./ArtifactCard";

/**
 * One artifact, previewed for its kind: an image, a video or audio player,
 * the PDF itself, rendered Markdown, text, a CSV table. Office files can't
 * be previewed here, so they offer saving and opening instead. Actions:
 * save a copy, show it in Finder, copy its path, open the conversation it
 * came from, delete Mercury's copy.
 */

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ArtifactViewer({ id, onOpenThread, onDeleted }: { id: string; onOpenThread?: (threadId: string) => void; onDeleted?: () => void }) {
  const [a, setA] = useState<ArtifactItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const local = useConnections((s) => s.connections.find((c) => c.id === s.activeId)?.kind === "local");

  useEffect(() => {
    let live = true;
    setA(null);
    setError(null);
    artifactsApi.get(id).then((x) => { if (live) setA(x); }).catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [id]);

  async function saveAs() {
    if (!a) return;
    setNote(null);
    try {
      if (isTauri && local) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const dest = await save({ defaultPath: a.name, title: `Save ${a.name}` });
        if (!dest) return;
        await artifactsApi.exportTo(a.id, dest);
        setNote({ text: `Saved to ${dest}`, ok: true });
      } else {
        const url = await artifactBlobUrl(a.id);
        if (!url) throw new Error("Couldn't load the file.");
        const link = document.createElement("a");
        link.href = url;
        link.download = a.name;
        link.click();
      }
    } catch (e) { setNote({ text: errorText(e), ok: false }); }
  }

  async function reveal() {
    if (!a) return;
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(a.originalPath);
    } catch (e) { setNote({ text: errorText(e), ok: false }); }
  }

  if (error) return <p className="p-6 text-sm text-red">{error}</p>;
  if (!a) return <div className="p-6"><Spinner size={16} /></div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <ArtifactIcon kind={a.kind} name={a.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><span className="truncate text-base font-medium text-ink" data-selectable>{a.name}</span><Badge>{KIND_LABEL[a.kind]}</Badge></div>
          <div className="mt-0.5 truncate font-mono text-xs text-ink3" title={a.originalPath} data-selectable>{a.originalPath}</div>
          <div className="text-xs text-ink4">{formatBytes(a.size)} · {new Date(a.createdAt).toLocaleString()}{a.threadTitle ? ` · from “${a.threadTitle}”` : ""}{!a.originalExists ? " · original moved or deleted (Mercury's copy is kept)" : ""}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-5 py-2">
        <Button size="sm" variant="primary" onClick={() => void saveAs()}><Download size={13} /> {isTauri && local ? "Save as…" : "Download"}</Button>
        {isTauri && local && a.originalExists && <Button size="sm" variant="ghost" onClick={() => void reveal()}><FolderOpen size={13} /> Show in Finder</Button>}
        <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(a.originalPath); setNote({ text: "Path copied.", ok: true }); }}><Copy size={13} /> Copy path</Button>
        {onOpenThread && a.threadExists && <Button size="sm" variant="ghost" onClick={() => onOpenThread(a.threadId)}><MessageSquareText size={13} /> Open conversation</Button>}
        <span className="flex-1" />
        <ConfirmButton size="sm" variant="ghost" confirmLabel="Delete Mercury's copy?" onConfirm={() => void artifactsApi.remove(a.id).then(() => onDeleted?.()).catch((e) => setNote({ text: errorText(e), ok: false }))}><Trash2 size={13} /></ConfirmButton>
      </div>
      {note && <p className={cx("px-5 pt-2 text-xs", note.ok ? "text-accent" : "text-red")}>{note.text}</p>}

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <Preview a={a} />
      </div>
    </div>
  );
}

function useBlob(id: string): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setFailed(false);
    artifactBlobUrl(id).then((u) => { if (!live) return; if (u) setUrl(u); else setFailed(true); });
    return () => { live = false; };
  }, [id]);
  return { url, failed };
}

function Preview({ a }: { a: ArtifactItem }) {
  const textual = a.kind === "text" || (a.kind === "document" && a.mime === "text/csv") || (a.kind === "file" && a.mime.startsWith("text/"));
  if (textual) return <TextPreview a={a} />;
  if (a.kind === "image" || a.kind === "video" || a.kind === "audio" || a.kind === "pdf") return <MediaPreview a={a} />;
  return <NoPreview kind={a.kind} />;
}

function MediaPreview({ a }: { a: ArtifactItem }) {
  const { url, failed } = useBlob(a.id);
  if (failed) return <p className="text-sm text-red">Couldn't load the file.</p>;
  if (!url) return <div className="flex items-center gap-2 text-sm text-ink3"><Spinner size={13} /> Loading {a.size > 20 * 1024 ** 2 ? `(${formatBytes(a.size)})` : ""}…</div>;
  if (a.kind === "image") return <img src={url} alt={a.name} className="mx-auto max-h-full max-w-full rounded-lg object-contain" />;
  if (a.kind === "video") return <video src={url} controls className="mx-auto max-h-full max-w-full rounded-lg bg-black" />;
  if (a.kind === "audio") return <audio src={url} controls className="w-full" />;
  return <iframe src={url} title={a.name} className="h-full min-h-[480px] w-full rounded-lg border border-line bg-white" />;
}

function TextPreview({ a }: { a: ArtifactItem }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let live = true; artifactText(a.id).then((t) => { if (live) setText(t); }).catch((e) => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [a.id]);
  if (error) return <p className="text-sm text-red">{error}</p>;
  if (text === null) return <Spinner size={13} />;
  if (a.mime === "text/markdown") return <div className="mx-auto max-w-[760px]" data-selectable><Markdown text={text} /></div>;
  if (a.mime === "text/csv") return <CsvTable text={text} />;
  return <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-ink" data-selectable>{text}</pre>;
}

/** The first 200 rows of a CSV as a table (quotes handled, enough for a preview). */
export function parseCsv(text: string, maxRows = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if ((cell || row.length) && rows.length < maxRows) { row.push(cell); rows.push(row); }
  return rows;
}

function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text);
  if (!rows.length) return <p className="text-sm text-ink3">Empty.</p>;
  const [head, ...body] = rows;
  return (
    <div className="overflow-auto rounded-lg border border-line">
      <table className="min-w-full text-left text-xs">
        <thead className="bg-soft"><tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap border-b border-line px-2.5 py-1.5 font-medium text-ink">{h}</th>)}</tr></thead>
        <tbody>{body.map((r, i) => <tr key={i} className="border-b border-line last:border-0">{r.map((c, j) => <td key={j} className="whitespace-nowrap px-2.5 py-1 text-ink2">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function NoPreview({ kind }: { kind: ArtifactKind }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <FileText size={28} className="text-ink4" />
      <p className="text-sm text-ink3">{kind === "document" ? "Office files can't be previewed here." : "No preview for this kind of file."} Save it or show it in Finder to open it.</p>
    </div>
  );
}
