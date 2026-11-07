import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { apiUrl, authHeaders } from "~/api/client";
import type { MessageAttachment } from "~/api/types";
import { cx } from "~/lib/cx";

/**
 * Files on a message. Images are thumbnails that open full size; PDFs are a
 * file chip. Stored files come from the runtime with the Bearer token (an
 * <img> cannot send one), so they are fetched once into blob URLs.
 */

const blobs = new Map<string, Promise<string | null>>();

function useAuthedSrc(att: MessageAttachment): string | null {
  const [src, setSrc] = useState<string | null>(att.src ?? null);
  useEffect(() => {
    if (att.src || !att.url) return;
    let live = true;
    let hit = blobs.get(att.url);
    if (!hit) {
      hit = fetch(apiUrl(att.url), { headers: authHeaders() })
        .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
        .catch(() => null);
      blobs.set(att.url, hit);
    }
    void hit.then((u) => { if (live) setSrc(u); });
    return () => { live = false; };
  }, [att.src, att.url]);
  return src;
}

export function Attachments({ items, align = "start" }: { items: MessageAttachment[]; align?: "start" | "end" }) {
  const images = items.filter((a) => a.kind === "image");
  const docs = items.filter((a) => a.kind !== "image");
  return (
    <div className={cx("flex flex-col gap-2", align === "end" && "items-end")}>
      {images.length > 0 && (
        <div className={cx("grid gap-2", images.length === 1 ? "grid-cols-1" : "grid-cols-2")} style={{ maxWidth: images.length === 1 ? 360 : 440 }}>
          {images.map((a, i) => <ImageThumb key={`${a.url ?? a.name}-${i}`} att={a} single={images.length === 1} />)}
        </div>
      )}
      {docs.map((a, i) => (
        <span key={`${a.url ?? a.name}-${i}`} className="inline-flex max-w-[320px] items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-red/10 text-red"><FileText size={17} /></span>
          <span className="min-w-0">
            <span className="block truncate text-sm text-ink">{a.name}</span>
            <span className="block text-2xs uppercase text-ink4">{a.mime === "application/pdf" || a.name.toLowerCase().endsWith(".pdf") ? "PDF" : "File"}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

function ImageThumb({ att, single }: { att: MessageAttachment; single: boolean }) {
  const src = useAuthedSrc(att);
  const [open, setOpen] = useState(false);
  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Trigger asChild>
        <button className={cx("group relative overflow-hidden rounded-xl border border-line bg-raised", single ? "max-h-[320px]" : "aspect-square")} aria-label={`Open ${att.name}`}>
          {src ? (
            <img src={src} alt={att.name} className={cx("block h-full w-full transition-transform duration-200 group-hover:scale-[1.02]", single ? "max-h-[320px] object-contain" : "object-cover")} draggable={false} />
          ) : (
            <span className="flex h-40 w-full items-center justify-center text-xs text-ink4">{att.url ? "Loading…" : att.name}</span>
          )}
        </button>
      </RadixDialog.Trigger>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/80 animate-fade-in" />
        <RadixDialog.Content className="fixed inset-0 z-50 flex items-center justify-center p-10 outline-none animate-fade-in" onClick={() => setOpen(false)}>
          <RadixDialog.Title className="sr-only">{att.name}</RadixDialog.Title>
          {src && <img src={src} alt={att.name} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
