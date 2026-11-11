/**
 * What untrusted content the current turn has read (ADR-044).
 *
 * Text the owner didn't write — a file, a web page, search results, command
 * output, an MCP or plugin result, a GitHub issue, an attached document, a
 * message from someone else — can carry instructions aimed at the model.
 * Once a turn has read any, the tool guard asks the owner before actions
 * that persist, escalate or send (schedules, memory, skills, permissions,
 * outbound messages), whatever the permission mode; once an injection
 * attempt was actually found, before anything consequential at all.
 *
 * Per turn (AsyncLocalStorage, ADR-037): one chat reading a poisoned page
 * never affects another chat running at the same time.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ScopedValue } from '../utils/turn-scope.js';
import type { InjectionFinding } from './injection-scan.js';

export interface ExposureSource {
  /** "read_file /Users/me/Downloads/weather.html", "fetch_url https://…", "an attached file". */
  label: string;
  findings?: InjectionFinding[];
}

export interface Exposure {
  sources: ExposureSource[];
  /** An injection attempt was found in something this turn read. */
  suspicious: boolean;
}

const MAX_SOURCES = 12;
const empty = (): Exposure => ({ sources: [], suspicious: false });
const current = new ScopedValue<Exposure>(empty());
/**
 * A sub-agent runs with what its parent had read when it delegated (the
 * supervisor snapshots it at spawn, like the permission context): a
 * delegated agent can't launder an injection by starting clean.
 */
const inherited = new AsyncLocalStorage<{ e: Exposure }>();

export function runWithExposure<T>(e: Exposure, fn: () => T): T {
  return inherited.run({ e: { sources: [...e.sources], suspicious: e.suspicious } }, fn);
}

/** Give the calling turn its own record, starting clean (no-op outside a turn). */
export function claimExposureForTurn(): void {
  current.claim(empty());
}

export function exposure(): Exposure {
  return inherited.getStore()?.e ?? current.get();
}

export function noteExposure(source: ExposureSource): void {
  const box = inherited.getStore();
  const e = box?.e ?? current.get();
  const suspicious = e.suspicious || !!source.findings?.length;
  // The same source twice adds nothing; a suspicious one always goes in front.
  const known = e.sources.some((s) => s.label === source.label);
  const sources = known
    ? e.sources.map((s) => (s.label === source.label && source.findings?.length ? { ...s, findings: source.findings } : s))
    : source.findings?.length
      ? [source, ...e.sources].slice(0, MAX_SOURCES)
      : [...e.sources, source].slice(0, MAX_SOURCES);
  if (box) box.e = { sources, suspicious };
  else current.set({ sources, suspicious });
}

/** Test hook. */
export function resetExposure(): void {
  current.setGlobal(empty());
  current.set(empty());
}

/** "weather.html (read_file) — hidden instructions found; https://… (fetch_url)" for an approval prompt. */
export function describeExposure(e: Exposure): string {
  const lines = e.sources.slice(0, 5).map((s) => {
    const f = s.findings?.[0];
    return `- ${s.label}${f ? ` — contains instructions to an AI: "${f.excerpt}"` : ''}`;
  });
  if (e.sources.length > 5) lines.push(`- …and ${e.sources.length - 5} more`);
  return lines.join('\n');
}
