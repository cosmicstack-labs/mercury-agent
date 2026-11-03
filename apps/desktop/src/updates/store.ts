/* ═══════════════════════════════════════════════════════════════
   Updates: this app, every server it connects to, and what the signed
   manifest says. One store so the Update button, the panel, the force
   screen, Settings and the toasts all agree.

   Rules (UPDATES.md):
   - nothing here blocks the app unless a VERIFIED manifest (or the
     server's own check) says an update is required;
   - downloads run quietly in the background and resume; failures are
     shown where you look (the panel), never as pop-ups; after three
     failed tries at one version we stop trying on our own;
   - everything is dismissible except a required update.
   ═══════════════════════════════════════════════════════════════ */

import { create } from "zustand";
import { isTauri } from "~/shell/tauri";
import { useConnections, type Connection } from "~/shell/connections";
import { useNotify } from "~/app/notify/store";
import { useRuntimeState } from "~/app/store";
import { updatesNative } from "./native";
import { approvalStatus, cancelServerUpdate, fetchServerUpdates, serverVersion, startServerUpdate, ServerError } from "./server";
import { itemsOf, updatableOf, type UpdateItem } from "./selectors";
import { isNewer, LATER_MS, MAX_FAILURES, messagesFor, type ForceAck } from "./logic";
import { JOB_FINISHED, type DesktopUpdateInfo, type DownloadProgress, type ManifestResult, type ServerUpdates, type UpdateJob } from "./types";

/* ── persisted preferences and memory (this device) ── */

export interface UpdatePrefs {
  /** When an update was first seen, per "desktop:<v>" / "server:<connection>:<v>": how loud the button is. */
  firstSeen: Record<string, number>;
  /** "Later": hidden until then (same keys). */
  later: Record<string, number>;
  dismissedMessages: Record<string, number>;
  /** Info messages are a toast once. */
  shownMessages: Record<string, number>;
  lastDesktopVersion: string | null;
  lastServerVersion: Record<string, string>;
  failures: Record<string, { count: number; lastError: string }>;
  autoDownload: boolean;
  installOnQuit: boolean;
}

const DEFAULT_PREFS: UpdatePrefs = {
  firstSeen: {}, later: {}, dismissedMessages: {}, shownMessages: {},
  lastDesktopVersion: null, lastServerVersion: {}, failures: {},
  autoDownload: true, installOnQuit: true,
};

const STORE_FILE = "updates.json";
const DEV_KEY = "mercury-desktop-updates";

