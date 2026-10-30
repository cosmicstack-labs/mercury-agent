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
  kind: "started" | "needs_you" | "resolved" | "done" | "stopped" | "failed";
  sessionId: string;
  title?: string;
  id?: string;
  prompt?: string;
  ms?: number;
  preview?: string;
  message?: string;
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
      if (e.kind === "done") tell("done", e.sessionId, `Done: ${label(e)}`, e.preview || "Mercury finished.");
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
  }
}

/** Open the conversation an alert is about. */
export function openFromAlert(sessionId: string): void {
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
