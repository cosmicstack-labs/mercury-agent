import { AlertTriangle, ArrowUpCircle, CheckCircle2, ChevronDown, ChevronRight, KeyRound, Laptop, RotateCcw, Server, ShieldAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/Button";
import { Markdown } from "~/components/Markdown";
import { cx } from "~/lib/cx";
import { useUi } from "~/app/store";
import { useRuntimeState } from "~/app/store";
import { desktop as native } from "~/shell/tauri";
import { formatBytes, MAX_FAILURES, timeLeft, type Urgency } from "./logic";
import type { UpdateItem } from "./selectors";
import { busyOn, cancelDesktopDownload, cancelServer, checkAll, clearServerAction, desktopKey, downloadDesktop, installDesktop, stopWaiting, updateEverything, updateServer, useUpdates } from "./store";
import type { ManifestMessage, UpdateJob } from "./types";
import { useUpdateView } from "./useUpdateView";

export const RELEASES_URL = "https://github.com/cosmicstack-labs/mercury-agent/releases";

const TONE: Record<Urgency, string> = {
  low: "text-ink2 bg-ink/[0.06] hover:bg-ink/[0.1]",
  elevated: "text-accent bg-accent/10 hover:bg-accent/15",
  high: "text-amber bg-amber/15 hover:bg-amber/20",
  critical: "text-red bg-red/10 hover:bg-red/15",
};

/**
 * Top right, like Chrome's: there only when something can be updated
 * (this app or any server it connects to), louder the longer it waits,
 * red and permanent when an update is required. Click for the panel.
 */
export function UpdateButton() {
  const { button, items } = useUpdateView();
  const open = useUpdates((s) => s.panelOpen);
  const setPanel = useUpdates((s) => s.setPanel);
  if (!button) return null;
  return (
    <>
      <button
        data-no-drag
        data-update-button
        onClick={() => setPanel(!open)}
        className={cx("flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors", TONE[button.urgency])}
        aria-label={`${button.label}${button.count > 1 ? `, ${button.count} items` : ""}`}
        aria-expanded={open}
      >
        {button.required ? <ShieldAlert size={13} /> : <ArrowUpCircle size={13} />}
        {button.label}
        {button.count > 1 && <span className="rounded-full bg-current/15 px-1 font-mono text-2xs opacity-80">{button.count}</span>}
      </button>
      {open && <UpdatesPanel items={items} onClose={() => setPanel(false)} />}
    </>
  );
}

export function UpdatesPanel({ items, onClose }: { items: UpdateItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const checking = useUpdates((s) => s.checking);
  const checkedAt = useUpdates((s) => s.lastFullCheck);
  const updatingAll = useUpdates((s) => s.updatingAll);
  const { updatable } = useUpdateView();
  const openSettings = useUi((s) => s.openSettings);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-update-button]")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); };
  }, [onClose]);
  const shown = items.filter((i) => !i.snoozed || i.required || i.active);
  return (
    <div ref={ref} data-no-drag className="fixed right-3 top-10 z-50 flex max-h-[78vh] w-[420px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-line bg-raised text-sm text-ink shadow-2xl animate-fade-in" role="dialog" aria-label="Updates">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="font-medium">Updates</span>
        <button onClick={onClose} className="rounded p-0.5 text-ink4 hover:text-ink" aria-label="Close"><X size={14} /></button>
      </div>
      <div className="flex min-h-0 flex-col divide-y divide-line overflow-y-auto">
        {shown.length === 0 && <p className="px-4 py-6 text-center text-ink3">Everything is up to date.</p>}
        {shown.map((i) => (i.kind === "desktop" ? <DesktopRow key={i.key} item={i} /> : <ServerRow key={i.key} item={i} />))}
      </div>
      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-ink4">
        <span>{checking ? "Checking…" : checkedAt ? `Checked ${ago(checkedAt)}` : ""}</span>
        <span className="flex items-center gap-3">
          <button className="hover:text-ink" onClick={() => void checkAll(true)} disabled={checking}>Check now</button>
          {updatable.length > 1 && <Button size="sm" variant="primary" loading={updatingAll} onClick={() => void updateEverything()}>Update all</Button>}
          <button className="hover:text-ink" onClick={() => { onClose(); openSettings("about"); }}>Settings</button>
        </span>
      </div>
    </div>
  );
}

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function Head({ icon: Icon, item }: { icon: typeof Laptop; item: UpdateItem }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className={cx("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", item.required ? "bg-red/10 text-red" : "bg-ink/[0.06] text-ink2")}><Icon size={14} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{item.name}</span>
          {item.required && <span className="rounded-full bg-red/10 px-1.5 text-2xs font-medium text-red">{item.required.severity === "security" ? "Security update" : "Required"}</span>}
        </div>
        <div className="font-mono text-xs text-ink3">{item.current || "?"}{item.next ? ` → ${item.next}` : ""}</div>
      </div>
    </div>
  );
}

