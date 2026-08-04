import { describe, expect, it } from 'vitest';
import { requiresFinalSend } from './response-delivery.js';

describe('response delivery', () => {
  it('does not duplicate a response already rendered by the CLI stream', () => {
    expect(requiresFinalSend('cli', true)).toBe(false);
    expect(requiresFinalSend('cli', false)).toBe(true);
  });

  it('keeps the terminal send for web streams and their completion event', () => {
    expect(requiresFinalSend('web', true)).toBe(true);
  });
});
