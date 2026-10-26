import { describe, expect, it } from 'vitest';
import { parseJsonLenient } from './json.js';

describe('parseJsonLenient', () => {
  it('parses plain and fenced JSON', () => {
    expect(parseJsonLenient('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseJsonLenient('```json\n{"ops": []}\n```')).toEqual({ ops: [] });
    expect(parseJsonLenient('Sure! Here it is:\n```json\n{"ops":[{"op":"support","beliefId":"x"}]}')).toEqual({ ops: [{ op: 'support', beliefId: 'x' }] });
  });
  it('repairs output cut off by the token limit', () => {
    const cut = '{"ops":[{"op":"support","beliefId":"a","excerpt":"fine"},{"op":"create","kind":"trait","statement":"Prefers short re';
    const v = parseJsonLenient(cut) as { ops: unknown[] };
    expect(Array.isArray(v.ops)).toBe(true);
    expect(v.ops[0]).toEqual({ op: 'support', beliefId: 'a', excerpt: 'fine' });
    const cut2 = '{"ops":[{"op":"support","beliefId":"a","excerpt":"x"}],"merges":[],"brief":{"about":"Works on Mercury and';
    const v2 = parseJsonLenient(cut2) as { ops: unknown[]; brief?: { about?: string } };
    expect(v2.ops).toHaveLength(1);
  });
  it('returns null for prose', () => {
    expect(parseJsonLenient('I learned nothing today.')).toBeNull();
  });
});

import { ownerWords } from './text.js';
describe('ownerWords', () => {
  it('strips bracketed channel guidance and keeps what the owner said', () => {
    expect(ownerWords("[Voice call: the owner asked this out loud. Use your tools…]\nclear the old logs")).toBe('clear the old logs');
    expect(ownerWords('[A]\n[B: more]\n  shorter please ')).toBe('shorter please');
    expect(ownerWords('plain message [with brackets] inside')).toBe('plain message [with brackets] inside');
  });
});

import { asksAboutSelf, looksLikeIdentity, looksLikeSecret } from './text.js';
describe('looksLikeSecret', () => {
  it('flags credentials and leaves ordinary statements alone', () => {
    expect(looksLikeSecret('Temp mail account with password MercuryTemp2026!')).toBe(true);
    expect(looksLikeSecret('uses api key sk-abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
    expect(looksLikeSecret('Prefers one command over many manual steps')).toBe(false);
    expect(looksLikeSecret('Works on Mercury Agent at Cosmic Stack')).toBe(false);
  });
});

describe('looksLikeIdentity', () => {
  it('keeps who the owner is out of the belief store (config is the one source)', () => {
    expect(looksLikeIdentity("The owner's name is Salman")).toBe(true);
    expect(looksLikeIdentity('Email is salman@example.org')).toBe(true);
    expect(looksLikeIdentity('Goes by hotheadhacker on GitHub')).toBe(true);
    expect(looksLikeIdentity('Prefers terse replies in the evening')).toBe(false);
    expect(looksLikeIdentity('Works on Mercury, an AI agent')).toBe(false);
  });
});

describe('asksAboutSelf', () => {
  it('spots the owner asking what Mercury knows about them', () => {
    expect(asksAboutSelf('What do you know about me?')).toBe(true);
    expect(asksAboutSelf('do you remember my preferences')).toBe(true);
    expect(asksAboutSelf('what have you learned so far')).toBe(true);
    expect(asksAboutSelf('[Voice call: …] tell me about myself')).toBe(true);
    expect(asksAboutSelf('convert this epub with pandoc')).toBe(false);
    expect(asksAboutSelf('what do you know about Rust lifetimes')).toBe(false);
  });
});