/** Release notes before you update: decide with what's new in front of you. */
export function Notes({ item, defaultOpen = false }: { item: UpdateItem; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const notes = item.release?.notes;
  const url = item.release?.notesUrl;
  if (!notes && !url) return null;
  return (
    <div className="mt-2">
      {notes ? (
        <>
          <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-xs text-ink3 hover:text-ink">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} What's new in {item.next ?? item.release?.version}
          </button>
          {open && <div className="mt-1.5 max-h-60 overflow-y-auto rounded-lg bg-ink/[0.03] px-3 py-2 text-sm" data-selectable><Markdown text={notes} /></div>}
        </>
      ) : null}
      {url && <button onClick={() => void native.openExternal(url)} className="mt-1 text-xs text-accent hover:underline">Full release notes</button>}
    </div>
  );
}

function Bar({ percent }: { percent: number | null }) {
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/[0.08]" role="progressbar" aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      {percent === null
        ? <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/70" />
        : <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />}
    </div>
  );
}

function Messages({ messages }: { messages: ManifestMessage[] }) {
  if (!messages.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {messages.map((m) => (
        <div key={m.id} className={cx("rounded-lg px-3 py-2 text-xs", m.level === "critical" ? "bg-red/10 text-ink" : m.level === "warning" ? "bg-amber/10 text-ink" : "bg-ink/[0.04] text-ink2")}>
          <div className="font-medium">{m.title}</div>
          {m.body && <div className="mt-0.5 text-ink2">{m.body}</div>}
          {m.link && <button onClick={() => void native.openExternal(m.link!.url)} className="mt-1 text-accent hover:underline">{m.link.label || "Read more"}</button>}
        </div>
      ))}
    </div>
  );
}

/* ── Mercury Desktop ── */

