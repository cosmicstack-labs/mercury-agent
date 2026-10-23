import { describe, expect, it } from 'vitest';
import { registerSecretValue } from '../../utils/redact.js';
import { appendStderr, renderStderrTail, STDERR_TAIL_CHARS } from './transport.js';

const secret = ['stderr-secret-', 'value-ABCDEFGHIJ'].join('');
registerSecretValue(secret);

describe('stderr tail', () => {
  it('masks a secret in a short tail', () => {
    expect(renderStderrTail(appendStderr('', `token ${secret}\n`))).toBe('token ****\n');
  });

  it('never shows part of a secret when the window cuts through it', () => {
    let raw = appendStderr('', `token ${secret}\n`);
    raw = appendStderr(raw, 'x'.repeat(STDERR_TAIL_CHARS - 15));
    const tail = renderStderrTail(raw);
    expect(tail.length).toBeLessThanOrEqual(STDERR_TAIL_CHARS);
    expect(tail).not.toContain(secret);
    expect(tail).not.toContain(secret.slice(-10));
  });

  it('drops a cut-off first line once the raw buffer is full', () => {
    let raw = appendStderr('', `aaaaa${secret}\nsecond line\n`);
    raw = appendStderr(raw, 'y'.repeat(2 * STDERR_TAIL_CHARS - 20));
    expect(raw.length).toBe(2 * STDERR_TAIL_CHARS);
    const tail = renderStderrTail(raw);
    expect(tail.length).toBeLessThanOrEqual(STDERR_TAIL_CHARS);
    expect(tail).not.toContain(secret.slice(-10));
  });
});
