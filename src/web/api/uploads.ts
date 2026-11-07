/**
 * Owner-supplied files arriving over HTTP.
 *
 * The runtime reads attachments from disk (`src/core/attachments.ts`), the same
 * contract channels use for a WhatsApp photo: `{ kind, path, mime, name }`. A web
 * or API client has bytes, not a path, so this module is the missing half — it
 * validates what arrived and writes it under `<mercury home>/uploads/<yyyy-mm>/`,
 * owned by Mercury and readable only by its user.
 *
 * Only bytes are accepted, never a server path: a client must not be able to make
 * Mercury read a file it could not otherwise reach.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, sep } from 'node:path';
import { getMercuryHome } from '../../utils/config.js';
import type { ChannelAttachment } from '../../types/channel.js';

/** Same caps as the runtime applies when it hands files to the model. */
export const MAX_FILES = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_BYTES = 15 * 1024 * 1024;

export interface InlineAttachment {
  /** Display name; only its basename is kept. */
  name?: string;
  /** Optional hint — the bytes decide. */
  mime?: string;
  /** Base64. A `data:` URL prefix is tolerated and stripped. */
  data: string;
}

export type UploadResult =
  | { ok: true; attachments: ChannelAttachment[] }
  | { ok: false; error: string };

const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const PDF_MIME = 'application/pdf';

/** `<mercury home>/uploads/<yyyy-mm>/` — created on demand. */
export function uploadsDir(now: Date = new Date()): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return join(getMercuryHome(), 'uploads', month);
}

/** Recognises the formats the model can take, from the bytes rather than the label. */
function sniff(bytes: Buffer): { mime: string; kind: 'image' | 'document' } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', kind: 'image' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', kind: 'image' };
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) {
    return { mime: 'image/gif', kind: 'image' };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { mime: 'image/webp', kind: 'image' };
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { mime: PDF_MIME, kind: 'document' };
  }
  return null;
}

/** Keeps the basename, drops traversal and control characters, forces an extension. */
function safeFileName(name: string | undefined, extension: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const useful = cleaned && extname(cleaned).toLowerCase() !== '' ? cleaned : `upload-${randomUUID().slice(0, 8)}${extension}`;
  return useful.replace(/^\.+/, '_');
}

function decode(data: string): Buffer | null {
  const payload = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  if (!payload) return null;
  const bytes = Buffer.from(payload, 'base64');
  // Buffer.from is forgiving and skips bad characters; the magic-byte check
  // in sniff() rejects anything that did not decode to a real file.
  if (bytes.length === 0) return null;
  return bytes;
}

/**
 * Validates and persists the attachments of one request.
 *
 * A rejected attachment rejects the whole request: silently dropping the photo
 * and sending the text alone is the behaviour that makes an owner think the
 * model ignored them.
 */
export function storeInlineAttachments(input: unknown, now: Date = new Date()): UploadResult {
  if (input === undefined || input === null) return { ok: true, attachments: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'attachments must be an array' };
  if (input.length === 0) return { ok: true, attachments: [] };
  if (input.length > MAX_FILES) return { ok: false, error: `at most ${MAX_FILES} attachments per message` };

  const stored: Array<{ attachment: ChannelAttachment; bytes: Buffer }> = [];
  for (const [index, raw] of input.entries()) {
    const item = raw as Partial<InlineAttachment> | null;
    if (!item || typeof item !== 'object' || typeof item.data !== 'string') {
      return { ok: false, error: `attachment ${index + 1} needs base64 "data"` };
    }
    const bytes = decode(item.data);
    if (!bytes) return { ok: false, error: `attachment ${index + 1} is not valid base64` };

    const sniffed = sniff(bytes);
    if (!sniffed) {
      return { ok: false, error: `attachment ${index + 1} is not a supported image (png, jpeg, webp, gif) or PDF` };
    }
    const limit = sniffed.kind === 'image' ? MAX_IMAGE_BYTES : MAX_PDF_BYTES;
    if (bytes.length > limit) {
      return {
        ok: false,
        error: `attachment ${index + 1} is ${Math.round(bytes.length / 1048576)} MB; the limit is ${Math.round(limit / 1048576)} MB`,
      };
    }
    stored.push({
      attachment: {
        kind: sniffed.kind,
        path: '',
        mime: sniffed.mime,
        name: safeFileName(item.name, IMAGE_EXTENSIONS.get(sniffed.mime) ?? '.pdf'),
      },
      bytes,
    });
  }

  const dir = uploadsDir(now);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    ok: true,
    attachments: stored.map(({ attachment, bytes }) => {
      const path = join(dir, `${randomUUID()}-${attachment.name}`);
      writeFileSync(path, bytes, { mode: 0o600 });
      return { ...attachment, path };
    }),
  };
}


// ── Serving stored uploads back to the owner ─────────────────────────────
//
// A sent file is recorded on its message as a REF: "<yyyy-mm>/<file>",
// relative to the uploads root, never an absolute path. Clients fetch it
// through GET /api/chat/uploads/:month/:file (authenticated like every API
// route). Both parts are validated by shape and the resolved file must sit
// directly in that month's folder, so a ref can never reach anything else.

const MONTH_RE = /^\d{4}-\d{2}$/;
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/\\]{1,200}$/i;

export interface AttachmentRef {
  name: string;
  kind: 'image' | 'document';
  mime?: string;
  ref: string;
}

/** The ref of a stored upload path, or null when the path is not one. */
export function uploadRef(path: string): string | null {
  const file = basename(path);
  const month = basename(dirname(path));
  if (!MONTH_RE.test(month) || !FILE_RE.test(file)) return null;
  if (dirname(dirname(path)) !== join(getMercuryHome(), 'uploads')) return null;
  return `${month}/${file}`;
}

/** Message metadata for the attachments of one turn (only real uploads). */
export function attachmentRefs(attachments: unknown): AttachmentRef[] {
  if (!Array.isArray(attachments)) return [];
  const out: AttachmentRef[] = [];
  for (const a of attachments as ChannelAttachment[]) {
    if (!a || typeof a.path !== 'string') continue;
    const ref = uploadRef(a.path);
    if (!ref) continue;
    out.push({ name: a.name ?? basename(a.path), kind: a.kind, ...(a.mime ? { mime: a.mime } : {}), ref });
  }
  return out;
}

/** Resolve a ref from a request to the file on disk, or null. */
export function resolveUploadRef(month: string, file: string): string | null {
  if (!MONTH_RE.test(month) || !FILE_RE.test(file)) return null;
  const root = join(getMercuryHome(), 'uploads', month);
  const path = join(root, file);
  if (!existsSync(path)) return null;
  try {
    const real = realpathSync(path);
    const realRoot = realpathSync(root);
    if (dirname(real) !== realRoot || real.includes(`..${sep}`)) return null;
    return real;
  } catch {
    return null;
  }
}

/** The served type of a stored upload, from its bytes; null for anything else. */
export function uploadMime(bytes: Buffer): string | null {
  return sniff(bytes)?.mime ?? null;
}
