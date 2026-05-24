import { describe, expect, it } from 'vitest';
import { extractCookedSubmission, sanitizePrintableInput, shouldUseCookedTextInput } from './input-mode.js';

describe('input-mode helpers', () => {
  it('uses cooked mode for chat and coding text entry only when no prompt is active', () => {
    expect(shouldUseCookedTextInput('chat', false)).toBe(true);
    expect(shouldUseCookedTextInput('coding', false)).toBe(true);
    expect(shouldUseCookedTextInput('workspace', false)).toBe(false);
    expect(shouldUseCookedTextInput('chat', true)).toBe(false);
  });

  it('extracts submitted cooked-mode lines without dropping CJK text', () => {
    expect(extractCookedSubmission('你好，Mercury\r\n')).toBe('你好，Mercury');
    expect(extractCookedSubmission('/chat\n')).toBe('/chat');
    expect(extractCookedSubmission('still composing')).toBeNull();
  });

  it('keeps printable unicode text while stripping control characters', () => {
    expect(sanitizePrintableInput('\u001b[A你好世界🙂\u0000')).toBe('你好世界🙂');
    expect(sanitizePrintableInput('plain text')).toBe('plain text');
  });
});
