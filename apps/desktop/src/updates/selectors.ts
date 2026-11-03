/* What the Update button, the panel and the force screen show, derived
   from the store. Pure functions of state, so they're tested. */

import type { Connection } from "~/shell/connections";
import { ackHolds, canDismiss, isNewer, louder, messagesFor, requiredBy, snoozed, urgencyOf, type Urgency } from "./logic";
import type { DesktopState, ServerEntry, UpdatePrefs } from "./store";
import type { ChannelRelease, ManifestMessage, ManifestResult, Minimum } from "./types";
import type { ForceAck } from "./logic";

export interface UpdateItem {
  key: string;
  kind: "desktop" | "server";
  connection?: Connection;
  name: string;
  current: string;
  next: string | null;
  release: ChannelRelease | null;
  required: Minimum | null;
  urgency: Urgency;
  snoozed: boolean;
  messages: ManifestMessage[];
  /** Something is happening (download, server job): keep it visible. */
  active: boolean;
}

export interface Snapshot {
  prefs: UpdatePrefs;
  manifest: ManifestResult | null;
  desktop: DesktopState;
  servers: Record<string, ServerEntry>;
}

export function desktopRequired(s: Snapshot): Minimum | null {
  return requiredBy(s.desktop.current, s.manifest?.manifest?.desktop?.minimum, !!s.manifest?.verified);
}

export function itemsOf(s: Snapshot, connections: Connection[], now: number): UpdateItem[] {
  const items: UpdateItem[] = [];
  const m = s.manifest;
  const verified = !!m?.verified;

  // This app.
  const dRequired = desktopRequired(s);
  const dRelease = verified ? m?.manifest?.desktop?.channels?.stable ?? null : null;
  const dNext = s.desktop.available?.version ?? (dRequired && dRelease && s.desktop.current && isNewer(dRelease.version, s.desktop.current) ? dRelease.version : null);
  if (dNext || dRequired) {
    const key = `desktop:${dNext ?? dRequired?.version}`;
    items.push({
      key,
      kind: "desktop",
      name: "Mercury Desktop",
      current: s.desktop.current,
      next: dNext,
      release: dRelease?.version === dNext ? dRelease : s.desktop.available ? { version: s.desktop.available.version, notes: s.desktop.available.notes ?? undefined, date: s.desktop.available.date ?? undefined } : null,
      required: dRequired,
      urgency: urgencyOf(s.prefs.firstSeen[key] ?? now, now, { required: !!dRequired }),
      snoozed: !dRequired && snoozed(s.prefs.later[key], now),
      messages: [],
      active: s.desktop.phase === "downloading" || s.desktop.phase === "installing",
    });
  }

  // Every server this app connects to.
  for (const c of connections) {
    const e = s.servers[c.id];
    if (!e) continue;
    const info = e.info;
    const current = info?.current ?? e.version ?? "";
    const fallback = verified ? m?.manifest?.server?.channels?.stable ?? null : null;
    const release = info ? info.latest : fallback && current && isNewer(fallback.version, current) ? fallback : null;
    const available = info ? info.updateAvailable && !!info.latest : !!release;
    const required = info?.required ?? null;
    const active = e.action.phase !== "idle";
    const messages = info?.messages ?? [];
    if (!available && !required && !active && !messages.length) continue;
    const next = available ? release?.version ?? null : null;
    const key = `server:${c.id}:${next ?? required?.version ?? current}`;
    items.push({
      key,
      kind: "server",
      connection: c,
      name: c.name,
      current,
      next,
      release,
      required,
      urgency: urgencyOf(s.prefs.firstSeen[key] ?? now, now, { required: !!required, security: required?.severity === "security" }),
      snoozed: !required && !active && snoozed(s.prefs.later[key], now),
      messages,
      active,
    });
  }
  return items;
}

/** What "Update everything" updates: this app and every server that can update itself and isn't already. */
export function updatableOf(items: UpdateItem[], s: Snapshot): UpdateItem[] {
  return items.filter((i) => {
    if (!i.next) return false;
    if (i.kind === "desktop") return s.desktop.phase !== "installing";
    if (i.release?.downloadable === false) return false;
    const e = s.servers[i.connection!.id];
    const a = e?.action;
    return !!e?.info?.canSelfUpdate && !!a && (a.phase === "idle" || a.phase === "error" || (a.phase === "finished" && a.job.state !== "done"));
  });
}

/** What the top-right button says, or null when there is nothing to do. */
export interface ButtonState { label: string; urgency: Urgency; required: boolean; count: number }

export function buttonOf(items: UpdateItem[], desktopReady: boolean): ButtonState | null {
  const visible = items.filter((i) => !i.snoozed && (i.next || i.required || i.active));
  if (!visible.length) return null;
  const required = visible.some((i) => i.required);
  const urgency = visible.reduce<Urgency>((u, i) => louder(u, i.urgency), "low");
  const onlyDesktop = visible.length === 1 && visible[0].kind === "desktop";
  const label = required ? "Update required" : onlyDesktop && desktopReady ? "Restart to update" : "Update";
  return { label, urgency, required, count: visible.length };
}

/** The force screen: which required update, if its "continue anyway" doesn't hold. */
export interface ForceState { key: string; kind: "desktop" | "server"; required: Minimum; item: UpdateItem }

export function forceOf(items: UpdateItem[], activeConnectionId: string | null, acks: Record<string, ForceAck>, launchId: string, now: number): ForceState | null {
  for (const i of items) {
    if (!i.required) continue;
    // A server forces the screen only when it's the one this window uses.
    if (i.kind === "server" && i.connection?.id !== activeConnectionId) continue;
    // Not tied to the version on offer: a newer release appearing doesn't undo "continue anyway".
    const key = `force:${i.kind}:${i.connection?.id ?? "app"}:${i.required.version}`;
    if (ackHolds(acks[key], key, launchId, now)) continue;
    return { key, kind: i.kind, required: i.required, item: i };
  }
  return null;
}

/** Warning / critical manifest messages for this app: the banner. */
export function bannerMessages(s: Snapshot, now: number): ManifestMessage[] {
  return messagesFor(s.manifest?.manifest ?? null, !!s.manifest?.verified, "desktop", s.desktop.current || "0.0.0", now, s.prefs.dismissedMessages)
    .filter((m) => m.level === "warning" || m.level === "critical");
}

export { canDismiss };
