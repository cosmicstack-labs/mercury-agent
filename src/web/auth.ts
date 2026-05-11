import { compareSync, hashSync, genSaltSync } from 'bcryptjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
  writeFileSync(getWebConfigPath(), JSON.stringify(auth, null, 2), 'utf-8');
}

const DEFAULT_PASSWORD = 'Mercury@123';

export function initWebAuth(): { username: string; password: string } {
  const existing = loadWebAuth();
  if (existing) {
    return { username: existing.username, password: '' };
  }
  const salt = genSaltSync(10);
  const hash = hashSync(DEFAULT_PASSWORD, salt);
  const auth: WebAuth = {
    username: 'mercury',
    password_hash: hash,
  };
  saveWebAuth(auth);
  return { username: 'mercury', password: '' };
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
    writeFileSync(getSessionFilePath(), JSON.stringify(entries, null, 2), 'utf-8');
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

