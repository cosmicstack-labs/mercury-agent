import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { getMercuryHome } from '../utils/config.js';

export const WHATSAPP_AUTH_DIR = () => join(getMercuryHome(), 'whatsapp-auth');

export function authDirExists(): boolean {
  const dir = WHATSAPP_AUTH_DIR();
  return fs.existsSync(dir) && fs.existsSync(path.join(dir, 'creds.json'));
}

export function ensureAuthDir(): string {
  const dir = WHATSAPP_AUTH_DIR();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // chmod may fail on some platforms, continue anyway
  }
  return dir;
}

export function deleteAuthDir(): void {
  const dir = WHATSAPP_AUTH_DIR();
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info('WhatsApp auth data deleted');
  }
}

export function validateAuthState(): boolean {
  const dir = WHATSAPP_AUTH_DIR();
  if (!fs.existsSync(dir)) return false;
  const credsPath = path.join(dir, 'creds.json');
  if (!fs.existsSync(credsPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    return !!(data.me && data.me.id);
  } catch {
    return false;
  }
}