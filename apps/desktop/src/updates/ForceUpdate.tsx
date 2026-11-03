import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/Button";
import { Markdown } from "~/components/Markdown";
import { cx } from "~/lib/cx";
import { desktop as native, isTauri } from "~/shell/tauri";
import type { ForceState } from "./selectors";
import { useUpdates } from "./store";
import { DesktopRow, RELEASES_URL, ServerRow } from "./UpdatesPanel";

/**
 * A required update (security or compatibility): a full screen that Esc
 * and clicks outside don't close. The way out is deliberate: "Continue
 * without updating" asks you to tick every risk first, and holds until the
 * app restarts or for 24 hours. Meanwhile the top-right button stays red.
 * The window can still be minimised.
 */
const RISKS = [
  "I understand this version has a known problem that the update fixes.",
  "Mercury may stop working with my servers or some features until I update.",
  "I'm responsible for anything exposed while I stay on this version.",
  "I'll update as soon as I can.",
];

export function ForceUpdate({ force }: { force: ForceState }) {
  const acknowledge = useUpdates((s) => s.acknowledge);
  const [skipping, setSkipping] = useState(false);
  const [ticks, setTicks] = useState<boolean[]>(RISKS.map(() => false));
  const item = force.item;
  const conn = item.connection;
  const security = force.required.severity === "security";
  const remote = conn?.kind === "remote";
  const serverInfo = useUpdates((s) => (conn ? s.servers[conn.id]?.info : null));

  // Swallow Escape so nothing underneath closes or acts.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const what = force.kind === "desktop" ? "Mercury Desktop" : `Mercury on ${item.name}`;
  const notes = item.release?.notes;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-bg/95 p-6 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="force-title">
      <div className="flex max-h-full w-[min(560px,100%)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl" data-tauri-drag-region>
        <div className="flex items-start gap-3 border-b border-line px-6 py-5">
          <span className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", security ? "bg-red/10 text-red" : "bg-amber/15 text-amber")}><ShieldAlert size={20} /></span>
          <div className="min-w-0">
            <h2 id="force-title" className="text-md font-semibold text-ink">{security ? `${what} needs a security update` : `${what} needs an update`}</h2>
            <p className="mt-1 text-sm text-ink2">
              {force.required.reason || (security ? "This version has a security problem that's fixed in the update." : "This version is no longer supported.")}
              {" "}Version {item.current || "?"} is below {force.required.version}, the lowest still supported.
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {notes && (
            <div className="border-b border-line px-6 py-4">
              <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-ink4">What's new in {item.next ?? item.release?.version}</div>
              <div className="max-h-56 overflow-y-auto text-sm" data-selectable><Markdown text={notes} /></div>
            </div>
          )}
          {/* The same row as the panel: progress, retry, rollback, approval. */}
          {force.kind === "desktop" ? <DesktopRow item={item} compact /> : <ServerRow item={item} compact />}
          {force.kind === "server" && remote && serverInfo && serverInfo.canSelfUpdate && (
            <p className="px-6 pb-3 text-xs text-ink3">Updating a remote Mercury needs its owner's approval: they get a code on their messaging app or that computer.</p>
          )}
          {force.kind === "server" && remote && !serverInfo?.canSelfUpdate && (
            <p className="px-6 pb-3 text-xs text-ink3">Ask the owner of {item.name} to run <code className="font-mono">mercury upgrade</code> on that computer.</p>
          )}
          {force.kind === "desktop" && !isTauri && <p className="px-6 pb-3 text-xs text-ink3">Download the new version from <button className="text-accent hover:underline" onClick={() => void native.openExternal(RELEASES_URL)}>the releases page</button>.</p>}

          {skipping && (
            <div className="border-t border-line bg-ink/[0.02] px-6 py-4">
              <p className="text-sm font-medium text-ink">Continue without updating?</p>
              <p className="mt-0.5 text-xs text-ink3">Tick each one to continue. This holds until Mercury Desktop restarts, or for 24 hours.</p>
              <div className="mt-3 flex flex-col gap-2">
                {RISKS.map((r, i) => (
                  <label key={r} className="flex cursor-pointer items-start gap-2.5 text-sm text-ink2">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--red))]" checked={ticks[i]} onChange={(e) => setTicks(ticks.map((t, j) => (j === i ? e.target.checked : t)))} />
                    {r}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-3">
          {!skipping
            ? <button className="text-xs text-ink4 hover:text-ink3 hover:underline" onClick={() => setSkipping(true)}>Continue without updating</button>
            : <button className="text-xs text-ink4 hover:text-ink3 hover:underline" onClick={() => { setSkipping(false); setTicks(RISKS.map(() => false)); }}>Back</button>}
          {skipping && (
            <Button size="sm" variant="danger" disabled={!ticks.every(Boolean)} onClick={() => acknowledge(force.key)}>Continue anyway</Button>
          )}
        </div>
      </div>
    </div>
  );
}
