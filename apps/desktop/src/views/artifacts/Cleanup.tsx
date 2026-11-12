import { HardDrive, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { artifactsApi, formatBytes, type ArtifactKind, type ArtifactUsage, type BulkDelete, type RemoveResult } from "~/api/artifacts";
import { Dialog } from "~/components/ui/Dialog";
import { ConfirmButton } from "~/components/ui/kit";
import { Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";

/**
 * Clean up: how much space what Mercury made takes, and ways to give it
 * back in one go — a kind at a time, everything older than a while, or
 * all of it. Counted the way the disk counts it (Mercury's copy is usually
 * a hard link to the file, so it isn't counted twice). Files Mercury wrote
 * into a project are never deleted from here; only its copy goes.
 */

const KIND_PLURAL: Record<ArtifactKind, string> = {
  image: "Images", video: "Videos", audio: "Audio", pdf: "PDFs", document: "Documents", text: "Notes", file: "Other files",
};
const KIND_COLOR: Record<ArtifactKind, string> = {
  image: "bg-cyan", video: "bg-accent", audio: "bg-amber", pdf: "bg-red", document: "bg-ink3", text: "bg-ink4", file: "bg-ink4",
};
const AGES = [7, 30, 90] as const;

export function freedText(r: RemoveResult): string {
  const what = `${r.removed} deleted`;
  const space = r.freed > 0 ? `, ${formatBytes(r.freed)} freed` : "";
  const kept = r.keptOriginals ? `. ${r.keptOriginals} file${r.keptOriginals === 1 ? "" : "s"} in your projects stayed where they are` : "";
  return `${what}${space}${kept}.`;
}

export function CleanupDialog({ open, onOpenChange, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; onChanged: () => void }) {
  const [usage, setUsage] = useState<ArtifactUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [age, setAge] = useState<(typeof AGES)[number]>(30);

  const refresh = () => artifactsApi.usage().then(setUsage).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    if (!open) return;
    setNote(null);
    setError(null);
    void refresh();
  }, [open]);

  const run = async (what: BulkDelete) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await artifactsApi.removeMany(what);
      setNote(freedText(r));
      onChanged();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const kinds = usage ? (Object.entries(usage.byKind) as Array<[ArtifactKind, { count: number; bytes: number }]>).filter(([, v]) => v.count > 0).sort((a, b) => b[1].bytes - a[1].bytes) : [];
  const total = usage?.bytes ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Clean up artifacts" description="Space taken by what Mercury made, and ways to free it." width={520}>
      {!usage && !error && <div className="flex justify-center py-8"><Spinner size={16} /></div>}
      {error && <p className="text-sm text-red">{error}</p>}
      {usage && (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink/[0.06] text-ink2"><HardDrive size={18} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-xl font-semibold text-ink">{formatBytes(total)}</div>
              <div className="text-xs text-ink3">
                {usage.count} artifact{usage.count === 1 ? "" : "s"}
                {usage.freeable < total ? ` · ${formatBytes(usage.freeable)} can be freed` : ""}
              </div>
            </div>
          </div>

          {total > 0 && (
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-ink/[0.06]" aria-hidden="true">
              {kinds.map(([k, v]) => <span key={k} className={KIND_COLOR[k]} style={{ width: `${(v.bytes / total) * 100}%` }} />)}
            </div>
          )}

          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {kinds.length === 0 && <li className="px-3 py-3 text-sm text-ink3">Nothing here yet.</li>}
            {kinds.map(([k, v]) => (
              <li key={k} className="flex items-center gap-3 px-3 py-2">
                <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", KIND_COLOR[k])} aria-hidden="true" />
                <span className="flex-1 text-sm text-ink">{KIND_PLURAL[k]}</span>
                <span className="font-mono text-2xs text-ink4">{v.count}</span>
                <span className="w-20 text-right text-sm text-ink2">{formatBytes(v.bytes)}</span>
                <ConfirmButton size="sm" variant="ghost" disabled={busy} confirmLabel={`Delete ${v.count}?`} onConfirm={() => void run({ kind: k })} aria-label={`Delete all ${KIND_PLURAL[k].toLowerCase()}`}>
                  <Trash2 size={13} />
                </ConfirmButton>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink2">Older than</span>
            <div className="flex rounded-md border border-line p-0.5">
              {AGES.map((d) => (
                <button key={d} onClick={() => setAge(d)} aria-pressed={age === d}
                  className={cx("rounded px-2 py-0.5 text-xs", age === d ? "bg-ink/[0.08] text-ink" : "text-ink3 hover:text-ink")}>
                  {d} days
                </button>
              ))}
            </div>
            <span className="flex-1" />
            <ConfirmButton size="sm" variant="secondary" disabled={busy || !usage.count} confirmLabel={`Delete everything older than ${age} days?`} onConfirm={() => void run({ olderThanDays: age })}>
              Delete older
            </ConfirmButton>
          </div>

          <div className="flex items-center gap-2 border-t border-line pt-4">
            <p className="flex-1 text-xs text-ink4">
              {usage.outside > 0
                ? `${usage.outside} artifact${usage.outside === 1 ? " is a file" : "s are files"} in your projects: deleting removes ${usage.outside === 1 ? "it" : "them"} from Mercury, the file${usage.outside === 1 ? "" : "s"} stay.`
                : "Deleting removes the files from your output folder too."}
            </p>
            <ConfirmButton size="sm" variant="ghost" disabled={busy || !usage.count} confirmLabel={`Delete all ${usage.count}?`} onConfirm={() => void run({ all: true })}>
              <Trash2 size={13} /> Delete all
            </ConfirmButton>
          </div>
          {busy && <p className="flex items-center gap-2 text-xs text-ink3"><Spinner size={11} /> Deleting…</p>}
          {note && <p className="text-xs text-accent" role="status">{note}</p>}
        </div>
      )}
    </Dialog>
  );
}