async function readPrefs(): Promise<UpdatePrefs> {
  try {
    if (isTauri) {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      return { ...DEFAULT_PREFS, ...((await store.get<Partial<UpdatePrefs>>("prefs")) ?? {}) };
    }
    const raw = localStorage.getItem(DEV_KEY);
    return { ...DEFAULT_PREFS, ...(raw ? (JSON.parse(raw) as Partial<UpdatePrefs>) : {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function savePrefs(prefs: UpdatePrefs): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void (async () => {
      try {
        if (isTauri) {
          const { load } = await import("@tauri-apps/plugin-store");
          const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
          await store.set("prefs", prefs);
          await store.save();
        } else {
          localStorage.setItem(DEV_KEY, JSON.stringify(prefs));
        }
      } catch { /* a preference not saved is not worth an error */ }
    })();
  }, 300);
}

/* ── live state ── */

export type DesktopPhase = "idle" | "checking" | "downloading" | "ready" | "installing" | "error";

export interface DesktopState {
  current: string;
  available: DesktopUpdateInfo | null;
  phase: DesktopPhase;
  progress: DownloadProgress | null;
  error: string | null;
  checkedAt: number | null;
}

export type ServerAction =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "approval"; code: string; where: string }
  | { phase: "running"; job: UpdateJob }
  /** The daemon is between versions: not answering for a moment. */
  | { phase: "restarting"; job: UpdateJob | null }
  | { phase: "finished"; job: UpdateJob }
  | { phase: "error"; message: string };

export interface ServerEntry {
  connectionId: string;
  /** null = this Mercury has no /api/updates yet (older); `version` came from its health. */
  info: ServerUpdates | null;
  version: string | null;
  error: string | null;
  checkedAt: number;
  action: ServerAction;
}

export interface WhatsNew { title: string; version: string; notes?: string | null; notesUrl?: string | null }

/** New for every start of the app: a force update's "continue anyway" ends with it. */
export const LAUNCH_ID = Math.random().toString(36).slice(2);

interface UpdatesState {
  loaded: boolean;
  prefs: UpdatePrefs;
  manifest: ManifestResult | null;
  desktop: DesktopState;
  servers: Record<string, ServerEntry>;
  acks: Record<string, ForceAck>;
  panelOpen: boolean;
  whatsNew: WhatsNew | null;
  lastFullCheck: number;
  checking: boolean;
  /** The last check the user asked for: what it found, for "Everything is up to date" / "2 updates found". */
  manualCheck: { at: number; found: number } | null;
  /** "Update everything" is running: servers first, then this app restarts once they're done. */
  updatingAll: boolean;

  setPrefs(patch: Partial<UpdatePrefs>): void;
  setPanel(open: boolean): void;
  showWhatsNew(w: WhatsNew | null): void;
  later(key: string): void;
  dismissMessage(id: string): void;
  acknowledge(key: string): void;
  setServer(id: string, patch: Partial<ServerEntry>): void;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  loaded: false,
  prefs: { ...DEFAULT_PREFS },
  manifest: null,
  desktop: { current: "", available: null, phase: "idle", progress: null, error: null, checkedAt: null },
  servers: {},
  acks: {},
  panelOpen: false,
  whatsNew: null,
  lastFullCheck: 0,
  checking: false,
  manualCheck: null,
  updatingAll: false,

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    savePrefs(prefs);
  },
  setPanel: (panelOpen) => set({ panelOpen }),
  showWhatsNew: (whatsNew) => set({ whatsNew }),
  later: (key) => get().setPrefs({ later: { ...get().prefs.later, [key]: Date.now() + LATER_MS } }),
  dismissMessage: (id) => get().setPrefs({ dismissedMessages: { ...get().prefs.dismissedMessages, [id]: Date.now() } }),
  acknowledge: (key) => set((s) => ({ acks: { ...s.acks, [key]: { key, at: Date.now(), launchId: LAUNCH_ID } } })),
  setServer: (id, patch) => set((s) => {
    const prev = s.servers[id] ?? { connectionId: id, info: null, version: null, error: null, checkedAt: 0, action: { phase: "idle" } as ServerAction };
    return { servers: { ...s.servers, [id]: { ...prev, ...patch } } };
  }),
}));

export const desktopKey = (v: string) => `desktop:${v}`;
export const serverKey = (connectionId: string, v: string) => `server:${connectionId}:${v}`;

function noteFirstSeen(key: string): void {
  const { prefs, setPrefs } = useUpdates.getState();
  if (prefs.firstSeen[key]) return;
  // Keep the map small: entries older than 60 days are long resolved.
  const cutoff = Date.now() - 60 * 86_400_000;
  const firstSeen = Object.fromEntries(Object.entries(prefs.firstSeen).filter(([, at]) => at > cutoff));
  setPrefs({ firstSeen: { ...firstSeen, [key]: Date.now() } });
}

/* ── loading and checking ── */

let progressUnlisten: (() => void) | null = null;

