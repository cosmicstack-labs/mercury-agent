import { describe, expect, it } from 'vitest';
import { normalizeGeneratedSessionTitle } from './title.js';

describe('normalizeGeneratedSessionTitle', () => {
  it('removes wrappers and keeps a concise single-line title', () => {
    expect(normalizeGeneratedSessionTitle('  Title: “Canonical Session Sync”\nExtra explanation')).toBe('Canonical Session Sync');
    expect(normalizeGeneratedSessionTitle('one two')).toBeNull();
  });

  it('limits generated titles to seven words and 80 characters', () => {
    const title = normalizeGeneratedSessionTitle('extraordinary synchronization architecture handles canonical conversation histories safely today');
    expect(title).toBe('extraordinary synchronization architecture handles canonical conversation');
    expect(title!.length).toBeLessThanOrEqual(80);
    expect(title!.split(' ').length).toBeLessThanOrEqual(7);
  });
});
