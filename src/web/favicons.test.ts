import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FaviconCache, iconDomain, imageMime } from './favicons.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'fav-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('site icons', () => {
  it('only public domain names are asked for', () => {
    expect(iconDomain('WWW.BBC.co.uk.')).toBe('www.bbc.co.uk');
    for (const bad of ['localhost', '127.0.0.1', '10.0.0.1', 'a.b/../etc', 'evil.com/x', 'x', '', '::1', 'http://a.com']) expect(iconDomain(bad)).toBeNull();
  });

  it('keeps only real images', () => {
    expect(imageMime(PNG)).toBe('image/png');
    expect(imageMime(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe('image/x-icon');
    expect(imageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(imageMime(Buffer.from('<!doctype html><html>'))).toBeNull();
  });

  it("tries the site, then the icon service, and caches the answer either way", async () => {
    const asked: string[] = [];
    const cache = new FaviconCache(dir(), async (url) => { asked.push(url); return url.includes('duckduckgo') ? PNG : null; });
    expect(await cache.get('example.org')).toMatchObject({ mime: 'image/png' });
    expect(asked).toEqual(['https://example.org/favicon.ico', 'https://icons.duckduckgo.com/ip3/example.org.ico']);
    await cache.get('example.org');
    expect(asked).toHaveLength(2);
  });

  it('remembers "no icon" for a while, then asks again', async () => {
    const d = dir();
    let calls = 0;
    const cache = new FaviconCache(d, async () => { calls++; return null; });
    expect(await cache.get('none.example')).toBeNull();
    expect(await cache.get('none.example')).toBeNull();
    expect(calls).toBe(2); // site + service, once
    const old = (Date.now() - 8 * 24 * 3600_000) / 1000;
    utimesSync(join(d, 'none.example.none'), old, old);
    await cache.get('none.example');
    expect(calls).toBe(4);
  });

  it('one fetch for many screens asking at once; bad domains never fetch', async () => {
    let calls = 0;
    const cache = new FaviconCache(dir(), async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return PNG; });
    await Promise.all([cache.get('a.example'), cache.get('a.example'), cache.get('a.example')]);
    expect(calls).toBe(1);
    expect(await cache.get('127.0.0.1')).toBeNull();
    expect(calls).toBe(1);
  });

  it('a cached file that is not an image is fetched again', async () => {
    const d = dir();
    writeFileSync(join(d, 'x.example.icon'), '<html>');
    const cache = new FaviconCache(d, async () => PNG);
    expect(await cache.get('x.example')).toMatchObject({ mime: 'image/png' });
  });
});
