import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const KEYS_DIR = join(getMercuryHome(), 'keys');
const PRIVATE_KEY_FILE = join(KEYS_DIR, 'shared_memory_private.key');
const PUBLIC_KEY_FILE = join(KEYS_DIR, 'shared_memory_public.key');

let sodium: any = null;
let sodiumAvailable = false;

let sealFn: ((message: Uint8Array, publicKey: Uint8Array) => Uint8Array) | null = null;
let sealOpenFn: ((ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array) => Uint8Array) | null = null;

try {
  const mod = await import('libsodium-wrappers');
  sodium = mod.default || mod;
  await sodium.ready;
  sealFn = sodium.crypto_box_seal.bind(sodium);
  sealOpenFn = sodium.crypto_box_seal_open.bind(sodium);
  sodiumAvailable = true;
} catch {
  try {
    const mod = await import('tweetsodium');
    sodium = mod;
    sealFn = sodium.seal.bind(sodium);
    sealOpenFn = sodium.sealOpen.bind(sodium);
    sodiumAvailable = true;
  } catch {
    sodiumAvailable = false;
    logger.warn('libsodium-wrappers/tweetsodium not available — E2E encryption for shared memory is disabled.');
  }
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
    logger.warn('Cannot create E2E keypair — libsodium not available');
    return null;
  }

  if (existsSync(PRIVATE_KEY_FILE) && existsSync(PUBLIC_KEY_FILE)) {
    const privateKey = new Uint8Array(readFileSync(PRIVATE_KEY_FILE));
    const publicKey = new Uint8Array(readFileSync(PUBLIC_KEY_FILE));
    const publicKeyBase64 = Buffer.from(publicKey).toString('base64');
    return { publicKey, privateKey, publicKeyBase64 };
  }

  try {
    let keyPair: { publicKey: Uint8Array; privateKey: Uint8Array };

    if (sodium.crypto_box_keypair) {
      const kp = sodium.crypto_box_keypair();
      keyPair = {
        publicKey: new Uint8Array(kp.publicKey),
        privateKey: new Uint8Array(kp.privateKey),
      };
    } else if (sodium.keyPair) {
      const kp = sodium.keyPair();
      keyPair = {
        publicKey: new Uint8Array(kp.publicKey),
        privateKey: new Uint8Array(kp.secretKey),
      };
    } else {
      logger.warn('No keypair generation function available in sodium');
      return null;
    }

    if (!existsSync(KEYS_DIR)) {
      mkdirSync(KEYS_DIR, { recursive: true });
    }

    writeFileSync(PRIVATE_KEY_FILE, keyPair.privateKey);
    writeFileSync(PUBLIC_KEY_FILE, keyPair.publicKey);

    const publicKeyBase64 = Buffer.from(keyPair.publicKey).toString('base64');

    logger.info('Generated new E2E keypair for shared memory');
    return { ...keyPair, publicKeyBase64 };
  } catch (err) {
    logger.warn({ err }, 'Failed to generate E2E keypair');
    return null;
  }
}

export function encryptForRecipient(message: string, recipientPublicKeyBase64: string): string | null {
  if (!sodiumAvailable || !sealFn) {
    logger.warn('Cannot encrypt — libsodium not available');
    return null;
  }

  try {
    const recipientPublicKey = new Uint8Array(Buffer.from(recipientPublicKeyBase64, 'base64'));
    const messageBytes = new Uint8Array(Buffer.from(message, 'utf-8'));
    const encrypted = sealFn(messageBytes, recipientPublicKey);
    return Buffer.from(encrypted).toString('base64');
  } catch (err) {
    logger.warn({ err }, 'Encryption failed');
    return null;
  }
}

export function decryptFromSender(encryptedBase64: string, keyPair: KeyPair): string | null {
  if (!sodiumAvailable || !sealOpenFn) {
    logger.warn('Cannot decrypt — libsodium not available');
    return null;
  }

  try {
    const encryptedBytes = new Uint8Array(Buffer.from(encryptedBase64, 'base64'));
    const decrypted = sealOpenFn(encryptedBytes, keyPair.publicKey, keyPair.privateKey);
    return Buffer.from(decrypted).toString('utf-8');
  } catch (err) {
    logger.warn({ err }, 'Decryption failed');
    return null;
  }
}