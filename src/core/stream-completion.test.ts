import { describe, expect, it } from 'vitest';
import { classifyStreamCompletion, isLengthTruncation, truncationContinuationPrompt } from './stream-completion.js';

describe('stream completion classification', () => {
  it('treats clean finish reasons as complete', () => {
    expect(classifyStreamCompletion({ finishReason: 'stop', hasText: true })).toBe('complete');
    expect(classifyStreamCompletion({ finishReason: 'tool-calls', hasText: false })).toBe('complete');
    expect(classifyStreamCompletion({ finishReason: 'content-filter', hasText: false })).toBe('complete');
  });

  it('treats output-limit hits as truncated', () => {
    expect(classifyStreamCompletion({ finishReason: 'length', hasText: true })).toBe('truncated');
  });

  it('treats a missing finish signal as interrupted (provider drop)', () => {
    // The regression: the AI SDK leaves per-step finishReason at 'other'
    // when the provider connection drops mid-stream. This must never count
    // as a completed task.
    expect(classifyStreamCompletion({ finishReason: 'other', hasText: true })).toBe('interrupted');
    expect(classifyStreamCompletion({ finishReason: 'other', hasText: false })).toBe('interrupted');
    expect(classifyStreamCompletion({ finishReason: undefined, hasText: false })).toBe('interrupted');
    expect(classifyStreamCompletion({ finishReason: null, hasText: true })).toBe('interrupted');
    expect(classifyStreamCompletion({ finishReason: 'unknown', hasText: false })).toBe('interrupted');
  });

  it('treats explicit errors as interrupted', () => {
    expect(classifyStreamCompletion({ finishReason: 'error', hasText: false })).toBe('interrupted');
  });

  it('flags length truncation for continuation logic', () => {
    expect(isLengthTruncation('length')).toBe(true);
    expect(isLengthTruncation('stop')).toBe(false);
    expect(isLengthTruncation(undefined)).toBe(false);
  });

  it('builds a bounded continuation nudge', () => {
    const prompt = truncationContinuationPrompt('build the light bulb app');
    expect(prompt).toContain('output-token limit');
    expect(prompt).toContain('build the light bulb app');
    expect(prompt.length).toBeLessThan(400);
    const hint = 'x'.repeat(500);
    // Hint is capped at 200 chars; the wrapper text adds ~180 more.
    const bounded = truncationContinuationPrompt(hint);
    expect(bounded.length).toBeLessThan(450);
    expect(bounded).not.toContain('x'.repeat(250));
  });
});