export async function initUpdates(): Promise<void> {
  if (useUpdates.getState().loaded) return;
  const prefs = await readPrefs();
  useUpdates.setState({ loaded: true, prefs });
  void updatesNative.setInstallOnQuit(prefs.installOnQuit);
  if (!progressUnlisten) {
    progressUnlisten = await updatesNative.onProgress((p) => {
      const d = useUpdates.getState().desktop;
      if (d.available && p.version !== d.available.version) return;
      const phase = p.phase === "ready" ? "ready" : p.phase === "error" ? d.phase : p.phase === "cancelled" ? "idle" : "downloading";
      useUpdates.setState({ desktop: { ...d, progress: p.phase === "cancelled" ? null : p, phase } });
    });
  }
  const status = await updatesNative.status().catch(() => null);
  if (status) {
    useUpdates.setState((s) => ({
      desktop: { ...s.desktop, current: status.currentVersion, available: status.pending, phase: status.pending?.ready ? "ready" : status.downloading ? "downloading" : "idle" },
    }));
  }
}

const SIX_HOURS = 6 * 3_600_000;

/** Everything: the manifest, this app, every server. `force` = the user asked (bypasses the 6 h throttle). */
export async function checkAll(force = false): Promise<void> {
  const st = useUpdates.getState();
  if (st.checking) return;
  if (!force && Date.now() - st.lastFullCheck < SIX_HOURS) return;
  useUpdates.setState({ checking: true, lastFullCheck: Date.now() });
  try {
    const manifest = await updatesNative.manifest(force).catch(() => null);
    if (manifest) useUpdates.setState({ manifest });
    await Promise.allSettled([checkDesktop(), ...useConnections.getState().connections.map((c) => checkServer(c, force))]);
    announce();
    if (force) useUpdates.setState({ manualCheck: { at: Date.now(), found: updatableNow().length } });
  } finally {
    useUpdates.setState({ checking: false });
  }
}

/** What "Update everything" would update now: this app and every server that can update itself. */
export function updatableNow(): UpdateItem[] {
  const s = useUpdates.getState();
  return updatableOf(itemsOf(s, useConnections.getState().connections, Date.now()), s);
}

/** Check now, and update whatever was found. */
export async function checkAndUpdateAll(): Promise<void> {
  await checkAll(true);
  await updateEverything();
}

/**
 * Every server that can update itself starts (owner approval where needed);
 * this app downloads meanwhile and restarts last, once the servers are done,
 * so their progress is never cut off halfway. A reply running here keeps the
 * restart waiting for the user (the panel's "Restart to update").
 */
export async function updateEverything(): Promise<void> {
  if (useUpdates.getState().updatingAll) return;
  const items = updatableNow();
  if (!items.length) return;
  useUpdates.setState({ updatingAll: true, panelOpen: true });
  try {
    const servers = items.filter((i) => i.kind === "server").map((i) => updateServer(i.connection!));
    const desktopItem = items.find((i) => i.kind === "desktop");
    const downloaded = desktopItem
      ? useUpdates.getState().desktop.available?.ready ? Promise.resolve(true) : downloadDesktop()
      : Promise.resolve(false);
    const [, ready] = await Promise.all([Promise.allSettled(servers), downloaded]);
    if (!desktopItem || !ready || !useUpdates.getState().updatingAll) return;
    const a = useRuntimeState.getState().agent;
    if (a === "thinking" || a === "streaming" || a === "working" || a === "needs-you") return;
    await installDesktop();
  } finally {
    useUpdates.setState({ updatingAll: false });
  }
}

/** Stop a desktop download (keeps its bytes) and an "Update everything" waiting on it. */
export async function cancelDesktopDownload(): Promise<void> {
  useUpdates.setState({ updatingAll: false });
  await updatesNative.cancel().catch(() => {});
}

/** Cancel a server update that hasn't stopped Mercury yet. */
export async function cancelServer(conn: Connection): Promise<void> {
  try {
    await cancelServerUpdate(conn);
  } catch (err) {
    useUpdates.getState().setServer(conn.id, { action: { phase: "error", message: err instanceof Error ? err.message : String(err) } });
  }
}

