/**
 * The owner asked for an image outright: `/image [--landscape|--portrait]
 * [--model <ref>] <prompt>`, or the desktop's Image switch (message
 * metadata `media: {kind: "image", aspect?}`). The chat model still runs the
 * turn (it can ask a question, or describe what it made) but is told to call
 * generate_image first, so the request never turns into an SVG.
 */
import type { ChannelMessage } from '../types/channel.js';

export interface MediaIntent {
  kind: 'image';
  prompt: string;
  aspect?: 'square' | 'landscape' | 'portrait';
  model?: string;
}

/** "/image --portrait --model openai::gpt-image-1 a fox" → the request; null when it isn't one. */
export function parseImageCommand(text: string): MediaIntent | null {
  const m = /^\/(?:image|imagine|img)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  let rest = (m[1] ?? '').trim();
  let aspect: MediaIntent['aspect'];
  let model: string | undefined;
  for (;;) {
    const flag = /^--?(landscape|portrait|square|wide|tall|model(?:=|\s+)(\S+))\s*/i.exec(rest);
    if (!flag) break;
    const word = flag[1].toLowerCase();
    if (flag[2]) model = flag[2];
    else aspect = word === 'wide' ? 'landscape' : word === 'tall' ? 'portrait' : word as MediaIntent['aspect'];
    rest = rest.slice(flag[0].length);
  }
  return rest ? { kind: 'image', prompt: rest, ...(aspect ? { aspect } : {}), ...(model ? { model } : {}) } : null;
}

function jobFromMetadata(msg: ChannelMessage, text: string): JobIntent | null {
  const media = msg.metadata?.media as { kind?: unknown; aspect?: unknown } | undefined;
  if (!media || (media.kind !== 'video' && media.kind !== 'music') || !text) return null;
  const aspect = media.aspect === 'portrait' || media.aspect === 'landscape' ? media.aspect : undefined;
  return { kind: media.kind, prompt: text, ...(aspect ? { aspect } : {}) };
}

function fromMetadata(msg: ChannelMessage, text: string): MediaIntent | null {
  const media = msg.metadata?.media as { kind?: unknown; aspect?: unknown; model?: unknown } | undefined;
  if (!media || media.kind !== 'image' || !text) return null;
  const aspect = media.aspect === 'landscape' || media.aspect === 'portrait' || media.aspect === 'square' ? media.aspect : undefined;
  return { kind: 'image', prompt: text, ...(aspect ? { aspect } : {}), ...(typeof media.model === 'string' && media.model ? { model: media.model } : {}) };
}

export function imageRoutingNote(intent: MediaIntent, attachedImages: string[] = []): string {
  const args = [
    intent.aspect ? `aspect "${intent.aspect}"` : '',
    intent.model ? `model "${intent.model}"` : '',
  ].filter(Boolean).join(', ');
  const attached = attachedImages.length
    ? ` They attached ${attachedImages.map((p) => JSON.stringify(p)).join(', ')}: pass it in reference_images when they want it changed or used as a reference.`
    : '';
  return `[Routing] The user asked for an image. Call generate_image now${args ? ` with ${args}` : ''}, turning their request into a detailed prompt (if they refer to an earlier image, pass it in reference_images).${attached} Then reply in a sentence or two. Do not draw it as SVG or code.`;
}

/** Image files sent with this message (already on disk). */
function attachedImagePaths(msg: ChannelMessage): string[] {
  const list = msg.metadata?.attachments;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a): a is { kind: string; path: string } => !!a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'image' && typeof (a as { path?: unknown }).path === 'string')
    .map((a) => a.path)
    .slice(0, 5);
}

/** Put the prompt in place of "/image …" in the user's message, keeping attached files. */
function withPrompt(content: unknown, prompt: string): unknown {
  if (!Array.isArray(content)) return prompt;
  let replaced = false;
  const parts = content.map((part) => {
    if (!replaced && part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      replaced = true;
      return { ...(part as object), text: prompt };
    }
    return part;
  });
  return replaced ? parts : [{ type: 'text', text: prompt }, ...parts];
}

export interface JobIntent {
  kind: 'video' | 'music';
  prompt: string;
  aspect?: 'landscape' | 'portrait';
  seconds?: number;
  instrumental?: boolean;
  model?: string;
}

