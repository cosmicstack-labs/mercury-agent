/**
 * What every model step sends (ADR-039), applied in `prepareStep` so it
 * shapes each request without changing the conversation the SDK keeps.
 *
 *  1. Old screenshots go. A screen-driving turn looks after every action;
 *     each image was re-sent on every later step. Only the newest
 *     `KEEP_IMAGES` image results stay; older ones become a one-line note.
 *  2. No tool result is larger than `MAX_TOOL_TEXT_CHARS`. Tools bound their
 *     own output; this is the backstop against a payload that slips through
 *     (a base64 blob, a runaway listing) and poisons every later step.
 *  3. Anthropic: the newest two messages carry cache breakpoints, so each
 *     step reads the previous step's conversation from cache instead of
 *     paying for it again (with the system prompt's marker: 3 of the 4
 *     breakpoints Anthropic allows). Other providers cache identical
 *     prefixes on their own and ignore the marker.
 *  4. Screenshots for models whose API takes images only from the user
 *     (ADR-043, route "user-message"): each tool call's images follow its
 *     results as an image message, under the same keep-the-newest rule.
 */

export const KEEP_IMAGES = 2;
export const MAX_TOOL_TEXT_CHARS = 200_000;
const KEEP_EDGE = 20_000;

type Part = Record<string, unknown> & { type?: string };
type Message = Record<string, unknown> & { role?: string; content?: unknown; providerOptions?: Record<string, unknown> };

const IMAGE_NOTE = '[An earlier screenshot was removed to save context — look again if you need the screen.]';

function isBinaryItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const t = (item as Part).type;
  return typeof t === 'string' && t !== 'text' && /image|media|file/.test(t);
}

function outputHasImage(output: unknown): boolean {
  const o = output as { type?: string; value?: unknown } | undefined;
  return !!o && o.type === 'content' && Array.isArray(o.value) && o.value.some(isBinaryItem);
}

function capText(text: string): string {
  if (text.length <= MAX_TOOL_TEXT_CHARS) return text;
  const hidden = text.length - 2 * KEEP_EDGE;
  return `${text.slice(0, KEEP_EDGE)}\n\n[… ${hidden.toLocaleString('en-US')} characters of this tool result were left out to keep the request small …]\n\n${text.slice(-KEEP_EDGE)}`;
}

/** One tool result's output, with images dropped (when `dropImages`) and text capped. Same object when nothing changes. */
function shapeOutput(output: unknown, dropImages: boolean): unknown {
  const o = output as { type?: string; value?: unknown } | undefined;
  if (!o || typeof o !== 'object') return output;
  if ((o.type === 'text' || o.type === 'error-text') && typeof o.value === 'string') {
    const capped = capText(o.value);
    return capped === o.value ? output : { ...o, value: capped };
  }
  if ((o.type === 'json' || o.type === 'error-json') && o.value !== undefined) {
    let serialized: string;
    try { serialized = JSON.stringify(o.value); } catch { return output; }
    if (serialized.length <= MAX_TOOL_TEXT_CHARS) return output;
    return { type: o.type === 'json' ? 'text' : 'error-text', value: capText(serialized) };
  }
  if (o.type === 'content' && Array.isArray(o.value)) {
    let changed = false;
    let droppedImage = false;
    const value: unknown[] = [];
    for (const item of o.value) {
      if (dropImages && isBinaryItem(item)) {
        changed = true;
        if (!droppedImage) value.push({ type: 'text', text: IMAGE_NOTE });
        droppedImage = true;
        continue;
      }
      const part = item as Part;
      if (part?.type === 'text' && typeof part.text === 'string') {
        const capped = capText(part.text);
        if (capped !== part.text) { changed = true; value.push({ ...part, text: capped }); continue; }
      }
      value.push(item);
    }
    return changed ? { ...o, value } : output;
  }
  return output;
}