export async function checkDesktop(): Promise<void> {
  const s = useUpdates.getState();
  if (s.desktop.phase === "downloading" || s.desktop.phase === "installing") return;
  useUpdates.setState({ desktop: { ...s.desktop, phase: "checking", error: null } });
  try {
    const available = await updatesNative.check();
    const d = useUpdates.getState().desktop;
    useUpdates.setState({ desktop: { ...d, available, phase: available?.ready ? "ready" : "idle", checkedAt: Date.now(), current: available?.currentVersion ?? d.current } });
    if (available) {
      noteFirstSeen(desktopKey(available.version));
      const { prefs } = useUpdates.getState();
      const failed = prefs.failures[desktopKey(available.version)]?.count ?? 0;
      if (!available.ready && prefs.autoDownload && failed < MAX_FAILURES) void downloadDesktop();
    }
  } catch (err) {
    // No release feed yet, offline…: say so in the panel only, and only when asked.
    const d = useUpdates.getState().desktop;
    useUpdates.setState({ desktop: { ...d, phase: d.available?.ready ? "ready" : "idle", error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() } });
  }
}

export async function downloadDesktop(): Promise<boolean> {
  const d = useUpdates.getState().desktop;
  if (!d.available) return false;
  const key = desktopKey(d.available.version);
  useUpdates.setState({ desktop: { ...d, phase: "downloading", error: null } });
  try {
    const info = await updatesNative.download();
    const cur = useUpdates.getState();
    useUpdates.setState({ desktop: { ...cur.desktop, available: info, phase: "ready", error: null } });
    const failures = { ...cur.prefs.failures };
    delete failures[key];
    cur.setPrefs({ failures });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "Already downloading.") return false;
    if (message === "Download cancelled.") {
      // Not a failure: the bytes stay and "Resume download" picks up from there.
      const cur = useUpdates.getState();
      useUpdates.setState({ desktop: { ...cur.desktop, phase: "idle", progress: null, error: null, available: cur.desktop.available ? { ...cur.desktop.available } : null } });
      void checkDesktop();
      return false;
    }
    const cur = useUpdates.getState();
    const prev = cur.prefs.failures[key]?.count ?? 0;
    cur.setPrefs({ failures: { ...cur.prefs.failures, [key]: { count: prev + 1, lastError: message } } });
    useUpdates.setState({ desktop: { ...cur.desktop, phase: "error", error: message } });
    return false;
  }
}

/** Install the downloaded update and restart. */
export async function installDesktop(): Promise<void> {
  const d = useUpdates.getState().desktop;
  useUpdates.setState({ desktop: { ...d, phase: "installing", error: null } });
  try {
    if (!d.available?.ready) {
      const ok = await downloadDesktop();
      if (!ok) return;
    }
    await updatesNative.install();
  } catch (err) {
    const cur = useUpdates.getState().desktop;
    const message = err instanceof Error ? err.message : String(err);
    const key = cur.available ? desktopKey(cur.available.version) : "desktop:?";
    const { prefs, setPrefs } = useUpdates.getState();
    setPrefs({ failures: { ...prefs.failures, [key]: { count: (prefs.failures[key]?.count ?? 0) + 1, lastError: message } } });
    useUpdates.setState({ desktop: { ...cur, phase: "error", error: message, available: cur.available ? { ...cur.available, ready: false } : null } });
  }
}

export async function checkServer(conn: Connection, refresh = false): Promise<void> {
  const { setServer, servers } = useUpdates.getState();
  const busy = servers[conn.id]?.action.phase;
  if (busy === "running" || busy === "restarting" || busy === "starting") return;
  try {
    const info = await fetchServerUpdates(conn, refresh);
    const version = info?.current ?? (await serverVersion(conn));
    setServer(conn.id, { info, version, error: null, checkedAt: Date.now() });
    const latest = info?.latest?.version ?? manifestServerLatest();
    if (version && latest && (info ? info.updateAvailable : isNewer(latest, version))) noteFirstSeen(serverKey(conn.id, latest));
    noticeServerVersion(conn, info, version);
    // An update already running there (started from its CLI, or before this app opened): follow it.
    const action = useUpdates.getState().servers[conn.id]?.action.phase;
    if (info?.job && !JOB_FINISHED.includes(info.job.state) && (action === "idle" || action === "finished" || action === "error")) void followJob(conn, info.job);
  } catch (err) {
    setServer(conn.id, { error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() });
  }
}

