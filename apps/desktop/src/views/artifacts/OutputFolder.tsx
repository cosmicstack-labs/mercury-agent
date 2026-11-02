import { FolderInput, FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { artifactsApi } from "~/api/artifacts";
import { Button } from "~/components/ui/Button";
import { useConnections } from "~/shell/connections";
import { isTauri } from "~/shell/tauri";

type Folder = Awaited<ReturnType<typeof artifactsApi.folder>>;

const DISMISSED = "mercury.artifacts.tidy.dismissed";
function dismissedFor(): string {
  try { return localStorage.getItem(DISMISSED) ?? ""; } catch { return ""; }
}

/**
 * Where Mercury keeps what it makes (~/mercury-artifacts: Research/ and a
 * folder per chat), one click from Finder. And, once, an offer to move the
 * files Mercury left loose in your home folder before that folder existed
 * into their chats' folders. Only files Mercury knows it made; never anything else.
 */
export function OutputFolder({ visible, onTidied }: { visible: boolean; onTidied: () => void }) {
  const local = useConnections((s) => s.connections.find((c) => c.id === s.activeId)?.kind === "local");
  const [folder, setFolder] = useState<Folder | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [dismissed, setDismissed] = useState(dismissedFor);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    artifactsApi.folder().then((f) => { if (live) setFolder(f); }).catch(() => { /* older Mercury */ });
    return () => { live = false; };
  }, [visible]);

  if (!folder) return null;
  const strayKey = folder.strays.map((s) => s.id).sort().join(",");
  const offer = local && folder.strays.length > 0 && dismissed !== strayKey;

  async function open() {
    const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
    try {
      await openPath(folder!.path);
    } catch {
      // A folder set somewhere else than ~/mercury-artifacts: show it in Finder instead.
      try { await revealItemInDir(folder!.path); } catch (e) { setNote({ text: e instanceof Error ? e.message : String(e), ok: false }); }
    }
  }

  async function tidy() {
    setBusy(true);
    setNote(null);
    try {
      const r = await artifactsApi.tidy();
      setNote(r.failed.length
        ? { text: `Moved ${r.moved.length}; couldn't move ${r.failed.map((f) => `${f.name} (${f.error})`).join(", ")}.`, ok: false }
        : { text: `Moved ${r.moved.length} file${r.moved.length === 1 ? "" : "s"} into ${folder!.display}.`, ok: true });
      setFolder(await artifactsApi.folder());
      onTidied();
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(false);
    }
  }

  function notNow() {
    try { localStorage.setItem(DISMISSED, strayKey); } catch { /* per-device nicety */ }
    setDismissed(strayKey);
  }

  const names = folder.strays.slice(0, 3).map((s) => s.name).join(", ") + (folder.strays.length > 3 ? ` and ${folder.strays.length - 3} more` : "");

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-line px-5 py-2">
      <div className="flex items-center gap-2 text-xs text-ink3">
        <FolderOpen size={13} className="shrink-0 text-ink4" aria-hidden="true" />
        <span className="min-w-0 truncate">
          Saved in <span className="font-mono text-ink2" data-selectable title={folder.path}>{folder.display}</span>
          <span className="text-ink4">: Research, and a folder for each chat</span>
        </span>
        <span className="flex-1" />
        {isTauri && local && (folder.exists
          ? <Button size="sm" variant="ghost" onClick={() => void open()}>Open folder</Button>
          : <span className="text-ink4">made when Mercury saves its first file</span>)}
      </div>
      {offer && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-soft px-3 py-2">
          <FolderInput size={14} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-sm text-ink2">
            {folder.strays.length} file{folder.strays.length === 1 ? "" : "s"} Mercury made {folder.strays.length === 1 ? "is" : "are"} loose in your home folder ({names}). Move {folder.strays.length === 1 ? "it" : "them"} into {folder.strays.length === 1 ? "its chat's folder" : "their chats' folders"}?
          </span>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void tidy()}>Move {folder.strays.length === 1 ? "it" : "them"}</Button>
          <Button size="sm" variant="ghost" onClick={notNow} aria-label="Not now"><X size={13} /> Not now</Button>
        </div>
      )}
      {note && <p className={note.ok ? "text-xs text-accent" : "text-xs text-red"}>{note.text}</p>}
    </div>
  );
}
