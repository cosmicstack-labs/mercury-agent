import { describe, it, expect } from 'vitest';
import { redactPhone, redactUuid, redactIdentity } from './redact.js';

describe('redactPhone', () => {
  it('keeps + country prefix and last 4 digits', () => {
    expect(redactPhone('+15551234567')).toBe('+155****4567');
  });

  it('handles a longer international number', () => {
    expect(redactPhone('+919596087691')).toBe('+919****7691');
  });

  it('masks all but last 2 for very short + numbers', () => {
    expect(redactPhone('+12345')).toBe('+***45');
  });

  it('masks all but last 2 for non-E.164 strings', () => {
    expect(redactPhone('abcdef')).toBe('****ef');
  });

  it('returns empty string for undefined/null/empty', () => {
    expect(redactPhone(undefined)).toBe('');
    expect(redactPhone(null)).toBe('');
    expect(redactPhone('')).toBe('');
  });
});

describe('redactUuid', () => {
  it('keeps only the last 4 chars', () => {
    expect(redactUuid('e5b1c0de-1234-4567-89ab-cdefb20b2')).toBe('****20b2');
  });

  it('returns empty string for undefined', () => {
    expect(redactUuid(undefined)).toBe('');
  });
});

describe('redactIdentity', () => {
  it('treats + values as phone numbers', () => {
    expect(redactIdentity('+15551234567')).toBe('+155****4567');
  });

  it('treats non-+ values as UUIDs', () => {
    expect(redactIdentity('e5b1c0de-1234-4567-89ab-cdefb20b2')).toBe('****20b2');
  });

  it('returns empty string for empty input', () => {
    expect(redactIdentity('')).toBe('');
  });
});
