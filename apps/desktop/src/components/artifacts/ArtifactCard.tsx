import { File, FileImage, FileText, FileVideo, Music, Presentation, Sheet, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { artifactBlobUrl, formatBytes, KIND_LABEL, type ArtifactKind, type ArtifactRef } from "~/api/artifacts";
import { Dialog } from "~/components/ui/Dialog";
import { cx } from "~/lib/cx";
import { ArtifactViewer } from "./ArtifactViewer";

/**
 * Artifacts as cards: a real thumbnail for images, an icon for the rest
 * (videos aren't downloaded just to draw a tile). The strip under a reply
 * opens each one in the previewer.
 */

const TONE: Record<ArtifactKind, string> = {
  image: "bg-cyan/15 text-cyan", video: "bg-accent/15 text-accent", audio: "bg-amber/15 text-amber", pdf: "bg-red/12 text-red",
  document: "bg-ink/[0.07] text-ink2", text: "bg-ink/[0.07] text-ink2", file: "bg-ink/[0.07] text-ink3",
};

export function ArtifactIcon({ kind, name, size = 32 }: { kind: ArtifactKind; name: string; size?: number }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const Icon = kind === "image" ? FileImage : kind === "video" ? FileVideo : kind === "audio" ? Music : kind === "pdf" ? FileText
    : kind === "document" ? (/^(xlsx?|ods|numbers|csv)$/.test(ext) ? Sheet : /^(pptx?|odp|key)$/.test(ext) ? Presentation : FileText)
    : kind === "text" ? FileText : File;
  return (
    <span className={cx("flex shrink-0 items-center justify-center rounded-lg", TONE[kind])} style={{ width: size, height: size }} aria-hidden="true">
      <Icon size={Math.round(size * 0.5)} />
    </span>
  );
}

export function ArtifactThumb({ id, kind, name, className }: { id: string; kind: ArtifactKind; name: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (kind !== "image") return;
    let live = true;
    void artifactBlobUrl(id).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [id, kind]);
  if (kind === "image" && url) return <img src={url} alt={name} className={cx("h-full w-full object-cover", className)} loading="lazy" draggable={false} />;
  return (
    <span className={cx("relative flex h-full w-full items-center justify-center bg-soft", className)}>
      <ArtifactIcon kind={kind} name={name} size={40} />
      {kind === "video" && <Play size={14} className="absolute bottom-2 right-2 fill-current text-ink3" />}
      <span className="absolute left-2 top-2 rounded bg-surface/90 px-1.5 font-mono text-2xs uppercase text-ink3">{name.split(".").pop()}</span>
    </span>
  );
}

/** Under a reply: what this turn made, one tap from a preview. */
/** Made by a media model (generate_image, _video, _music, _speech): shown large and playable. */
function isGenerated(a: ArtifactRef): boolean {
  return !!a.tool?.startsWith("generate_") && (a.kind === "image" || a.kind === "video" || a.kind === "audio");
}

/**
 * A generated picture, clip or sound in the reply itself, where its
 * placeholder was (MediaSkeleton); `fresh` reveals it from soft to sharp.
 */
function GeneratedMedia({ a, fresh, onOpen }: { a: ArtifactRef; fresh: boolean; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void artifactBlobUrl(a.id).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [a.id]);
  if (a.kind === "audio") {
    return (
      <div className={cx("flex w-full max-w-[420px] flex-col gap-1.5 rounded-xl border border-line bg-surface px-3 py-2.5", fresh && "media-reveal")}>
        {url ? <audio src={url} controls preload="metadata" className="h-9 w-full" /> : <div className="h-9" />}
        <button onClick={onOpen} className="truncate text-left text-xs text-ink4 hover:text-ink2">{a.name} · {formatBytes(a.size)}</button>
      </div>
    );
  }
  if (a.kind === "video") {
    return (
      <div className={cx("w-full max-w-[520px] overflow-hidden rounded-xl border border-line bg-black", fresh && "media-reveal")}>
        {url ? <video src={url} controls playsInline preload="metadata" className="block max-h-[480px] w-full" /> : <div className="aspect-video" />}
      </div>
    );
  }
  return (
    <button onClick={onOpen} title={a.name} className={cx("block max-w-[380px] overflow-hidden rounded-xl border border-line bg-soft", fresh && "media-reveal")}>
      {url ? <img src={url} alt={a.name} className="block h-auto w-full" draggable={false} /> : <div className="aspect-square w-[380px] max-w-full" />}
    </button>
  );
}

export function ArtifactStrip({ items, onOpenThread, fresh = false }: { items: ArtifactRef[]; onOpenThread?: (threadId: string) => void; fresh?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return null;
  const media = items.filter(isGenerated);
  const rest = items.filter((a) => !isGenerated(a));
  return (
    <div className="mt-3 flex flex-col gap-2" aria-label="Artifacts">
      {media.length > 0 && (
        <div className={cx("grid gap-2", media.filter((a) => a.kind === "image").length > 1 ? "max-w-[520px] grid-cols-2" : "grid-cols-1")}>
          {media.map((a) => <GeneratedMedia key={a.id} a={a} fresh={fresh} onOpen={() => setOpen(a.id)} />)}
        </div>
      )}
      {rest.length > 0 && <div className="flex flex-wrap gap-2">
      {rest.map((a) => (
        <button key={a.id} onClick={() => setOpen(a.id)} title={a.path}
          className="group flex w-[220px] items-center gap-2.5 overflow-hidden rounded-xl border border-line bg-surface p-1.5 pr-3 text-left transition-colors hover:border-ink/25">
          <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg"><ArtifactThumb id={a.id} kind={a.kind} name={a.name} /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-ink">{a.name}</span>
            <span className="block text-xs text-ink4">{KIND_LABEL[a.kind]} · {formatBytes(a.size)}</span>
          </span>
        </button>
      ))}
      </div>}
      <Dialog open={!!open} onOpenChange={(o) => { if (!o) setOpen(null); }} title="Artifact" width={860}>
        {open && <div className="-m-5 h-[70vh]"><ArtifactViewer id={open} onOpenThread={onOpenThread ? (t) => { setOpen(null); onOpenThread(t); } : undefined} onDeleted={() => setOpen(null)} /></div>}
      </Dialog>
    </div>
  );
}
