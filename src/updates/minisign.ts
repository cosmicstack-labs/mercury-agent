import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * Minisign signatures, in the form `tauri signer sign` writes them: the
 * `.sig` file and the public key are both base64 of the minisign text.
 * The same key signs Mercury Desktop's update packages and the update
 * manifest, so one key decides what "required" means everywhere.
 *
 * Two checks, both must pass:
 *  - the signature over the data: Ed25519 over BLAKE2b-512 of the data
 *    ("ED", what minisign and Tauri make) or over the data itself ("Ed");
 *  - the global signature over that signature and the trusted comment, so
 *    the comment (which names the file and time) can't be swapped either.
 */

export interface MinisignResult {
  ok: boolean;
  /** Why it failed, in plain words. */
  reason?: string;
  /** The signed trusted comment ("timestamp:… file:…") when ok. */
  trustedComment?: string;
}

interface PublicKey { keyId: Buffer; key: Buffer }

/** The text inside, when the value is base64 of a minisign file; otherwise the value as is. */
function unwrap(value: string): string {
  const v = value.trim();
  if (/^untrusted comment:/i.test(v)) return v;
  try {
    const text = Buffer.from(v, 'base64').toString('utf8');
    if (/^untrusted comment:/i.test(text)) return text;
  } catch { /* not base64 */ }
  return v;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function parsePublicKey(value: string): PublicKey | null {
  const text = unwrap(value);
  const keyLine = lines(text).find((l) => !/^untrusted comment:/i.test(l));
  if (!keyLine) return null;
  const raw = Buffer.from(keyLine, 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') return null;
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

function edVerify(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey.toString('base64url') }, format: 'jwk' });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

export function verifyMinisign(data: Buffer | string, signature: string, publicKey: string): MinisignResult {
  const pk = parsePublicKey(publicKey);
  if (!pk) return { ok: false, reason: 'The public key is not a minisign key.' };

  const sigLines = lines(unwrap(signature));
  const body = sigLines.filter((l) => !/^untrusted comment:/i.test(l));
  const sigLine = body[0];
  const trustedLine = body.find((l) => /^trusted comment:/i.test(l));
  const globalLine = trustedLine ? body[body.indexOf(trustedLine) + 1] : undefined;
  if (!sigLine || !trustedLine || !globalLine) return { ok: false, reason: 'The signature is incomplete.' };

  const sig = Buffer.from(sigLine, 'base64');
  if (sig.length !== 74) return { ok: false, reason: 'The signature is malformed.' };
  const alg = sig.subarray(0, 2).toString('latin1');
  const keyId = sig.subarray(2, 10);
  const edSig = sig.subarray(10, 74);
  if (alg !== 'ED' && alg !== 'Ed') return { ok: false, reason: 'Unknown signature algorithm.' };
  if (!keyId.equals(pk.keyId)) return { ok: false, reason: 'Signed with a different key.' };

  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const message = alg === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  if (!edVerify(pk.key, message, edSig)) return { ok: false, reason: 'The signature does not match the data.' };

  const trustedComment = trustedLine.replace(/^trusted comment:\s?/i, '');
  const globalSig = Buffer.from(globalLine, 'base64');
  if (globalSig.length !== 64 || !edVerify(pk.key, Buffer.concat([edSig, Buffer.from(trustedComment, 'utf8')]), globalSig)) {
    return { ok: false, reason: 'The signed comment was changed.' };
  }
  return { ok: true, trustedComment };
}
