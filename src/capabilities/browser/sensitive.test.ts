import { describe, expect, it } from 'vitest';
import { extractHost, looksLikeSensitiveHost, SENSITIVE_DOMAIN_SUFFIXES } from './backends/base.js';

describe('extractHost', () => {
  it('returns the lowercase hostname from a full URL', () => {
    expect(extractHost('https://Example.COM/foo?bar=1')).toBe('example.com');
    expect(extractHost('http://sub.example.org:8080/x')).toBe('sub.example.org');
  });

  it('returns null for invalid URLs', () => {
    expect(extractHost('not a url')).toBeNull();
    expect(extractHost('')).toBeNull();
  });
});

describe('looksLikeSensitiveHost', () => {
  it('matches explicit suffixes exactly', () => {
    expect(looksLikeSensitiveHost('mail.google.com')).toBe(true);
    expect(looksLikeSensitiveHost('chase.com')).toBe(true);
    expect(looksLikeSensitiveHost('accounts.google.com')).toBe(true);
  });

  it('matches subdomains of an explicit suffix', () => {
    expect(looksLikeSensitiveHost('secure.chase.com')).toBe(true);
    expect(looksLikeSensitiveHost('app.coinbase.com')).toBe(true);
  });

  it('matches .gov / .gov.uk TLD suffixes', () => {
    expect(looksLikeSensitiveHost('irs.gov')).toBe(true);
    expect(looksLikeSensitiveHost('hmrc.gov.uk')).toBe(true);
    expect(looksLikeSensitiveHost('agriculture.gc.ca')).toBe(true);
  });

  it('uses banking heuristic for hosts containing the word "bank" or "credit-union"', () => {
    // The heuristic uses \b word boundaries, so it matches "bank" when delimited
    // by non-word chars (hyphens, dots) but not when fused into a larger token.
    expect(looksLikeSensitiveHost('online-banking.example.com')).toBe(true);
    expect(looksLikeSensitiveHost('first-credit-union.com')).toBe(true);
    expect(looksLikeSensitiveHost('my.bank.io')).toBe(true);
    // No word boundary before "bank" → not matched (acceptable: "mybank" could be a non-bank brand)
    expect(looksLikeSensitiveHost('mybank.io')).toBe(false);
  });

  it('returns false for non-sensitive hosts', () => {
    expect(looksLikeSensitiveHost('example.com')).toBe(false);
    expect(looksLikeSensitiveHost('github.com')).toBe(false);
    expect(looksLikeSensitiveHost('news.ycombinator.com')).toBe(false);
  });

  it('does not false-positive on substrings of non-sensitive hosts', () => {
    // "chase" inside a non-domain segment shouldn't match
    expect(looksLikeSensitiveHost('purchase-something.shop')).toBe(false);
    // "gov" must be a TLD suffix, not arbitrary substring
    expect(looksLikeSensitiveHost('governance.example.com')).toBe(false);
  });

  it('SENSITIVE_DOMAIN_SUFFIXES contains expected core entries', () => {
    expect(SENSITIVE_DOMAIN_SUFFIXES).toContain('mail.google.com');
    expect(SENSITIVE_DOMAIN_SUFFIXES).toContain('.gov');
  });
});
