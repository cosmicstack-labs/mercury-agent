/**
 * Session titles: a few words in a narrow sidebar, naming what the
 * conversation is about ("Hyperframes Skill Install", "Q3 Budget Review").
 *
 * The model writes one after the first real exchange; until then (or if it
 * can't), the title comes from the owner's first message with the filler,
 * links and greetings taken out.
 */

export const TITLE_MAX_WORDS = 5;
export const TITLE_MAX_CHARS = 40;

/** System prompt for the title call. */
export const TITLE_SYSTEM_PROMPT = [
  'You name conversations for a sidebar list. You never answer or continue the conversation.',
  'Reply with a 2-4 word title naming its topic: a noun phrase in Title Case, like "Hyperframes Skill Install", "Q3 Budget Review" or "Flight to Lisbon".',
  'Use the language the user wrote in. No quotes, no punctuation at the end, no "Chat about", no explanation. Only the title.',
].join('\n');

/** The title call's prompt: the exchange, fenced so it reads as material, not as a chat to join. */
export function titlePrompt(userMessage: string, assistantMessage: string): string {
  return [
    'Title this conversation.',
    '',
    '<user>',
    userMessage.replace(/^\s*\[[^\]]*\]\s*/, '').slice(0, 1500),
    '</user>',
    '<assistant>',
    assistantMessage.slice(0, 600),
    '</assistant>',
    '',
    'Title (2-4 words):',
  ].join('\n');
}

/** Openings of a reply or a request, never of a title. */
const CHATTY = /^(?:a concise|concise|title|i|i'm|i've|i'll|i'd|im|sure|here|here's|hi|hello|hey|thanks|thank|okay|ok|of course|certainly|great|absolutely|yes|no|sorry|as an|let me|you|you're|this conversation|the user|conversation|chat)\b/i;

/**
 * The model's answer as a title, or null when it isn't one (a sentence from
 * a reply, an empty line, a paragraph).
 */
export function normalizeGeneratedSessionTitle(raw: string): string | null {
  const firstLine = (raw.split(/\r?\n/).find((l) => l.trim()) ?? '')
    .replace(/^\s*(?:title\s*[:\-–]\s*)/i, '')
    .replace(/^[`*_#"'“”‘’\s]+|[`*_"'“”‘’\s]+$/g, '')
    .replace(/[.!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstLine || CHATTY.test(firstLine) || /,$/.test(firstLine) || /[.!?]\s/.test(firstLine)) return null;
  const words = firstLine.split(' ').filter(Boolean);
  if (words.length > TITLE_MAX_WORDS + 3) return null; // a sentence, not a title
  return fit(words) || null;
}

const LEADING_FILLER = /^(?:(?:hey|hi|hello|yo|okay|ok|so|um|uh|well|please|pls|mercury|optimus|and|also|now|then|just|quick question|one more thing)(?:[\s,!.:-]+|$))+/i;
const ASK = /^(?:(?:can|could|would|will) you(?: please)?|i (?:want|need|would like|'d like) (?:you )?to|i want|i need|help me(?: to)?|let'?s|please)\s+/i;

/** A title from the owner's first message: no links, greetings or "can you". */
export function fallbackSessionTitle(content: string): string {
  let text = content
    .replace(/^\s*\[[^\]]*\]\s*/, '') // "[Voice, on the owner's computer: …]" and similar notes
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`*_#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i++) {
    const next = text.replace(LEADING_FILLER, '').replace(ASK, '').trim();
    if (next === text) break;
    text = next;
  }
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? '';
  const words = sentence.replace(/[.!?,;:]+$/g, '').split(' ').filter(Boolean);
  const title = fit(words);
  return title ? title[0].toUpperCase() + title.slice(1) : 'New chat';
}

/** Is this first message too thin to name the conversation ("hi", "hey there")? */
export function isThinOpening(content: string): boolean {
  const left = content.replace(/https?:\/\/\S+/gi, ' link ').replace(LEADING_FILLER, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  return left.split(/\s+/).filter(Boolean).length < 2;
}

/** At most TITLE_MAX_WORDS words and TITLE_MAX_CHARS characters, cut at a word. */
function fit(words: string[]): string {
  let title = '';
  for (const word of words.slice(0, TITLE_MAX_WORDS)) {
    const candidate = title ? `${title} ${word}` : word;
    if (candidate.length > TITLE_MAX_CHARS) break;
    title = candidate;
  }
  if (!title && words[0]) title = words[0].slice(0, TITLE_MAX_CHARS);
  return title.replace(/[,;:\-–]+$/g, '').trim();
}
