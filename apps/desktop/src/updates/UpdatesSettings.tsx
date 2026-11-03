import { Laptop, Server } from "lucide-react";
import { Switch } from "~/components/ui/Switch";
import { Mono } from "~/components/ui/bits";
import { Button } from "~/components/ui/Button";
import { useConnections } from "~/shell/connections";
import { updatesNative } from "./native";
import { checkAll, checkAndUpdateAll, updateEverything, useUpdates, type WhatsNew } from "./store";
import { DesktopRow, ServerRow } from "./UpdatesPanel";
import { useUpdateView } from "./useUpdateView";

/** Settings → About: versions, check now, what's new, the two switches, every server. */
export function UpdatesSettings() {
  const { items, updatable } = useUpdateView();
  const manualCheck = useUpdates((s) => s.manualCheck);
  const updatingAll = useUpdates((s) => s.updatingAll);
  const prefs = useUpdates((s) => s.prefs);
  const setPrefs = useUpdates((s) => s.setPrefs);
  const desktop = useUpdates((s) => s.desktop);
  const servers = useUpdates((s) => s.servers);
  const manifest = useUpdates((s) => s.manifest);
  const checking = useUpdates((s) => s.checking);
  const showWhatsNew = useUpdates((s) => s.showWhatsNew);
  const connections = useConnections((s) => s.connections);
  const desktopItem = items.find((i) => i.kind === "desktop");
  const rel = manifest?.manifest?.desktop?.channels?.stable;

  function whatsNew() {
    const w: WhatsNew = { title: `Mercury Desktop ${desktop.current}`, version: desktop.current, notes: rel?.version === desktop.current ? rel.notes : null, notesUrl: rel?.version === desktop.current ? rel.notesUrl : null };
    showWhatsNew(w);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* One place for both: this app and every server it connects to. */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <span className="min-w-0 flex-1 text-sm">
          <span className="block text-ink">Updates</span>
          <span className="block text-xs text-ink3">
            {checking ? "Checking Mercury Desktop and your servers…"
              : updatable.length ? `${updatable.length} update${updatable.length > 1 ? "s" : ""} ready to install: ${updatable.map((i) => `${i.name} ${i.next}`).join(", ")}.`
              : manualCheck && Date.now() - manualCheck.at < 10 * 60_000 ? "Everything is up to date."
              : "Mercury Desktop and every server you connect to."}
          </span>
        </span>
        <Button size="sm" variant="secondary" loading={checking} onClick={() => void checkAll(true)}>Check for updates</Button>
        {updatable.length > 0
          ? <Button size="sm" variant="primary" loading={updatingAll} onClick={() => void updateEverything()}>{updatable.length > 1 ? "Update everything" : "Update"}</Button>
          : !checking && <Button size="sm" variant="ghost" onClick={() => void checkAndUpdateAll()}>Check and update</Button>}
      </div>

      <div className="rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3 text-sm">
          <Laptop size={15} className="text-ink3" />
          <span className="flex-1">Mercury Desktop</span>
          <Mono>{desktop.current || "dev"}</Mono>
        </div>
        {desktopItem ? <div className="border-t border-line"><DesktopRow item={desktopItem} /></div> : (
          <p className="border-t border-line px-4 py-2.5 text-xs text-ink3">
            {desktop.error && !desktop.available ? `Couldn't check: ${desktop.error}` : "Up to date."}
          </p>
        )}
        <div className="flex items-center gap-3 border-t border-line px-4 py-2.5">
          <button className="text-xs text-accent hover:underline" onClick={whatsNew}>What's new in {desktop.current || "this version"}</button>
          {manifest && !manifest.verified && manifest.manifest && <span className="text-xs text-amber">The update notice couldn't be verified, so it's ignored.</span>}
        </div>
      </div>

      <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
        <label className="flex items-center justify-between gap-4 px-4 py-3">
          <span>
            <span className="block text-sm text-ink">Download updates automatically</span>
            <span className="block text-xs text-ink3">In the background; nothing installs until you restart.</span>
          </span>
          <Switch checked={prefs.autoDownload} onCheckedChange={(v) => setPrefs({ autoDownload: v })} />
        </label>
        <label className="flex items-center justify-between gap-4 px-4 py-3">
          <span>
            <span className="block text-sm text-ink">Install a downloaded update when I quit</span>
            <span className="block text-xs text-ink3">The next start is the new version.</span>
          </span>
          <Switch checked={prefs.installOnQuit} onCheckedChange={(v) => { setPrefs({ installOnQuit: v }); void updatesNative.setInstallOnQuit(v); }} />
        </label>
      </div>

      <div className="rounded-lg border border-line bg-surface">
        <div className="px-4 pb-1 pt-3 text-2xs font-medium uppercase tracking-wider text-ink4">Servers</div>
        {connections.map((c) => {
          const e = servers[c.id];
          const item = items.find((i) => i.kind === "server" && i.connection?.id === c.id);
          return (
            <div key={c.id} className="border-t border-line first:border-t-0">
              <div className="flex items-center gap-2.5 px-4 py-2.5 text-sm">
                <Server size={14} className="text-ink3" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <Mono>{e?.info?.current ?? e?.version ?? (e?.error ? "offline" : "…")}</Mono>
              </div>
              {item ? <ServerRow item={item} compact /> : e && !e.error ? <p className="px-4 pb-2.5 text-xs text-ink3">Up to date.</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
