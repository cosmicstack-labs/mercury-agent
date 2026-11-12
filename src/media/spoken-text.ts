/**
 * What a voice should actually say. Models writing for text-to-speech often
 * put the directions in with the words: "Here's a natural reading:",
 * "Tone: calm, human, not AI", "[pause]", "(softly)", "Narrator:". A speech
 * service reads every word it gets, so those end up in the audio. Here they
 * come out, and come back separately so the caller can pass them as the
 * style instead.
 */

/** Words that make a parenthetical a stage direction rather than content. */
const CUE = /\b(pause|pauses|beat|softly|quietly|loudly|whisper\w*|laugh\w*|chuckl\w*|sigh\w*|breath\w*|gasp\w*|music|sfx|sound effect|intro|outro|tone|slowly|quickly|excited\w*|calm\w*|warm\w*|dramatic\w*|cheerful\w*|serious\w*|smil\w*|emphasis|emphasi[sz]e\w*|voice ?over|vo|narrat\w*)\b/i;

/** A line that labels the delivery instead of being said ("Tone: calm", "Style — warm and human"). */
const DIRECTION_LINE = /^\s*(?:\*\*|__)?(tone|style|voice|delivery|pace|pacing|mood|direction|directions|instructions?|note|notes|read(?:ing)? (?:it|this)|speak(?:ing)?|performance|emotion|accent|music|sfx|sound)(?:\*\*|__)?\s*[:—–-]\s*.*$/i;
/** A speaker label in front of the words ("Narrator: Meet Mercury."): the label goes, the words stay. */
const SPEAKER_LABEL = /^\s*(?:\*\*|__)?(narrator|voice ?over|vo|host|announcer|speaker(?: \d+)?)(?:\*\*|__)?\s*:\s*/i;
/** An opener addressed to the user, not the listener ("Here's the script:", "Sure! Here is a natural version:"). */
const PREAMBLE = /^\s*(?:(?:sure|okay|ok|alright|great)[,!.]?\s*)?(?:here(?:'s| is| are)|below is|this is)\b[^\n]{0,120}:\s*$/i;
const TITLE = /^\s*(?:#{1,6}\s+.*|(?:\*\*|__)[^*_\n]{1,80}(?:\*\*|__)\s*)$/;

export interface SpokenText {
  /** Only the words to say. */
  text: string;
  /** Directions that were in the text, joined, for the caller to use as the style. */
  directions: string;
}

export function spokenText(raw: string): SpokenText {
  const directions: string[] = [];
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let started = false;
  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { if (started) kept.push(''); continue; }
    if (!started && PREAMBLE.test(trimmed)) continue;
    if (DIRECTION_LINE.test(trimmed)) { directions.push(trimmed.replace(/[*_]/g, '').replace(/^[^:—–-]+[:—–-]\s*/, '')); continue; }
    // A whole line in brackets or parentheses is a cue: "[soft music]", "(pause)".
    if (/^[[(][^\])]{1,120}[\])]\.?$/.test(trimmed)) { directions.push(trimmed.slice(1, -1).replace(/[\])]$/, '')); continue; }
    if (!started && TITLE.test(trimmed)) continue;
    line = line.replace(SPEAKER_LABEL, '');
    // Inline cues: [anything], and (…) only when it reads as a direction.
    line = line.replace(/\s*\[[^\]\n]{1,60}\]\s*/g, (m) => { directions.push(m.trim().slice(1, -1)); return ' '; });
    line = line.replace(/\s*\(([^)\n]{1,60})\)\s*/g, (m, inner: string) => (CUE.test(inner) ? (directions.push(inner), ' ') : m));
    // Markdown that would be read as symbols.
    line = line.replace(/^\s*[-*+•]\s+/, '').replace(/^\s*#{1,6}\s+/, '').replace(/(\*\*|__|\*|_|`)/g, '').replace(/\s{2,}/g, ' ');
    if (line.trim()) { kept.push(line.trim()); started = true; }
  }
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), directions: directions.filter(Boolean).join('; ') };
}

/**
 * Gemini takes the style as words in front of the text ("Say cheerfully:
 * …") and reads anything longer or odder aloud. Only a short description of
 * the voice goes through; meta-requests ("don't make it sound like AI",
 * "as if shared by a person") are dropped.
 */
export function geminiStyle(style: string | undefined): string | undefined {
  const s = (style ?? '').replace(/[.:;!]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  if (s.split(' ').length > 6) return undefined;
  if (/\b(ai|a\.i\.|robot\w*|human|person|shared|share|sound(?:s|ing)? like|make it|don'?t|do not|not|never|no|avoid|instruction\w*|prompt|script|read (?:it|this))\b/i.test(s)) return undefined;
  return s;
}
