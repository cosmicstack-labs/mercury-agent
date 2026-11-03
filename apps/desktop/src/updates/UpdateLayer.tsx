import { Megaphone, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { Dialog } from "~/components/ui/Dialog";
import { Markdown } from "~/components/Markdown";
import { cx } from "~/lib/cx";
import { desktop as native, isTauri } from "~/shell/tauri";
import { useUi } from "~/app/store";
import { useConnections } from "~/shell/connections";
import { ForceUpdate } from "./ForceUpdate";
import { canDismiss } from "./logic";
import { checkAll, checkServer, initUpdates, useUpdates } from "./store";
import { RELEASES_URL } from "./UpdatesPanel";
import { useUpdateView } from "./useUpdateView";

const SIX_HOURS = 6 * 3_600_000;

/**
 * Mounted once at the root, whatever screen is up: checks on start, every
 * six hours and when the window comes back after six hours; shows a
 * required update over everything, and the "What's new" notes.
 */
export function UpdateLayer() {
  const { force } = useUpdateView();
  const connectionsLoaded = useConnections((s) => s.loaded);
  const activeId = useConnections((s) => s.activeId);

  useEffect(() => {
    if (!connectionsLoaded) return;
    let stop = false;
    void initUpdates().then(() => { if (!stop) void checkAll(); });
    const t = setInterval(() => void checkAll(), SIX_HOURS);
    const onFocus = () => void checkAll(); // throttled inside: only after six hours
    window.addEventListener("focus", onFocus);
    return () => { stop = true; clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [connectionsLoaded]);

  // Tray → "Check for Updates…": Settings → About, and check this app and every server.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let gone = false;
    void import("@tauri-apps/api/event").then(({ listen }) => listen("menu-check-updates", () => {
      useUi.getState().openSettings("about");
      void checkAll(true);
    })).then((u) => { if (gone) u(); else unlisten = u; });
    return () => { gone = true; unlisten?.(); };
  }, []);

  // A newly chosen connection is asked at once (it may need an update the others don't).
  useEffect(() => {
    const c = useConnections.getState().connections.find((x) => x.id === activeId);
    if (c && useUpdates.getState().loaded) void checkServer(c);
  }, [activeId]);

  return (
    <>
      {force && <ForceUpdate force={force} />}
      <WhatsNewDialog />
    </>
  );
}

function WhatsNewDialog() {
  const w = useUpdates((s) => s.whatsNew);
  const show = useUpdates((s) => s.showWhatsNew);
  return (
    <Dialog open={!!w} onOpenChange={(o) => { if (!o) show(null); }} title={w?.title ?? ""} description="What's new" width={560}>
      {w?.notes
        ? <div className="max-h-[60vh] overflow-y-auto text-sm" data-selectable><Markdown text={w.notes} /></div>
        : <p className="text-sm text-ink3">The release notes for {w?.version} are on the releases page.</p>}
      <div className="mt-4 flex justify-end">
        <button className="text-xs text-accent hover:underline" onClick={() => void native.openExternal(w?.notesUrl || RELEASES_URL)}>Full release notes</button>
      </div>
    </Dialog>
  );
}

/** Warnings and critical notices from the manifest, under the top bar. */
export function UpdateBanner() {
  const { banners } = useUpdateView();
  const dismiss = useUpdates((s) => s.dismissMessage);
  const m = banners[0];
  if (!m) return null;
  const critical = m.level === "critical";
  return (
    <div className={cx("flex items-center gap-3 border-b px-4 py-1.5 text-xs text-ink2", critical ? "border-red/30 bg-red/[0.07]" : "border-amber/30 bg-amber/[0.08]")} role={critical ? "alert" : "status"}>
      {critical ? <TriangleAlert size={13} className="shrink-0 text-red" /> : <Megaphone size={13} className="shrink-0 text-amber" />}
      <span className="min-w-0 flex-1 truncate"><span className="font-medium text-ink">{m.title}</span>{m.body ? ` · ${m.body}` : ""}</span>
      {m.link && <button className="shrink-0 text-accent hover:underline" onClick={() => void native.openExternal(m.link!.url)}>{m.link.label || "Read more"}</button>}
      {canDismiss(m) && <button onClick={() => dismiss(m.id)} className="text-ink4 hover:text-ink" aria-label="Dismiss"><X size={13} /></button>}
    </div>
  );
}