function manifestServerLatest(): string | null {
  const m = useUpdates.getState().manifest;
  return m?.verified ? m.manifest?.server?.channels?.stable?.version ?? null : null;
}

/* ── what's new, and messages ── */

/** A server now runs a newer version than last time we looked: say so once. */
function noticeServerVersion(conn: Connection, info: ServerUpdates | null, version: string | null): void {
  if (!version) return;
  const { prefs, setPrefs } = useUpdates.getState();
  const last = prefs.lastServerVersion[conn.id];
  if (last === version) return;
  setPrefs({ lastServerVersion: { ...prefs.lastServerVersion, [conn.id]: version } });
  if (!last || !isNewer(version, last)) return;
  const notes = info?.latest?.version === version ? info.latest : useUpdates.getState().manifest?.manifest?.server?.channels?.stable;
  const w: WhatsNew = { title: `${conn.name} now runs Mercury ${version}`, version, notes: notes?.version === version ? notes.notes : null, notesUrl: notes?.version === version ? notes.notesUrl : null };
  useNotify.getState().pushAlert({ kind: "update", title: w.title, body: `Updated from ${last}.`, action: { label: "What's new", run: () => useUpdates.getState().showWhatsNew(w) } });
}

/** After the desktop updated itself (version changed since last launch). */
export function noticeDesktopVersion(): void {
  const { prefs, setPrefs, desktop, manifest } = useUpdates.getState();
  const current = desktop.current;
  if (!current || current === "dev") return;
  const last = prefs.lastDesktopVersion;
  if (last === current) return;
  setPrefs({ lastDesktopVersion: current });
  if (!last || !isNewer(current, last)) return;
  const rel = manifest?.manifest?.desktop?.channels?.stable;
  const w: WhatsNew = { title: `Mercury Desktop ${current}`, version: current, notes: rel?.version === current ? rel.notes : null, notesUrl: rel?.version === current ? rel.notesUrl : null };
  useNotify.getState().pushAlert({ kind: "update", title: `Mercury Desktop updated to ${current}`, body: `You were on ${last}.`, action: { label: "What's new", run: () => useUpdates.getState().showWhatsNew(w) } });
}

/** Info messages from the manifest: a toast, once. (Warnings and critical ones are a banner.) */
function announce(): void {
  noticeDesktopVersion();
  const { manifest, desktop, prefs, setPrefs } = useUpdates.getState();
  const msgs = messagesFor(manifest?.manifest ?? null, !!manifest?.verified, "desktop", desktop.current || "0.0.0", Date.now(), prefs.dismissedMessages);
  const fresh = msgs.filter((m) => (m.level ?? "info") === "info" && !prefs.shownMessages[m.id]);
  if (!fresh.length) return;
  const shown = { ...prefs.shownMessages };
  for (const m of fresh.slice(0, 2)) {
    shown[m.id] = Date.now();
    useNotify.getState().pushAlert({
      kind: "update",
      title: m.title,
      body: m.body ?? "",
      action: m.link ? { label: m.link.label || "Read more", run: () => void import("~/shell/tauri").then(({ desktop: d }) => d.openExternal(m.link!.url)) } : undefined,
    });
  }
  setPrefs({ shownMessages: shown });
}

/* ── updating a server ── */

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is a reply running on this connection right now? (Only known for the one this window shows.) */
export function busyOn(conn: Connection): boolean {
  if (useConnections.getState().activeId !== conn.id) return false;
  const a = useRuntimeState.getState().agent;
  return a === "thinking" || a === "streaming" || a === "working" || a === "needs-you";
}

