/* ═══════════════════════════════════════════════════════════════
   Notifications: when a conversation you're not looking at needs an
   answer, or a long task finishes or fails, Mercury tells you.

   Every alert is layered so it still lands when system notifications
   are off or blocked (desktop can't even tell: the OS drops them
   silently): the system banner, plus a sound, the Dock / taskbar badge
   and bounce, the blue dot on the conversation, and an in-app alert
   whenever the window is on screen.
   ═══════════════════════════════════════════════════════════════ */

import { useEffect } from "react";
import { openStream } from "~/api/stream";
import { isTauri } from "~/shell/tauri";
import { conversations, useCodeSessions, type Surface } from "../conversation";
import { useUi } from "../store";
import { useVoice } from "../voice";
import { playSound } from "./sounds";
import { useNotify, worthTelling } from "./store";

export interface ActivityEvent {
  kind: "started" | "needs_you" | "resolved" | "done" | "stopped" | "failed" | "research";
  sessionId: string;
  title?: string;
  id?: string;
  prompt?: string;
  ms?: number;
  preview?: string;
  message?: string;
  /** kind "research": how a research run ended, and what it found. */
  state?: "done" | "partial" | "stopped" | "failed";
  topic?: string;
  read?: number;
  cited?: number;
  failed?: number;
  report?: string;
}

/**
 * A research run's own update follows its "done" by a moment and says more
 * ("Research ready: … · 41 sources"), so a "done" waits briefly for it.
 */
const heldDone = new Map<string, ReturnType<typeof setTimeout>>();
const HOLD_DONE_MS = 1500;

/** "Research ready: solar storms" and "41 sources read · 23 cited · 3 couldn't be read". */
export function researchNotice(e: ActivityEvent): { kind: "done" | "failed"; title: string; body: string } {
  const topic = (e.topic || e.title || "your question").replace(/\s+/g, " ").slice(0, 90);
  const counts = [`${e.read ?? 0} source${e.read === 1 ? "" : "s"} read`, e.cited ? `${e.cited} cited` : "", e.failed ? `${e.failed} couldn't be read` : ""].filter(Boolean).join(" · ");
  switch (e.state) {
    case "done": return { kind: "done", title: `Research ready: ${topic}`, body: counts };
    case "partial": return { kind: "done", title: `Partial research report: ${topic}`, body: `Stopped early, written from what was read. ${counts}` };
    case "stopped": return { kind: "failed", title: `Research stopped: ${topic}`, body: counts };
    default: return { kind: "failed", title: `Research didn't finish: ${topic}`, body: `${counts}. Open it to continue.` };
  }
}

/** Which surface a session belongs to. */
export function surfaceOf(sessionId: string): Surface {
  return useCodeSessions.getState().sessions.some((s) => s.id === sessionId) ? "code" : "chat";
}

/** The conversation is the one on screen (its surface shown, it open). */
export function onScreen(sessionId: string): boolean {
  const surface = surfaceOf(sessionId);
  return useUi.getState().view === surface && conversations[surface].getState().activeId === sessionId;
}

