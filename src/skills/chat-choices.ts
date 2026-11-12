/**
 * What the owner chose in this chat: skills loaded or named ("use
 * hyperframes", "#hyperframes") and services named ("with ElevenLabs").
 * Re-stated at the top of every later turn of the same chat, because a
 * skill's instructions live in one turn's tool result and drop out of the
 * history; without this, a follow-up ("where is the video?", "use another
 * approach") lost the method and the model swapped in something else.
 *
 * Pure: built from the chat's own messages each turn, nothing stored.
 */

export interface ChatMessageLike {
  role: string;
  content: unknown;
}

/** Services people name for media work, as they write them → how they're passed to the tools. */
const SERVICES: Array<[RegExp, string]> = [
  [/\beleven\s*labs\b/i, 'ElevenLabs'],
  [/\bopen\s*ai\b|\bgpt[- ]?image\b|\bsora\b/i, 'OpenAI'],
  [/\bdeepgram\b/i, 'Deepgram'],
  [/\blyria\b/i, 'Lyria'],
  [/\bveo\b/i, 'Veo'],
  [/\bsuno\b/i, 'Suno'],
  [/\bremotion\b/i, 'Remotion'],
  [/\bffmpeg\b/i, 'ffmpeg'],
];

const squash = (s: string) => s.toLowerCase().replace(/[\s._-]+/g, '');

const proseCache = new Map<string, RegExp>();
/** "hyperframes" as written in prose: any spacing or hyphens, with or without the final s. */
function proseRe(name: string): RegExp {
  let re = proseCache.get(name);
  if (!re) {
    const core = squash(name).replace(/s$/, '');
    re = new RegExp(`\\b${[...core].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]?')}s?\\b`, 'g');
    proseCache.set(name, re);
  }
  re.lastIndex = 0;
  return re;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join(' ');
  return '';
}

/**
 * Skills and services chosen in `messages` (oldest first). A skill counts
 * when it was loaded (`use_skill name=…` in a tool trace), picked with
 * `#name`, or named in the owner's words ("hyperframe", "Hyper Frames").
 * Only names of 5+ letters are matched in prose, so short common words
 * can't select a skill by accident.
 */
export function chatChoices(messages: ChatMessageLike[], skillNames: string[]): { skills: string[]; services: string[] } {
  const skills: string[] = [];
  const services: string[] = [];
  const addSkill = (n: string) => { if (skillNames.includes(n) && !skills.includes(n)) skills.push(n); };
  const byWord = new Map(skillNames.filter((n) => squash(n).length >= 5).map((n) => [squash(n), n]));
  for (const m of messages) {
    const text = textOf(m.content);
    if (!text) continue;
    if (m.role === 'assistant') {
      for (const hit of text.matchAll(/use_skill name=([a-z0-9_:.-]+)/gi)) addSkill(hit[1]);
      continue;
    }
    if (m.role !== 'user') continue;
    for (const hit of text.matchAll(/(?:^|\s)#([a-z0-9_:.-]+)/gi)) addSkill(hit[1]);
    // The owner's words: a skill name written loosely ("hyperframe skill", "via Hyper Frames"),
    // counted only when clearly picked: "skill" in the message, or use/using/via/through right before it.
    const lower = text.toLowerCase();
    const saysSkill = /\bskills?\b/.test(lower);
    for (const [, name] of byWord) {
      for (const hit of lower.matchAll(proseRe(name))) {
        const before = lower.slice(Math.max(0, (hit.index ?? 0) - 12), hit.index ?? 0);
        if (saysSkill || /\b(use|using|via|through)\s+(the\s+)?$/.test(before)) { addSkill(name); break; }
      }
    }
    for (const [re, label] of SERVICES) if (re.test(text) && !services.includes(label)) services.push(label);
  }
  return { skills: skills.slice(-4), services: services.slice(-4) };
}

/** The line for the turn's context, or '' when nothing was chosen. */
export function chatChoicesNote(choices: { skills: string[]; services: string[] }): string {
  if (!choices.skills.length && !choices.services.length) return '';
  const parts: string[] = [];
  if (choices.skills.length) parts.push(`skills: ${choices.skills.join(', ')}`);
  if (choices.services.length) parts.push(`services: ${choices.services.join(', ')}`);
  return [
    `**Chosen in this chat** — ${parts.join('; ')}.`,
    'The owner picked these. Keep using exactly them for this work in every turn of this chat; never substitute another method or service without asking.',
    choices.skills.length ? 'A skill\'s instructions from an earlier turn are no longer in front of you: load it again with use_skill before continuing its work.' : '',
    choices.services.length ? 'Pass a named service to the media tools (the `service` or `model` field).' : '',
  ].filter(Boolean).join(' ');
}
