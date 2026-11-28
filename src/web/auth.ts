import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getMercuryHome, loadConfig } from '../utils/config.js';

const SESSION_COOKIE = 'mercury_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

function getWebConfigPath(): string {
  return join(getMercuryHome(), 'web-config.json');
}

/** Credential files hold live session tokens — they must
 *  never be world-readable. Also repairs files written by older versions. */
function writeCredentialFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch { /* mode repair is best-effort */ }
}

export function getWebPort(): number {
  const envPort = parseInt(process.env.MERCURY_PORT || '', 10);
  if (envPort > 0 && envPort < 65536) return envPort;
  try {
    const config = loadConfig();
    if (config.web?.port && config.web.port > 0 && config.web.port < 65536) {
      return config.web.port;
    }
  } catch {}
  return 6174;
}

const ATTACH_TOKEN_FILE = 'attach-token';

function getAttachTokenPath(): string {
  return join(getMercuryHome(), ATTACH_TOKEN_FILE);
}

/**
 * Machine-local token for attach clients (`mercury attach`). The runtime
 * rotates it at every boot; the file is 0600 (owner-only), the same trust
 * level as the config that already holds provider API keys. A second
 * terminal on the same machine reads it and authenticates with Bearer —
 * no web-login round-trip.
 */
export function writeAttachToken(): void {
  try {
    const home = getMercuryHome();
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    writeCredentialFile(getAttachTokenPath(), randomBytes(32).toString('hex'));
  } catch {
    // Best-effort: without the token file, attach clients cannot connect,
    // but the runtime itself is unaffected.
  }
}

/** Constant-time check of a presented attach token. */
export function attachTokenMatches(presented: string): boolean {
  const expected = readAttachToken();
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readAttachToken(): string | null {
  try {
    const token = readFileSync(getAttachTokenPath(), 'utf-8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}


/**
 * Mercury has no password (ADR-050): browsers, Desktop and phones sign in
 * with a device token, a pairing code or a one-time link made on this
 * computer. An install from before that still has web-config.json with a
 * password hash in it; remove it so the old password is gone for good.
 */
export function retirePasswordSignIn(): boolean {
  const path = getWebConfigPath();
  if (!existsSync(path)) return false;
  try { rmSync(path, { force: true }); return true; } catch { return false; }
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

interface SessionEntry {
  expiresAt: number;
}

/**
 * Live browser sessions, by a SHA-256 of the token (the token itself is only
 * in the browser's cookie): a copied sessions file can't be replayed.
 */
const sessions: Map<string, SessionEntry> = new Map();
const SESSION_FILE = 'web-sessions.json';

const sessionHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** A short, non-secret key for a session (to find its open streams). */
export function sessionKey(token: string): string {
  return sessionHash(token).slice(0, 16);
}

function getSessionFilePath(): string {
  return join(getMercuryHome(), SESSION_FILE);
}

function persistSessions(): void {
  try {
    const dir = getMercuryHome();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries = Object.fromEntries([...sessions].map(([hash, e]) => [hash, { expiresAt: e.expiresAt }]));
    writeCredentialFile(getSessionFilePath(), JSON.stringify({ version: 2, sessions: entries }, null, 2));
  } catch {}
}

function restoreSessions(): void {
  try {
    const path = getSessionFilePath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { version?: number; sessions?: Record<string, SessionEntry> } & Record<string, unknown>;
    const now = Date.now();
    // Version 1 kept the raw token as the key: hash it on the way in.
    const v2 = raw.version === 2 && raw.sessions && typeof raw.sessions === 'object';
    const entries = (v2 ? raw.sessions : raw) as Record<string, SessionEntry>;
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) continue;
      sessions.set(v2 ? key : sessionHash(key), { expiresAt: entry.expiresAt });
    }
    if (!v2) persistSessions();
  } catch {}
}

// Restore sessions on module load
restoreSessions();

export function createSession(): string {
  const token = createSessionToken();
  sessions.set(sessionHash(token), { expiresAt: Date.now() + SESSION_MAX_AGE * 1000 });
  persistSessions();
  return token;
}

export function validateSession(token: string): boolean {
  const hash = sessionHash(token);
  const entry = sessions.get(hash);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(hash);
    return false;
  }
  return true;
}

export function destroySession(token: string): void {
  sessions.delete(sessionHash(token));
  persistSessions();
}

/** Sign every browser out (a password change), except `keep`; returns the keys of the sessions ended. */
export function destroyAllSessions(keep?: string): string[] {
  const keepHash = keep ? sessionHash(keep) : null;
  const ended: string[] = [];
  for (const hash of [...sessions.keys()]) {
    if (hash === keepHash) continue;
    sessions.delete(hash);
    ended.push(hash.slice(0, 16));
  }
  persistSessions();
  return ended;
}

export function sessionCount(): number {
  const now = Date.now();
  return [...sessions.values()].filter((e) => e.expiresAt > now).length;
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function getSessionMaxAge(): number {
  return SESSION_MAX_AGE;
}