function windowFocused(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

/** Watching = on screen in a focused window: nothing to tell. */
export function watching(sessionId: string): boolean {
  return onScreen(sessionId) && windowFocused();
}

// ── system notifications ───────────────────────────────────────────

export type Permission = "granted" | "denied" | "default" | "unsupported";

/** Desktop always reports granted (the OS decides silently); the web reports the truth. */
export async function permission(): Promise<Permission> {
  if (isTauri) {
    try { const { isPermissionGranted } = await import("@tauri-apps/plugin-notification"); return (await isPermissionGranted()) ? "granted" : "default"; } catch { return "unsupported"; }
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function askPermission(): Promise<Permission> {
  if (isTauri) {
    try { const { requestPermission } = await import("@tauri-apps/plugin-notification"); return await requestPermission(); } catch { return "unsupported"; }
  }
  if (typeof Notification === "undefined") return "unsupported";
  try { return await Notification.requestPermission(); } catch { return "denied"; }
}

/**
 * The Mercury icon for a Linux notification. macOS and Windows always show
 * the sending app's own icon; Linux looks one up by name in the icon theme,
 * which only a .deb/.rpm install provides, so hand it the file itself.
 */
let linuxIcon: Promise<string | undefined> | null = null;
function notificationIcon(): Promise<string | undefined> {
  linuxIcon ??= (async () => {
    try {
      const { platform } = await import("@tauri-apps/plugin-os");
      if (platform() !== "linux") return undefined;
      const { resolveResource } = await import("@tauri-apps/api/path");
      return await resolveResource("notification-icon.png");
    } catch {
      return undefined;
    }
  })();
  return linuxIcon;
}

async function systemNotify(title: string, body: string): Promise<boolean> {
  try {
    if (isTauri) {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const icon = await notificationIcon();
      sendNotification(icon ? { title, body, icon } : { title, body });
      return true;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification(title, { body, silent: true, icon: "/notification-icon.png" });
      n.onclick = () => { window.focus(); n.close(); };
      return true;
    }
  } catch { /* fall through to the other layers */ }
  return false;
}

async function bounce(critical: boolean): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    await getCurrentWindow().requestUserAttention(critical ? UserAttentionType.Critical : UserAttentionType.Informational);
  } catch { /* not every platform can */ }
}

async function setBadge(count: number): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
  } catch { /* Windows has no badge count */ }
}

/** A notified conversation to offer when the window comes back. */
let lastTold: { sessionId: string; at: number; kind: "needs" | "done" | "failed"; title: string; body: string } | null = null;

export function sendTest(): void {
  const { prefs, custom } = useNotify.getState();
  if (!prefs.muted) playSound(prefs.sound, prefs.volume, custom?.url);
  void systemNotify("Mercury", "Notifications are working. You'll hear this when a long task finishes.");
  void bounce(false);
}

/** Tell the owner something, through every layer that applies. */
function tell(kind: "needs" | "done" | "failed", sessionId: string, title: string, body: string): void {
  const { prefs, custom, pushAlert } = useNotify.getState();
  if (!prefs.muted) playSound(prefs.sound, prefs.volume, custom?.url);
  const visible = typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
  if (visible) {
    // The window is in front: an in-app alert is the right size.
    pushAlert({ kind, title, body, sessionId });
    return;
  }
  lastTold = { sessionId, at: Date.now(), kind, title, body };
  if (prefs.system) void systemNotify(title, body);
  void bounce(kind === "needs");
}

function label(e: ActivityEvent): string {
  return (e.title || "").replace(/^Code · /, "").trim() || "A conversation";
}

export function handleActivity(e: ActivityEvent): void {
  const n = useNotify.getState();
  // On a call, Mercury is already talking to you.
  if (useVoice.getState().active) return;
  switch (e.kind) {
    case "needs_you": {
      n.markWaiting(e.sessionId, e.id ?? "");
      if (watching(e.sessionId) || !n.prefs.needsYou) return;
      tell("needs", e.sessionId, "Mercury needs you", `${label(e)}: ${e.prompt || "waiting for your answer"}`);
      return;
    }
    case "resolved":
      n.clearWaiting(e.sessionId, e.id);
      return;
    case "done":
    case "failed": {
      n.clearWaiting(e.sessionId);
      if (!onScreen(e.sessionId)) {
        n.markUnread(e.sessionId);
        void import("../events").then(({ refreshThreads }) => refreshThreads());
      }
      if (watching(e.sessionId) || !worthTelling(e.kind, e.ms ?? 0, n.prefs)) return;
      if (e.kind === "done") {
        const sessionId = e.sessionId;
        clearTimeout(heldDone.get(sessionId));
        heldDone.set(sessionId, setTimeout(() => { heldDone.delete(sessionId); tell("done", sessionId, `Done: ${label(e)}`, e.preview || "Mercury finished."); }, HOLD_DONE_MS));
      }
      else tell("failed", e.sessionId, `Stopped with an error: ${label(e)}`, e.message || "Something went wrong.");
      // First long task: offer system notifications, once.
      if (!n.prefs.asked) {
        n.setPrefs({ asked: true });
        void permission().then((p) => { if (p === "default") n.pushAlert({ kind: "ask", title: "Get a notification when long tasks finish?", body: "Mercury can tell you when it's done or needs you, even when the app is in the background." }); });
      }
      return;
    }
    case "stopped":
      n.clearWaiting(e.sessionId);
      return;
    case "research": {
      // Said instead of the plain "Done" it follows.
      const held = heldDone.get(e.sessionId);
      if (held) { clearTimeout(held); heldDone.delete(e.sessionId); }
      // No "done" waiting: the turn was short or watched, or its failure or stop was already told.
      if (!held) return;
      if (watching(e.sessionId)) return;
      const r = researchNotice(e);
      tell(r.kind, e.sessionId, r.title, r.body);
      return;
    }
  }
}