/** "/video --portrait --seconds 6 a cat surfing", "/music --instrumental lo-fi beat" → the request. */
export function parseJobCommand(text: string): JobIntent | null {
  const m = /^\/(video|music|song)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const kind = m[1].toLowerCase() === 'video' ? 'video' : 'music';
  let rest = (m[2] ?? '').trim();
  const out: Omit<JobIntent, 'prompt'> = { kind };
  for (;;) {
    const flag = /^--?(portrait|landscape|tall|wide|instrumental|seconds(?:=|\s+)(\d+)|model(?:=|\s+)(\S+))\s*/i.exec(rest);
    if (!flag) break;
    const word = flag[1].toLowerCase();
    if (flag[2]) out.seconds = Number(flag[2]);
    else if (flag[3]) out.model = flag[3];
    else if (word === 'instrumental') out.instrumental = true;
    else out.aspect = word === 'portrait' || word === 'tall' ? 'portrait' : 'landscape';
    rest = rest.slice(flag[0].length);
  }
  return rest ? { ...out, prompt: rest } : null;
}

function jobRoutingNote(intent: JobIntent, attachedImages: string[] = []): string {
  const tool = intent.kind === 'video' ? 'generate_video' : 'generate_music';
  const args = [
    intent.aspect ? `aspect "${intent.aspect}"` : '',
    intent.seconds ? `seconds ${intent.seconds}` : '',
    intent.instrumental ? 'instrumental true' : '',
    intent.model ? `model "${intent.model}"` : '',
  ].filter(Boolean).join(', ');
  const attached = intent.kind === 'video' && attachedImages.length
    ? ` They attached ${attachedImages.map((p) => JSON.stringify(p)).join(', ')}: pass it in reference_images to animate it or keep it consistent.`
    : '';
  return `[Routing] The user asked for ${intent.kind === 'video' ? 'a video' : 'music'}. Call ${tool} now${args ? ` with ${args}` : ''}, turning their request into a detailed prompt.${attached} It runs in the background: tell them in one sentence that it is being made and will arrive here.`;
}

/** "/say [--style calm] Good morning!" → the words and how to say them; null when it isn't one. */
export function parseSayCommand(text: string): { text: string; style?: string } | null {
  const m = /^\/(?:say|tts)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  let rest = (m[1] ?? '').trim();
  let style: string | undefined;
  const flag = /^--style(?:=|\s+)("([^"]+)"|(\S+))\s*/i.exec(rest);
  if (flag) {
    style = flag[2] ?? flag[3];
    rest = rest.slice(flag[0].length);
  }
  return rest ? { text: rest, ...(style ? { style } : {}) } : null;
}

/** Rewrite the turn's messages for an explicit image or speech request; does nothing otherwise. */
export function applyMediaIntent(msg: ChannelMessage, trimmed: string, messages: Array<{ role: string; content: unknown }>): MediaIntent | JobIntent | { kind: 'speech'; text: string } | null {
  if (msg.channelType === 'internal') return null;
  const jobCommand = parseJobCommand(trimmed);
  const job = jobCommand ?? jobFromMetadata(msg, trimmed);
  if (job) {
    if (jobCommand && messages.length) {
      const last = messages[messages.length - 1];
      messages[messages.length - 1] = { ...last, role: 'user', content: withPrompt(last.content, jobCommand.prompt) };
    }
    messages.push({ role: 'user', content: jobRoutingNote(job, attachedImagePaths(msg)) });
    return job;
  }
  const say = parseSayCommand(trimmed);
  if (say) {
    if (messages.length) {
      const last = messages[messages.length - 1];
      messages[messages.length - 1] = { ...last, role: 'user', content: withPrompt(last.content, `Say this out loud: ${say.text}`) };
    }
    messages.push({ role: 'user', content: `[Routing] Call generate_speech now with exactly this text${say.style ? ` and style ${JSON.stringify(say.style)}` : ''}: ${JSON.stringify(say.text)}. Then reply in one short sentence.` });
    return { kind: 'speech', text: say.text };
  }
  const command = parseImageCommand(trimmed);
  const intent = command ?? fromMetadata(msg, trimmed);
  if (!intent) return null;
  if (command && messages.length) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { ...last, role: 'user', content: withPrompt(last.content, command.prompt) };
  }
  messages.push({ role: 'user', content: imageRoutingNote(intent, attachedImagePaths(msg)) });
  return intent;
}
