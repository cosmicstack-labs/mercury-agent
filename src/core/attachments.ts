/**
 * Files a chat message carries (photos, PDFs) handed to the model as real
 * content, so "what is this?" about a photo works instead of the model seeing
 * only a file path. Channels put them in `msg.metadata.attachments` as
 * `{ kind, path, mime?, name? }` (WhatsApp does today).
 *
 * Only models that can take them get them: a text-only model would reject
 * the whole request, so it gets the path and a note instead.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ChannelMessage } from '../types/channel.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 4;

interface Attachment {
  kind: string;
  path: string;
  mime?: string;
  name?: string;
}

const IMAGE_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

/** Models that accept image input. Conservative: unknown models get the note instead. */
export function modelSeesImages(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  if (provider === 'deepseek') return false;
  if (/gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|\bo[134](-|$)|claude|gemini|pixtral|llava|qwen.*vl|vision|grok-(2-vision|4)|llama-?4|mistral-(medium|small)-3|gemma-?3/.test(m)) return true;
  return false;
}

/** Models that accept PDF documents directly. */
export function modelReadsPdf(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  if (provider === 'anthropic' || /claude/.test(m)) return true;
  if (/gemini/.test(m)) return true;
  if (provider === 'openai' && /gpt-4o|gpt-4\.1|gpt-5|\bo[34](-|$)/.test(m)) return true;
  return false;
}

export function attachmentsOf(msg: ChannelMessage): Attachment[] {
  const raw = msg.metadata?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Attachment => !!a && typeof (a as Attachment).path === 'string' && typeof (a as Attachment).kind === 'string')
    .slice(0, MAX_FILES);
}

function isPdf(a: Attachment): boolean {
  return a.mime === 'application/pdf' || extname(a.path).toLowerCase() === '.pdf';
}

/**
 * The current turn's user message with its photos and PDFs attached, for
 * this provider and model. Returns the messages unchanged when there is
 * nothing to attach or the model can't take it.
 */
export function withAttachments<T extends { role: string; content: unknown }>(messages: T[], msg: ChannelMessage, provider: string, model: string): T[] {
  const files = attachmentsOf(msg);
  if (!files.length) return messages;
  const parts: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  for (const a of files) {
    if (!existsSync(a.path)) continue;
    const size = statSync(a.path).size;
    if (a.kind === 'image') {
      const mediaType = a.mime?.startsWith('image/') ? a.mime : IMAGE_MIME[extname(a.path).toLowerCase()] ?? 'image/jpeg';
      if (!modelSeesImages(provider, model)) notes.push(`The current model (${model}) can't view images; say so, and offer to describe it with a vision model if one is configured.`);
      else if (size > MAX_IMAGE_BYTES) notes.push(`An image is too large to view (${Math.round(size / 1048576)} MB).`);
      else parts.push({ type: 'image', image: readFileSync(a.path), mediaType });
    } else if (isPdf(a)) {
      if (modelReadsPdf(provider, model) && size <= MAX_PDF_BYTES) parts.push({ type: 'file', data: readFileSync(a.path), mediaType: 'application/pdf', filename: a.name ?? basename(a.path) });
    }
  }
  if (!parts.length && !notes.length) return messages;
  // The last user message is this turn's (history comes first).
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { idx = i; break; }
  }
  if (idx < 0) return messages;
  const current = messages[idx];
  const text = typeof current.content === 'string' ? current.content : msg.content;
  const content = [{ type: 'text', text: notes.length ? `${text}\n\n(${notes.join(' ')})` : text }, ...parts];
  const out = messages.slice();
  out[idx] = { ...current, content } as T;
  return out;
}
