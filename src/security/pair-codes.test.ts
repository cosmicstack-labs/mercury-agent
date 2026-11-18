import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { PAIR_CODE_TTL_MS, PairCodes, groupPairCode, normalizePairCode, pairLink } from './pair-codes.js';
import { readAudit } from './audit.js';

let home: string;
const previous = process.env.MERCURY_HOME;
let t = 1_000_000;
const clock = () => t;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-pair-codes-'));
  process.env.MERCURY_HOME = home;
  t = 1_000_000;
});

afterEach(() => {
  if (previous === undefined) delete process.env.MERCURY_HOME; else process.env.MERCURY_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

const ADDRESS = 'https://mercury.tail1234.ts.net';

describe('pairing codes', () => {
  it('makes a 25-character Crockford code, grouped in fives, inside a mercury:// link', () => {
    const shown = new PairCodes(clock).create(ADDRESS, 'cli');
    expect(shown.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{25}$/);
    expect(shown.display).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/);
    expect(shown.display.replace(/-/g, '')).toBe(shown.code);
    expect(shown.url).toBe(`mercury://pair?u=https%3A%2F%2Fmercury.tail1234.ts.net&c=${shown.code}`);
    expect(shown.expiresAt).toBe(t + PAIR_CODE_TTL_MS);
    expect(shown.address).toBe(ADDRESS);
  });

  it('reads a typed code the way people type it', () => {
    expect(normalizePairCode('abcde-0o1il xyz')).toBe('ABCDE00111XYZ');
    expect(groupPairCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
    expect(pairLink('http://192.168.1.5:6174', 'X')).toBe('mercury://pair?u=http%3A%2F%2F192.168.1.5%3A6174&c=X');
  });

  it('accepts the code lower-case, with dashes and spaces', () => {
    const codes = new PairCodes(clock);
    const shown = codes.create(ADDRESS, 'cli');
    expect(codes.match(shown.display.toLowerCase().replace(/-/g, ' '))).toEqual({ id: shown.id, by: 'cli' });
  });

  it('keeps only a hash of the code', () => {
    const codes = new PairCodes(clock);
    const shown = codes.create(ADDRESS, 'cli');
    expect(inspect(codes, { depth: 6 })).not.toContain(shown.code);
  });

  it('refuses a wrong code and a code when none is active', () => {
    const codes = new PairCodes(clock);
    expect(codes.match('ABCDE-FGHJK-MNPQR-STVWX-YZ012')).toBeNull();
    codes.create(ADDRESS, 'cli');
    expect(codes.match('ABCDE-FGHJK-MNPQR-STVWX-YZ012')).toBeNull();
    expect(codes.match('')).toBeNull();
  });

  it('works once', async () => {
    const codes = new PairCodes(clock);
    const shown = codes.create(ADDRESS, 'desktop');
    const outcome = codes.wait(shown.id);
    expect(codes.status(shown.id)).toBe('waiting');
    const found = codes.match(shown.code)!;
    expect(codes.redeemed(found.id, { name: 'Pixel 9', platform: 'android' }, '100.101.102.103')).toBe(true);
    expect(await outcome).toEqual({ status: 'paired', device: { name: 'Pixel 9', platform: 'android' } });
    expect(codes.match(shown.code)).toBeNull();
    expect(codes.redeemed(found.id, { name: 'Again', platform: 'ios' })).toBe(false);
    expect(codes.status(shown.id)).toEqual({ status: 'paired', device: { name: 'Pixel 9', platform: 'android' } });
  });

  it('expires after 5 minutes', async () => {
    const codes = new PairCodes(clock);
    const shown = codes.create(ADDRESS, 'cli');
    const outcome = codes.wait(shown.id);
    t += PAIR_CODE_TTL_MS;
    expect(codes.match(shown.code)).not.toBeNull();
    t += 1;
    expect(codes.match(shown.code)).toBeNull();
    expect(await outcome).toEqual({ status: 'expired' });
    expect(readAudit(5).map((e) => [e.kind, e.detail])).toContainEqual(['pair.code.expired', '(not used in 5 minutes)']);
  });

  it('keeps one code at a time: a new one replaces the old', async () => {
    const codes = new PairCodes(clock);
    const first = codes.create(ADDRESS, 'cli');
    const outcome = codes.wait(first.id);
    const second = codes.create(ADDRESS, 'cli');
    expect(await outcome).toEqual({ status: 'replaced' });
    expect(codes.match(first.code)).toBeNull();
    expect(codes.match(second.code)?.id).toBe(second.id);
  });

  it('can be cancelled', async () => {
    const codes = new PairCodes(clock);
    const shown = codes.create(ADDRESS, 'cli');
    expect(codes.cancel()).toBe(true);
    expect(await codes.wait(shown.id)).toEqual({ status: 'cancelled' });
    expect(codes.match(shown.code)).toBeNull();
    expect(codes.cancel()).toBe(false);
  });

  it('answers an unknown code id as expired', async () => {
    const codes = new PairCodes(clock);
    expect(codes.status('nope')).toBeNull();
    expect(await codes.wait('nope')).toEqual({ status: 'expired' });
  });

  it('logs when a code is made, used and ended, never the code itself', () => {
    const codes = new PairCodes(clock);
    const first = codes.create(ADDRESS, 'cli');
    const second = codes.create(ADDRESS, 'desktop');
    codes.redeemed(codes.match(second.code)!.id, { name: 'Pixel 9', platform: 'android' }, '100.101.102.103');
    const log = readAudit(10).reverse();
    expect(log.map((e) => e.kind)).toEqual(['pair.code.created', 'pair.code.expired', 'pair.code.created', 'pair.code.redeemed']);
    expect(log[0]).toMatchObject({ by: 'cli', detail: `for ${ADDRESS}` });
    expect(log[1]).toMatchObject({ detail: '(replaced by a new code)' });
    expect(log[3]).toMatchObject({ who: 'Pixel 9', ip: '100.101.102.103', detail: 'on android' });
    expect(JSON.stringify(log)).not.toContain(first.code);
    expect(JSON.stringify(log)).not.toContain(second.code);
  });
});
