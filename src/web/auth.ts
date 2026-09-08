import { compareSync, hashSync, genSaltSync } from 'bcryptjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getMercuryHome, loadConfig } from '../utils/config.js';

const SESSION_COOKIE = 'mercury_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

interface WebAuth {
  username: string;
  password_hash: string;
}

function getWebConfigPath(): string {
  return join(getMercuryHome(), 'web-config.json');
}

/** Credential files hold bcrypt hashes and live session tokens — they must
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

export function loadWebAuth(): WebAuth | null {
  const path = getWebConfigPath();
  if (!existsSync(path)) return null;
  try {
    // Repair permissions on files written by older versions (0o644).
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as WebAuth;
  } catch {
    return null;
  }
}

export function saveWebAuth(auth: WebAuth): void {
  const dir = getMercuryHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeCredentialFile(getWebConfigPath(), JSON.stringify(auth, null, 2));
}

/**
 * Initial password is RANDOM per install — a hardcoded default in a public
 * MIT repo is a known credential the moment the source is published. The
 * caller must display the generated password once so the user can log in
 * and change it.
 */
export function initWebAuth(): { username: string; password: string } {
  const existing = loadWebAuth();
  if (existing) {
    return { username: existing.username, password: '' };
  }
  const generated = randomBytes(9).toString('base64url'); // 12 chars, URL-safe
  const salt = genSaltSync(10);
  const hash = hashSync(generated, salt);
  const auth: WebAuth = {
    username: 'mercury',
    password_hash: hash,
  };
  saveWebAuth(auth);
  return { username: 'mercury', password: generated };
}

export function isWebAuthInitialized(): boolean {
  return loadWebAuth() !== null;
}

export function setWebPassword(password: string): void {
  let auth = loadWebAuth();
  if (!auth) {
    auth = { username: 'mercury', password_hash: '' };
  }
  const salt = genSaltSync(10);
  auth.password_hash = hashSync(password, salt);
  saveWebAuth(auth);
}

export function authenticate(username: string, password: string): boolean {
  const auth = loadWebAuth();
  if (!auth) return false;
  if (username !== auth.username) return false;
  try {
    return compareSync(password, auth.password_hash);
  } catch {
    return false;
  }
}

export function changePassword(currentPassword: string, newPassword: string): boolean {
  const auth = loadWebAuth();
  if (!auth) return false;
  if (!authenticate(auth.username, currentPassword)) return false;
  const salt = genSaltSync(10);
  auth.password_hash = hashSync(newPassword, salt);
  saveWebAuth(auth);
  return true;
}

export function changeUsername(currentPassword: string, newUsername: string): boolean {
  const auth = loadWebAuth();
  if (!auth) return false;
  if (!authenticate(auth.username, currentPassword)) return false;
  auth.username = newUsername;
  saveWebAuth(auth);
  return true;
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

interface SessionEntry {
  token: string;
  expiresAt: number;
}

const sessions: Map<string, SessionEntry> = new Map();
const SESSION_FILE = 'web-sessions.json';

function getSessionFilePath(): string {
  return join(getMercuryHome(), SESSION_FILE);
}

function persistSessions(): void {
  try {
    const dir = getMercuryHome();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries = Object.fromEntries(sessions);
    writeCredentialFile(getSessionFilePath(), JSON.stringify(entries, null, 2));
  } catch {}
}

function restoreSessions(): void {
  try {
    const path = getSessionFilePath();
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as Record<string, SessionEntry>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(data)) {
      if (entry.expiresAt > now) {
        sessions.set(key, entry);
      }
    }
  } catch {}
}

// Restore sessions on module load
restoreSessions();

export function createSession(): string {
  const token = createSessionToken();
  sessions.set(token, {
    token,
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
  });
  persistSessions();
  return token;
}

export function validateSession(token: string): boolean {
  const entry = sessions.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string): void {
  sessions.delete(token);
  persistSessions();
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function getSessionMaxAge(): number {
  return SESSION_MAX_AGE;
}

