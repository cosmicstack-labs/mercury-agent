/**
 * A bot's face, arriving from a client.
 *
 * Same rule as chat attachments: only bytes, never a path, and the bytes decide
 * the format. An avatar is a picture and nothing else — a PDF or a text file in
 * this slot would be served back to a dashboard that expects an image.
 */
/**
 * Image formats the roster can serve, recognised by signature. Kept local to the
 * avatar slot rather than shared with chat attachments so this change stands on
 * its own; the two will want one detector once both land.
 */
export function detectImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Small on purpose: it is a face in a roster, not a photo library. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export type AvatarInput =
  | { ok: true; bytes: Buffer; mime: string }
  | { ok: false; error: string };

/** Reads `{ data: <base64> }`, tolerating a `data:` URL prefix. */
export function decodeAvatarInput(body: unknown): AvatarInput {
  const data = (body as { data?: unknown } | null)?.data;
  if (typeof data !== 'string' || data.length === 0) {
    return { ok: false, error: 'avatar needs base64 "data"' };
  }
  const payload = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return { ok: false, error: 'avatar is not valid base64' };
  if (bytes.length > MAX_AVATAR_BYTES) {
    return { ok: false, error: `avatar is ${Math.round(bytes.length / 1048576)} MB; the limit is 2 MB` };
  }
  const mime = detectImage(bytes);
  if (!mime) return { ok: false, error: 'avatar must be a png, jpeg, webp or gif image' };
  return { ok: true, bytes, mime };
}