function withCacheMarker(message: Message): Message {
  const existing = (message.providerOptions ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return {
    ...message,
    providerOptions: { ...existing, anthropic: { ...(existing.anthropic ?? {}), cacheControl: { type: 'ephemeral' } } },
  };
}

/** True for an AI SDK model whose provider id is Anthropic's (`anthropic.messages`, …). */
export function isAnthropicModel(model: unknown): boolean {
  const provider = (model as { provider?: unknown } | undefined)?.provider;
  return typeof provider === 'string' && provider.startsWith('anthropic');
}

/** Marks the image messages added for route "user-message" (so a later step recognises them). */
export const TOOL_IMAGE_LEAD = '[Screenshot from the tool call above';

interface HeldImage { data: string; mimeType: string }

/**
 * Route "user-message": after each run of tool messages, the images their
 * calls returned, as a user message (newest KEEP_IMAGES calls only; older
 * ones get a one-line note). The conversation the SDK keeps is untouched.
 */
function withToolImageMessages(list: Message[], imagesFor: (toolCallId: string) => HeldImage[] | undefined): Message[] {
  // Which calls have images, oldest first.
  const calls: string[] = [];
  for (const m of list) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const p of m.content as Part[]) {
      const id = typeof p?.toolCallId === 'string' ? p.toolCallId : undefined;
      if (p?.type === 'tool-result' && id && imagesFor(id)?.length) calls.push(id);
    }
  }
  if (!calls.length) return list;
  const keep = new Set(calls.slice(-KEEP_IMAGES));
  const out: Message[] = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    out.push(m);
    if (m.role !== 'tool' || list[i + 1]?.role === 'tool') continue;
    // The end of a run of tool messages: what its calls showed.
    const parts: Part[] = [];
    let noted = false;
    for (let j = i; j >= 0 && list[j].role === 'tool'; j--) {
      for (const p of (Array.isArray(list[j].content) ? list[j].content : []) as Part[]) {
        const id = typeof p?.toolCallId === 'string' ? p.toolCallId : undefined;
        const images = id ? imagesFor(id) : undefined;
        if (p?.type !== 'tool-result' || !id || !images?.length) continue;
        if (keep.has(id)) {
          parts.unshift(
            { type: 'text', text: `${TOOL_IMAGE_LEAD} (${String(p.toolName ?? 'tool')})]` },
            ...images.map((img) => ({ type: 'image', image: img.data, mediaType: img.mimeType })),
          );
        } else if (!noted) {
          parts.unshift({ type: 'text', text: IMAGE_NOTE });
          noted = true;
        }
      }
    }
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

/**
 * The messages one step sends. Returns the input array itself when nothing
 * needs to change, so a step without images or oversize results costs nothing.
 */
export function shapeStepMessages<T>(
  messages: readonly T[],
  opts: { anthropicCache?: boolean; toolImages?: { route: 'tool-result' | 'user-message' | 'none'; imagesFor: (toolCallId: string) => HeldImage[] | undefined } } = {},
): T[] {
  const original = messages as unknown as Message[];
  const list = opts.toolImages?.route === 'user-message' ? withToolImageMessages(original, opts.toolImages.imagesFor) : original;
  // Which tool results keep their images: the newest KEEP_IMAGES carrying any.
  const imageResults: Array<[number, number]> = [];
  list.forEach((m, mi) => {
    if (m.role !== 'tool' || !Array.isArray(m.content)) return;
    (m.content as Part[]).forEach((p, pi) => {
      if (p?.type === 'tool-result' && outputHasImage(p.output)) imageResults.push([mi, pi]);
    });
  });
  const drop = new Set(imageResults.slice(0, Math.max(0, imageResults.length - KEEP_IMAGES)).map(([mi, pi]) => `${mi}:${pi}`));

  let changed = false;
  const shaped = list.map((m, mi) => {
    if (m.role !== 'tool' || !Array.isArray(m.content)) return m;
    let partChanged = false;
    const content = (m.content as Part[]).map((p, pi) => {
      if (p?.type !== 'tool-result') return p;
      const output = shapeOutput(p.output, drop.has(`${mi}:${pi}`));
      if (output === p.output) return p;
      partChanged = true;
      return { ...p, output };
    });
    if (!partChanged) return m;
    changed = true;
    return { ...m, content };
  });

  if (opts.anthropicCache) {
    // The newest two non-system messages: this step's write and the
    // previous step's, so the 20-block lookback always finds a cached prefix.
    let marked = 0;
    for (let i = shaped.length - 1; i >= 0 && marked < 2; i--) {
      const m = shaped[i];
      if (m.role === 'system') break;
      shaped[i] = withCacheMarker(m);
      marked++;
      changed = true;
    }
  }
  // `list` is already a new array when screenshots were added (route user-message).
  return (changed ? shaped : list) as unknown as T[];
}
