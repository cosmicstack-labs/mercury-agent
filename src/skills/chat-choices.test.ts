import { describe, expect, it } from 'vitest';
import { chatChoices, chatChoicesNote } from './chat-choices.js';

const SKILLS = ['hyperframes', 'hyperframes-core', 'motion-doctrine', 'web-search', 'docs', 'documents', 'development'];

describe('chosen in this chat', () => {
  it('the showcase chat: hyperframes named loosely, ElevenLabs named, a skill loaded', () => {
    const c = chatChoices([
      { role: 'user', content: 'Use Hyperframe skills and generate beats dropping per scene' },
      { role: 'assistant', content: '[Tool activity in my previous turn]\n- use_skill name=motion-doctrine → ok (170 lines)' },
      { role: 'user', content: 'I meand generate beats by elevenlabs' },
      { role: 'user', content: 'where is video?' },
    ], SKILLS);
    expect(c.skills).toEqual(['hyperframes', 'motion-doctrine']);
    expect(c.services).toEqual(['ElevenLabs']);
    const note = chatChoicesNote(c);
    expect(note).toContain('skills: hyperframes, motion-doctrine');
    expect(note).toContain('services: ElevenLabs');
    expect(note).toContain('never substitute');
  });

  it('"hyper frames", "#docs", and nothing from ordinary words', () => {
    expect(chatChoices([{ role: 'user', content: 'make it using hyper frames please' }], SKILLS).skills).toEqual(['hyperframes']);
    expect(chatChoices([{ role: 'user', content: '#docs write the plan' }], SKILLS).skills).toEqual(['docs']);
    expect(chatChoices([{ role: 'user', content: 'search the web for docs about frames' }], SKILLS)).toEqual({ skills: [], services: [] });
    expect(chatChoicesNote({ skills: [], services: [] })).toBe('');
    // A skill named like an everyday word is not picked by using the word.
    expect(chatChoices([{ role: 'user', content: 'sort my documents and check development progress' }], SKILLS).skills).toEqual([]);
    expect(chatChoices([{ role: 'user', content: 'generate via hyperframes' }], SKILLS).skills).toEqual(['hyperframes']);
  });
});
