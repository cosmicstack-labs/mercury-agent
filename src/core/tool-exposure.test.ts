import { describe, expect, it } from 'vitest';
import { selectActiveTools } from './tool-exposure.js';

const ALL = ['read_file', 'write_file', 'run_command', 'spotify_play', 'spotify_pause', 'spotify_search'];

describe('selectActiveTools (ROADMAP P1.4)', () => {
  it('drops Spotify tools from an unrelated turn', () => {
    expect(selectActiveTools(ALL, 'fix the failing test in src/app.ts')).toEqual(['read_file', 'write_file', 'run_command']);
  });

  it('keeps everything when the message is about music', () => {
    expect(selectActiveTools(ALL, 'play some lo-fi on spotify')).toBeUndefined();
    expect(selectActiveTools(ALL, 'skip this track')).toBeUndefined();
  });

  it('keeps everything when recent history is about music', () => {
    expect(selectActiveTools(ALL, 'next one please', ['I put on your focus playlist.'])).toBeUndefined();
  });

  it('only looks at the last few history entries', () => {
    const old = ['playlist', 'a', 'b', 'c', 'd', 'e'];
    expect(selectActiveTools(ALL, 'summarise the README', old)).toEqual(['read_file', 'write_file', 'run_command']);
  });

  it('returns undefined when there is nothing to trim', () => {
    expect(selectActiveTools(['read_file', 'run_command'], 'anything')).toBeUndefined();
  });
});
