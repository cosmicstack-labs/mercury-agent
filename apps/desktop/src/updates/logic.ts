/* ═══════════════════════════════════════════════════════════════
   Update rules, kept pure so they're tested: version order, how loud
   the Update button is, whether a force update applies and whether its
   "continue anyway" still holds, and which manifest messages show.
   See UPDATES.md.
   ═══════════════════════════════════════════════════════════════ */

import type { ManifestMessage, Minimum, UpdateManifest } from "./types";

/** -1 / 0 / 1. "1.4.2" < "1.5.0"; a pre-release sorts before its release ("1.5.0-dev.1" < "1.5.0"). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre = ""] = v.trim().replace(/^v/, "").split(/-(.*)/s, 2);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const px = x.pre.split(".");
  const py = y.pre.split(".");
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined) return -1;
    if (py[i] === undefined) return 1;
    const nx = /^\d+$/.test(px[i]) ? Number(px[i]) : NaN;
    const ny = /^\d+$/.test(py[i]) ? Number(py[i]) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx > ny ? 1 : -1; continue; }
    if (px[i] !== py[i]) return px[i] > py[i] ? 1 : -1;
  }
  return 0;
}

export const isNewer = (a: string, b: string) => compareVersions(a, b) > 0;

/** "<1.5.0", ">=1.2.0 <1.4.3", "=1.4.1": every comparator must hold. Empty = every version. */
export function versionMatches(range: string | null | undefined, version: string): boolean {
  const parts = (range ?? "").trim().split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const m = /^(>=|<=|>|<|=)?\s*v?(.+)$/.exec(part);
    if (!m) return false;
    const c = compareVersions(version, m[2]);
    const op = m[1] ?? "=";
    const ok = op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}

const DAY = 86_400_000;

/**
 * How loud the Update button is, the way Chrome does it: quiet when an
 * update is new, then louder the longer it waits. A security fix starts red.
 */
export type Urgency = "low" | "elevated" | "high" | "critical";

export function urgencyOf(firstSeenAt: number, now: number, opts: { security?: boolean; required?: boolean } = {}): Urgency {
  if (opts.required || opts.security) return "critical";
  const age = Math.max(0, now - firstSeenAt);
  if (age >= 7 * DAY) return "critical";
  if (age >= 4 * DAY) return "high";
  if (age >= 2 * DAY) return "elevated";
  return "low";
}

const ORDER: Urgency[] = ["low", "elevated", "high", "critical"];
export const louder = (a: Urgency, b: Urgency): Urgency => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

/** Is `current` below a required minimum? Only a verified manifest may say so. */
export function requiredBy(current: string | null | undefined, minimum: Minimum | null | undefined, verified: boolean): Minimum | null {
  if (!verified || !current || !minimum?.version) return null;
  return compareVersions(current, minimum.version) < 0 ? minimum : null;
}

/** "Continue without updating" lasts until the app restarts, or 24 hours, whichever comes first. */
export const ACK_MS = DAY;

export interface ForceAck { key: string; at: number; launchId: string }

export function ackHolds(ack: ForceAck | undefined, key: string, launchId: string, now: number): boolean {
  return !!ack && ack.key === key && ack.launchId === launchId && now - ack.at < ACK_MS;
}

/** "Later" hides a (not required) update for a day. */
export const LATER_MS = DAY;

export function snoozed(until: number | undefined, now: number): boolean {
  return typeof until === "number" && until > now;
}

/** Manifest messages this app shows now: right app, version, dates, not dismissed. Unverified → none. */
export function messagesFor(
  manifest: UpdateManifest | null,
  verified: boolean,
  app: "desktop" | "server",
  version: string,
  now: number,
  dismissed: Record<string, number> = {},
): ManifestMessage[] {
  if (!verified || !manifest || !Array.isArray(manifest.messages)) return [];
  return manifest.messages.filter((m) => {
    if (!m || typeof m.id !== "string" || typeof m.title !== "string") return false;
    if (!Array.isArray(m.apps) || !m.apps.includes(app)) return false;
    if (m.versions && !versionMatches(m.versions, version)) return false;
    if (m.startsAt && Date.parse(m.startsAt) > now) return false;
    if (m.endsAt && Date.parse(m.endsAt) <= now) return false;
    // A message that can't be dismissed (critical only) ignores old dismissals.
    if (canDismiss(m) && dismissed[m.id]) return false;
    return true;
  });
}

export function canDismiss(m: ManifestMessage): boolean {
  return m.dismissible !== false || m.level !== "critical";
}

export function formatBytes(n: number | null | undefined): string {
  if (!n || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** "about 2 min left" from bytes and speed; null while unknown. */
export function timeLeft(done: number, total: number | null | undefined, bytesPerSec: number | null | undefined): string | null {
  if (!total || !bytesPerSec || bytesPerSec <= 0 || done >= total) return null;
  const s = (total - done) / bytesPerSec;
  if (s < 60) return "less than a minute left";
  return `about ${Math.round(s / 60)} min left`;
}

/** After this many failed tries at one version, stop trying on our own and offer the website. */
export const MAX_FAILURES = 3;