export async function updateServer(conn: Connection, opts: { now?: boolean } = {}): Promise<void> {
  const { setServer } = useUpdates.getState();
  setServer(conn.id, { action: { phase: "starting" } });
  try {
    let outcome = await startServerUpdate(conn, opts);
    if (outcome.kind === "approval") {
      setServer(conn.id, { action: { phase: "approval", code: outcome.code, where: outcome.where } });
      const until = (outcome.expiresAt ?? Date.now() + 10 * 60_000) + 5_000;
      let allowed = false;
      while (Date.now() < until) {
        await pause(2000);
        if (useUpdates.getState().servers[conn.id]?.action.phase !== "approval") return; // cancelled
        const s = await approvalStatus(conn, outcome.approvalId).catch(() => "pending");
        if (s === "allowed") { allowed = true; break; }
        if (s === "denied" || s === "expired") break;
      }
      if (!allowed) { setServer(conn.id, { action: { phase: "error", message: "The owner didn't approve the update." } }); return; }
      outcome = await startServerUpdate(conn, { ...opts, approvalId: outcome.approvalId });
      if (outcome.kind !== "started") { setServer(conn.id, { action: { phase: "error", message: "The owner didn't approve the update." } }); return; }
    }
    await followJob(conn, outcome.job);
  } catch (err) {
    const message = err instanceof ServerError || err instanceof Error ? err.message : String(err);
    setServer(conn.id, { action: { phase: "error", message } });
  }
}

/** Stop waiting for an approval (the server's question simply expires). */
export function stopWaiting(conn: Connection): void {
  useUpdates.getState().setServer(conn.id, { action: { phase: "idle" } });
}

/** Poll the job through the restart, until it's done, rolled back or failed. */
async function followJob(conn: Connection, first: UpdateJob): Promise<void> {
  const { setServer } = useUpdates.getState();
  let job = first;
  let downSince: number | null = null;
  setServer(conn.id, { action: { phase: "running", job } });
  for (;;) {
    if (JOB_FINISHED.includes(job.state)) break;
    await pause(1500);
    try {
      const info = await fetchServerUpdates(conn);
      if (!info) {
        // Up again on a version without the updates API (1.4.2 and older): health says it's back.
        const v = await serverVersion(conn);
        if (v === null) throw new Error("down");
        job = { ...job, state: v === "" || v === job.to ? "done" : "rolled-back", percent: 100, message: v === "" || v === job.to ? `Updated to ${job.to}` : `Running ${v}` };
        break;
      }
      downSince = null;
      setServer(conn.id, { info, version: info.current });
      if (info.job && info.job.id === job.id) job = info.job;
      else if (!info.job && info.current === job.to) job = { ...job, state: "done", percent: 100, message: `Updated to ${job.to}` };
      setServer(conn.id, { action: { phase: "running", job } });
    } catch {
      // Between versions: the daemon is down for a moment (a local one also gets a new token).
      downSince ??= Date.now();
      setServer(conn.id, { action: { phase: "restarting", job } });
      if (Date.now() - downSince > 6 * 60_000) {
        setServer(conn.id, { action: { phase: "error", message: `${conn.name} hasn't answered for 6 minutes. If it doesn't come back, run \`mercury start\` there (and \`mercury logs\` to see why).` } });
        return;
      }
    }
  }
  setServer(conn.id, { action: { phase: "finished", job } });
  if (job.state === "done" && useConnections.getState().activeId === conn.id) {
    // The window's own connection: reconnect onto the new version (events, token).
    window.dispatchEvent(new CustomEvent("mercury:reconnect", { detail: { connectionId: conn.id } }));
  }
  void checkServer(conn);
}

/** Clear a finished job's card. */
export function clearServerAction(conn: Connection): void {
  useUpdates.getState().setServer(conn.id, { action: { phase: "idle" } });
}

export { isNewer };