export function DesktopRow({ item, compact = false }: { item: UpdateItem; compact?: boolean }) {
  const d = useUpdates((s) => s.desktop);
  const failures = useUpdates((s) => (item.next ? s.prefs.failures[desktopKey(item.next)] : undefined));
  const later = useUpdates((s) => s.later);
  const agent = useRuntimeState((s) => s.agent);
  const [confirm, setConfirm] = useState(false);
  const p = d.progress;
  const replying = agent === "thinking" || agent === "streaming" || agent === "working";
  const gaveUp = (failures?.count ?? 0) >= MAX_FAILURES;

  function restart() {
    if (replying && !confirm) { setConfirm(true); return; }
    setConfirm(false);
    void installDesktop();
  }

  return (
    <div className="px-4 py-3">
      {!compact && <Head icon={Laptop} item={item} />}
      {!item.next && item.required && <p className="mt-2 text-xs text-ink3">This version is no longer supported. The update isn't available to this app yet: download it from the website.</p>}

      {d.phase === "downloading" && (
        <>
          <Bar percent={p?.percent ?? null} />
          <div className="mt-1 flex justify-between gap-3 text-xs text-ink3">
            <span>{p?.phase === "retrying" ? p.message : p?.phase === "verifying" ? "Checking the signature…" : `Downloading ${formatBytes(p?.downloaded)}${p?.total ? ` of ${formatBytes(p.total)}` : ""}`}</span>
            <span className="flex gap-3">
              {p ? timeLeft(p.downloaded, p.total, p.bytesPerSec) ?? "" : ""}
              {p?.phase !== "verifying" && <button className="text-ink3 hover:text-ink" onClick={() => void cancelDesktopDownload()}>Cancel</button>}
            </span>
          </div>
        </>
      )}
      {d.phase === "installing" && <><Bar percent={null} /><p className="mt-1 text-xs text-ink3">Installing. Mercury Desktop restarts by itself.</p></>}
      {d.phase === "error" && d.error && (
        <p className="mt-2 flex gap-1.5 text-xs text-red"><AlertTriangle size={13} className="mt-px shrink-0" />{d.error}</p>
      )}
      {gaveUp && (
        <p className="mt-1 text-xs text-ink3">This didn't work {failures!.count} times, so Mercury stopped trying on its own. You can download the new version from the website instead.</p>
      )}
      {confirm && <p className="mt-2 text-xs text-amber">A reply is still coming in. It keeps running on the server; you'll see it when the app is back. Restart anyway?</p>}

      {!compact && <Notes item={item} />}

      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        {!item.required && d.phase !== "installing" && <Button size="sm" variant="ghost" onClick={() => later(item.key)}>Later</Button>}
        {gaveUp && <Button size="sm" variant="outline" onClick={() => void native.openExternal(RELEASES_URL)}>Download from website</Button>}
        {item.next && d.phase === "ready" && <Button size="sm" variant="primary" onClick={restart}>{confirm ? "Restart anyway" : "Restart to update"}</Button>}
        {item.next && (d.phase === "idle" || d.phase === "checking") && !d.available?.ready && <Button size="sm" variant="primary" onClick={() => void downloadDesktop()}>{d.available?.partialBytes ? "Resume download" : "Download"}</Button>}
        {item.next && d.phase === "error" && <Button size="sm" variant="primary" onClick={() => void (d.available?.ready ? installDesktop() : downloadDesktop())}><RotateCcw size={12} /> Try again</Button>}
        {!item.next && item.required && <Button size="sm" variant="primary" onClick={() => void native.openExternal(RELEASES_URL)}>Download</Button>}
      </div>
    </div>
  );
}

/* ── a server ── */

const STEP: Record<UpdateJob["state"], string> = {
  "waiting-idle": "Waiting for running work to finish",
  downloading: "Downloading",
  verifying: "Checking the download",
  "backing-up": "Backing up",
  stopping: "Stopping Mercury",
  installing: "Installing",
  starting: "Starting the new version",
  checking: "Making sure it works",
  done: "Updated",
  "rolled-back": "Rolled back",
  failed: "Failed",
  cancelled: "Cancelled",
};

const CANCELLABLE: UpdateJob["state"][] = ["waiting-idle", "downloading", "verifying", "backing-up"];

export function ServerRow({ item, compact = false }: { item: UpdateItem; compact?: boolean }) {
  const conn = item.connection!;
  const entry = useUpdates((s) => s.servers[conn.id]);
  const later = useUpdates((s) => s.later);
  const [confirm, setConfirm] = useState(false);
  const [showLog, setShowLog] = useState(false);
  if (!entry) return null;
  const info = entry.info;
  const a = entry.action;
  const local = conn.kind === "local";

  function start(now = false) {
    if (!now && busyOn(conn) && !confirm) { setConfirm(true); return; }
    setConfirm(false);
    void updateServer(conn, { now });
  }

  const job = a.phase === "running" || a.phase === "finished" ? a.job : a.phase === "restarting" ? a.job : null;
  const blocked = info?.blocked && item.next && info.blocked.version === item.next ? info.blocked : null;
  const cannot = info && !info.canSelfUpdate;

  return (
    <div className="px-4 py-3">
      {!compact && <Head icon={Server} item={item} />}
      {item.required?.reason && <p className="mt-2 text-xs text-ink2">{item.required.reason}</p>}
      <Messages messages={item.messages} />

      {a.phase === "approval" && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2 text-xs">
          <KeyRound size={13} className="mt-0.5 shrink-0 text-amber" />
          <span className="flex-1">Waiting for the owner's approval. Approve it on {a.where} · code <span className="font-mono font-medium">{a.code}</span>. It starts by itself once approved.</span>
          <button onClick={() => stopWaiting(conn)} className="text-ink3 hover:text-ink">Cancel</button>
        </div>
      )}
      {(a.phase === "running" || a.phase === "restarting" || a.phase === "starting") && (
        <>
          <Bar percent={a.phase === "starting" ? null : job?.percent ?? null} />
          <div className="mt-1 text-xs text-ink3">
            {a.phase === "starting" ? "Starting the update…"
              : a.phase === "restarting" ? `Restarting ${conn.name}… (it's offline for a moment)`
              : job ? `${STEP[job.state]}${job.message && job.message !== STEP[job.state] ? ` · ${job.message}` : ""}${job.total ? ` · ${formatBytes(job.bytes)} of ${formatBytes(job.total)}` : ""}` : ""}
          </div>
          <div className="mt-1 flex gap-3 text-xs">
            {job?.state === "waiting-idle" && <button onClick={() => start(true)} className="text-accent hover:underline">Update now without waiting</button>}
            {/* Only before Mercury is stopped: after that, finishing (or rolling back) is the safe way out. */}
            {job && CANCELLABLE.includes(job.state) && <button onClick={() => void cancelServer(conn)} className="text-ink3 hover:text-ink">Cancel</button>}
          </div>
        </>
      )}
      {a.phase === "finished" && (
        <div className={cx("mt-2 flex gap-1.5 text-xs", a.job.state === "done" ? "text-accent" : a.job.state === "rolled-back" ? "text-amber" : a.job.state === "failed" ? "text-red" : "text-ink3")}>
          {a.job.state === "done" ? <CheckCircle2 size={13} className="mt-px shrink-0" /> : <AlertTriangle size={13} className="mt-px shrink-0" />}
          <span>
            {a.job.state === "done" ? `Updated to ${a.job.to}.`
              : a.job.state === "rolled-back" ? `${a.job.to} didn't start properly, so ${conn.name} went back to ${a.job.from}. Nothing was lost.${a.job.error ? ` (${a.job.error})` : ""}`
              : a.job.state === "failed" ? `The update failed: ${a.job.error ?? a.job.message}. ${conn.name} still runs ${a.job.from}.`
              : "The update was cancelled."}
          </span>
        </div>
      )}
      {job && job.log?.length > 0 && (a.phase === "finished" && a.job.state !== "done") && (
        <div className="mt-1">
          <button onClick={() => setShowLog(!showLog)} className="flex items-center gap-1 text-xs text-ink3 hover:text-ink">{showLog ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Details</button>
          {showLog && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-ink/[0.04] p-2 font-mono text-2xs text-ink2" data-selectable>{job.log.join("\n")}</pre>}
        </div>
      )}
      {a.phase === "error" && <p className="mt-2 flex gap-1.5 text-xs text-red"><AlertTriangle size={13} className="mt-px shrink-0" />{a.message}</p>}
      {blocked && a.phase === "idle" && (
        <p className="mt-2 text-xs text-ink3">Updating to {blocked.version} failed {blocked.failures} times{blocked.lastError ? ` (${blocked.lastError})` : ""}, so Mercury stopped trying on its own. On {local ? "this computer" : "that computer"}, run <code className="font-mono">mercury upgrade</code> to see what's wrong, or try once more.</p>
      )}
      {item.release?.downloadable === false && a.phase === "idle" && <p className="mt-2 text-xs text-ink3">{item.next} was announced but its files aren't published yet. Nothing was changed; Mercury checks again later.</p>}
      {cannot && item.next && <p className="mt-2 text-xs text-ink3">{info?.cannotReason ?? "This Mercury can't update itself."} {local ? "Run" : "On that computer, run"} <code className="font-mono">mercury upgrade</code>.</p>}
      {!info && item.next && <p className="mt-2 text-xs text-ink3">This Mercury is too old to update from here. {local ? "Run" : "On that computer, run"} <code className="font-mono">mercury upgrade</code> once; after that it updates from this app.</p>}
      {confirm && <p className="mt-2 text-xs text-amber">Mercury is answering right now. The update waits until running work is done (up to 10 minutes), or can start right away and stop it.</p>}

      {!compact && <Notes item={item} />}

      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        {a.phase === "finished" && <Button size="sm" variant="ghost" onClick={() => clearServerAction(conn)}>Dismiss</Button>}
        {!item.required && a.phase === "idle" && item.next && <Button size="sm" variant="ghost" onClick={() => later(item.key)}>Later</Button>}
        {confirm && <Button size="sm" variant="outline" onClick={() => start(true)}>Update now</Button>}
        {item.next && info?.canSelfUpdate && item.release?.downloadable !== false && (a.phase === "idle" || a.phase === "error" || (a.phase === "finished" && a.job.state !== "done")) && (
          <Button size="sm" variant="primary" onClick={() => { if (confirm) { setConfirm(false); void updateServer(conn); } else start(); }}>
            {confirm ? "Wait, then update" : a.phase === "idle" ? (blocked ? "Try again" : "Update server") : <><RotateCcw size={12} /> Try again</>}
          </Button>
        )}
      </div>
    </div>
  );
}
