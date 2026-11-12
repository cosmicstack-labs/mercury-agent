import * as RadixDialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Info, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { artifactBlobUrl, type ArtifactRef } from "~/api/artifacts";
import { cx } from "~/lib/cx";

/* ═══════════════════════════════════════════════════════════════
   Pictures, full screen, one at a time: arrows, ← → keys and a swipe go
   through a batch, a strip of thumbnails jumps to any of them. The
   backdrop is the picture itself, blurred and saturated, so each one
   brings its own colour. Esc or a click outside closes it.
   ═══════════════════════════════════════════════════════════════ */

function useBlob(id: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setUrl(null);
    void artifactBlobUrl(id).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [id]);
  return url;
}

function Thumb({ a, on, onClick }: { a: ArtifactRef; on: boolean; onClick: () => void }) {
  const url = useBlob(a.id);
  return (
    <button onClick={onClick} aria-label={`Show ${a.name}`} aria-current={on}
      className={cx("h-14 w-14 shrink-0 overflow-hidden rounded-lg ring-2 transition-all duration-200", on ? "scale-105 ring-white" : "opacity-55 ring-transparent hover:opacity-90")}>
      {url && <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />}
    </button>
  );
}

export function Lightbox({ items, index, onIndex, onClose, onDetails }: {
  items: ArtifactRef[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Open the full viewer (save, copy path, delete) for the one showing. */
  onDetails?: (id: string) => void;
}) {
  const a = items[index];
  const url = useBlob(a?.id);
  const many = items.length > 1;
  const go = (d: number) => onIndex((index + d + items.length) % items.length);
  const strip = useRef<HTMLDivElement>(null);
  const swipe = useRef<number | null>(null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!many) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  // Keep the current thumbnail in view.
  useEffect(() => {
    strip.current?.children[index]?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [index]);

  if (!a) return null;
  return (
    <RadixDialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black animate-fade-in" />
        <RadixDialog.Content
          className="fixed inset-0 z-50 flex flex-col outline-none animate-fade-in"
          aria-describedby={undefined}
          onPointerDown={(e) => { swipe.current = e.clientX; }}
          onPointerUp={(e) => {
            const from = swipe.current;
            swipe.current = null;
            if (from == null || !many) return;
            const dx = e.clientX - from;
            if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
          }}
        >
          <RadixDialog.Title className="sr-only">{a.name}</RadixDialog.Title>
          {/* The picture's own colours, behind it. */}
          {url && <img key={`bg-${a.id}`} src={url} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-60 blur-3xl saturate-150 animate-fade-in" />}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/40 via-black/10 to-black/60" aria-hidden="true" />

          <div className="relative flex items-center gap-3 px-4 pt-4 text-white">
            {many && <span className="rounded-full bg-black/35 px-2.5 py-1 font-mono text-xs backdrop-blur">{index + 1} / {items.length}</span>}
            <span className="min-w-0 flex-1 truncate text-sm text-white/80" title={a.prompt ?? a.name}>{a.prompt ?? a.name}</span>
            {onDetails && (
              <button onClick={() => onDetails(a.id)} className="flex h-9 w-9 items-center justify-center rounded-full bg-black/35 backdrop-blur hover:bg-black/55" aria-label="Details: save, copy path, delete">
                <Info size={16} />
              </button>
            )}
            <RadixDialog.Close className="flex h-9 w-9 items-center justify-center rounded-full bg-black/35 backdrop-blur hover:bg-black/55" aria-label="Close">
              <X size={17} />
            </RadixDialog.Close>
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center px-16 py-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            {url
              ? <img key={a.id} src={url} alt={a.name} className="media-reveal max-h-full max-w-full rounded-xl object-contain shadow-2xl" draggable={false} />
              : <div className="h-16 w-16 animate-pulse rounded-full bg-white/10" />}
            {many && (
              <>
                <button onClick={() => go(-1)} aria-label="Previous image"
                  className="absolute left-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur transition hover:scale-105 hover:bg-black/55">
                  <ChevronLeft size={22} />
                </button>
                <button onClick={() => go(1)} aria-label="Next image"
                  className="absolute right-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur transition hover:scale-105 hover:bg-black/55">
                  <ChevronRight size={22} />
                </button>
              </>
            )}
          </div>

          {many && (
            <div ref={strip} className="relative mx-auto flex max-w-full gap-2 overflow-x-auto px-4 pb-5 pt-1">
              {items.map((x, i) => <Thumb key={x.id} a={x} on={i === index} onClick={() => onIndex(i)} />)}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