/**
 * A bot's inbox entry: a result, a failure it reported, or a run that needs
 * you. Told through the same layers as a conversation (sound, banner when the
 * app is in the background, in-app alert when it's in front), unless you're
 * already looking at the bots.
 */
export function tellBotInbox(entry: { botId: string; botName: string; kind: "result" | "failed" | "needs-you"; title: string; summary: string }): void {
  const n = useNotify.getState();
  if (useVoice.getState().active) return;
  if (useUi.getState().view === "bots" && windowFocused()) return;
  if (entry.kind === "needs-you" && !n.prefs.needsYou) return;
  const body = entry.summary.replace(/\s+/g, " ").slice(0, 180);
  if (entry.kind === "result") tell("done", `bot:${entry.botId}`, entry.title, body || "Finished.");
  else if (entry.kind === "failed") tell("failed", `bot:${entry.botId}`, entry.title, body);
  else tell("needs", `bot:${entry.botId}`, entry.title, body || "It needs you.");
}

/** Open the conversation (or bot) an alert is about. */
export function openFromAlert(sessionId: string): void {
  if (sessionId.startsWith("bot:")) {
    useUi.getState().openBot(sessionId.slice(4));
    return;
  }
  const surface = surfaceOf(sessionId);
  useUi.getState().setView(surface);
  void import("../events").then(({ openThread }) => openThread(surface, sessionId));
}

/** The activity stream, the badge, and the "you were notified" offer on return. */
export function useNotifications(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const stream = openStream("/api/chat/activity", {
      onEvent: (event, raw) => {
        if (event === "owner_approval") {
          // A device or a remote action waiting for the owner (only sent to an app on the Mercury computer).
          try {
            const data = JSON.parse(raw) as Record<string, unknown>;
            void import("~/components/OwnerApprovals").then(({ onOwnerApprovalEvent }) => onOwnerApprovalEvent(data));
            if (data.change === "new" && !windowFocused()) tell("needs", "security", data.kind === "pair" ? "A new device wants to connect" : "Mercury needs your approval", `${String(data.kind === "pair" ? data.who : data.title ?? "")} · code ${String(data.code ?? "")}`);
          } catch { /* ignore a bad line */ }
          return;
        }
        if (event !== "activity") return;
        try { handleActivity(JSON.parse(raw) as ActivityEvent); } catch { /* ignore a bad line */ }
      },
    });
    return () => stream.close();
  }, [enabled]);

  // A conversation on screen has nothing new.
  useEffect(() => {
    const check = () => {
      for (const s of ["chat", "code"] as const) {
        const id = conversations[s].getState().activeId;
        if (id && useUi.getState().view === s) useNotify.getState().seen(id);
      }
    };
    check();
    const offs = [useUi.subscribe(check), conversations.chat.subscribe(check), conversations.code.subscribe(check)];
    return () => offs.forEach((off) => off());
  }, []);

  // Badge: conversations waiting on you plus ones with something new.
  useEffect(() => {
    const sync = () => {
      const s = useNotify.getState();
      void setBadge(s.prefs.badge ? Object.keys(s.waiting).length + Object.keys(s.unread).length : 0);
    };
    sync();
    return useNotify.subscribe(sync);
  }, []);

  // Back in the window soon after a notification (perhaps by clicking it): offer to open it.
  useEffect(() => {
    const onFocus = () => {
      const t = lastTold;
      lastTold = null;
      if (!t || Date.now() - t.at > 5 * 60_000 || onScreen(t.sessionId)) return;
      useNotify.getState().pushAlert({ kind: t.kind, title: t.title, body: t.body, sessionId: t.sessionId });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
