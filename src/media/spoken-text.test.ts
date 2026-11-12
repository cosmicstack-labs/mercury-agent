import { describe, expect, it } from 'vitest';
import { geminiStyle, spokenText } from './spoken-text.js';

describe('spoken text', () => {
  it('directions written into the script come out and become the style', () => {
    const raw = [
      "Here's a natural reading of today's news:",
      '',
      'Tone: calm and human, not like it was shared by an AI',
      '[soft intro music]',
      'Narrator: Good evening. Five repositories are trending this week. (pause)',
      'The first one is **Zed**, a fast editor.',
    ].join('\n');
    const r = spokenText(raw);
    expect(r.text).toBe('Good evening. Five repositories are trending this week.\nThe first one is Zed, a fast editor.');
    expect(r.directions).toContain('calm and human');
    expect(r.directions).toContain('soft intro music');
    expect(r.directions).toContain('pause');
  });

  it('a plain script is left exactly as it is, parentheses that are content included', () => {
    const poem = 'The river keeps (as rivers do) its own slow time.\n\nAnd I keep mine.';
    expect(spokenText(poem)).toEqual({ text: poem, directions: '' });
  });

  it('a title in front of a poem is not read', () => {
    expect(spokenText('**Morning Rain**\nSoft on the roof, the morning rain.').text).toBe('Soft on the roof, the morning rain.');
  });
});

describe('Gemini style', () => {
  it('a short description of the voice goes through', () => {
    expect(geminiStyle('calm and warm')).toBe('calm and warm');
    expect(geminiStyle('like a news anchor.')).toBe('like a news anchor');
  });
  it('long or meta requests are dropped (Gemini would read them aloud)', () => {
    expect(geminiStyle("naturally, don't make it sound like it was shared by AI")).toBeUndefined();
    expect(geminiStyle('in a natural human voice, as if a person recorded it on their phone')).toBeUndefined();
    expect(geminiStyle('')).toBeUndefined();
  });
});
