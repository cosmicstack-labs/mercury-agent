import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const KEYS_DIR = join(getMercuryHome(), 'keys');
const PRIVATE_KEY_FILE = join(KEYS_DIR, 'shared_memory_private.key');
const PUBLIC_KEY_FILE = join(KEYS_DIR, 'shared_memory_public.key');

let sodiumModule: any = null;
let sodiumAvailable = false;

try {
  sodiumModule = await import('tweetsodium');
  sodiumAvailable = true;
} catch {
  sodiumAvailable = false;
  logger.warn('tweetsodium is not available — E2E encryption for shared memory is disabled. Install tweetsodium to enable it.');
}

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyBase64: string;
}

export function isE2EAvailable(): boolean {
  return sodiumAvailable;
}

export function getOrCreateKeyPair(): KeyPair | null {
  if (!sodiumAvailable) {
    logger.warn('Cannot create E2E keypair — tweetsodium not available');
    return null;
  }

  if (existsSync(PRIVATE_KEY_FILE) && existsSync(PUBLIC_KEY_FILE)) {
    const privateKey = new Uint8Array(readFileSync(PRIVATE_KEY_FILE));
    const publicKey = new Uint8Array(readFileSync(PUBLIC_KEY_FILE));
    const publicKeyBase64 = Buffer.from(publicKey).toString('base64');
    return { publicKey, privateKey, publicKeyBase64 };
  }

  const keyPair = sodiumModule.keyPair();
  const publicKey = new Uint8Array(keyPair.publicKey);
  const privateKey = new Uint8Array(keyPair.secretKey);

  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true });
  }

  writeFileSync(PRIVATE_KEY_FILE, privateKey);
  writeFileSync(PUBLIC_KEY_FILE, publicKey);

  const publicKeyBase64 = Buffer.from(publicKey).toString('base64');

  logger.info('Generated new E2E keypair for shared memory');
  return { publicKey, privateKey, publicKeyBase64 };
}

export function encryptForRecipient(message: string, recipientPublicKeyBase64: string): string | null {
  if (!sodiumAvailable) {
    logger.warn('Cannot encrypt — tweetsodium not available');
    return null;
  }

  try {
    const recipientPublicKey = new Uint8Array(Buffer.from(recipientPublicKeyBase64, 'base64'));
    const messageBytes = new Uint8Array(Buffer.from(message, 'utf-8'));
    const encrypted = sodiumModule.seal(messageBytes, recipientPublicKey);
    return Buffer.from(encrypted).toString('base64');
  } catch (err) {
    logger.warn({ err }, 'Encryption failed');
    return null;
  }
}

export function decryptFromSender(encryptedBase64: string, keyPair: KeyPair): string | null {
  if (!sodiumAvailable) {
    logger.warn('Cannot decrypt — tweetsodium not available');
    return null;
  }

  try {
    const encryptedBytes = new Uint8Array(Buffer.from(encryptedBase64, 'base64'));
    const decrypted = sodiumModule.sealOpen(encryptedBytes, keyPair.publicKey, keyPair.privateKey);
    return Buffer.from(decrypted).toString('utf-8');
  } catch (err) {
    logger.warn({ err }, 'Decryption failed');
    return null;
  }
}