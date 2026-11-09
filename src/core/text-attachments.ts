import { extname } from 'node:path';

/** Bound both storage and prompt cost, independently of the model's context size. */
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_TEXT_CHARS = 16_000;
export const MAX_TOTAL_TEXT_CHARS = 32_000;

export function textAttachmentMime(name?: string, mime?: string): string | null {
  const extension = extname(name ?? '').toLowerCase();
  if (extension === '.txt') return 'text/plain';
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  // An unnamed API upload can declare its format. An unrelated extension is
  // never made into a text attachment merely by claiming a text MIME type.
  if (extension) return null;
  const type = mime?.split(';', 1)[0].trim().toLowerCase();
  if (type === 'text/plain') return 'text/plain';
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'text/markdown';
  return null;
}

/** Fail closed on malformed UTF-8 and binary controls (including UTF-16 NULs). */
export function decodeTextAttachment(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_TEXT_BYTES) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/** Do not split a supplementary Unicode character at the context boundary. */
export function textPrefix(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}
