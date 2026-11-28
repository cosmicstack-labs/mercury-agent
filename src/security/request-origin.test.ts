import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { requestOrigin } from './request-origin.js';
import { authGuard, lastPlainHttpRequest, lastRemoteRequest } from '../web/middleware.js';

const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const HOST = 'mercury.tail1234.ts.net';

let home: string;
const previous = process.env.MERCURY_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mercury-origin-')); process.env.MERCURY_HOME = home; });
afterEach(() => { if (previous === undefined) delete process.env.MERCURY_HOME; else process.env.MERCURY_HOME = previous; rmSync(home, { recursive: true, force: true }); });

async function originFor(headers: Record<string, string>) {
  const a = new Hono();
  a.get('/o', (c) => c.json(requestOrigin(c)));
  return (await (await a.request('http://127.0.0.1:6174/o', { headers }, LOCAL)).json()) as { scheme: string | null; via: string };
}

describe('how a request arrived', () => {
  it.each([
    ['this computer', {}, 'http', 'local'],
    ['Tailscale Serve over HTTPS', { 'X-Forwarded-For': '100.101.102.103', 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': 'me@example.com', Host: HOST }, 'https', 'tailscale'],
    ['Tailscale Serve over plain http, which sends no proto header', { 'X-Forwarded-For': '100.101.102.103', 'Tailscale-User-Login': 'me@example.com', Host: HOST }, 'http', 'tailscale'],
    ['Tailscale Funnel', { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https', 'Tailscale-Funnel-Request': '?1', Host: HOST }, 'https', 'funnel'],
    ['Cloudflare Tunnel', { 'CF-Connecting-IP': '203.0.113.9', 'CF-Visitor': '{"scheme":"https"}', Host: 'mercury.example.com' }, 'https', 'cloudflare'],
    ['a proxy that says plain http in Forwarded', { Forwarded: 'for=203.0.113.7;proto=http', Host: 'mercury.example.com' }, 'http', 'proxy'],
    ['a proxy that lists protocols', { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https, http' }, 'https', 'proxy'],
    ['a proxy that says nothing about the protocol', { 'X-Forwarded-For': '203.0.113.7' }, null, 'proxy'],
  ])('%s', async (_name, headers, scheme, via) => {
    expect(await originFor(headers as Record<string, string>)).toMatchObject({ scheme, via });
  });
});

describe('the last plain-http request from outside', () => {
  it('is remembered only for a public address', async () => {
    const a = new Hono();
    a.use('*', authGuard);
    a.get('/api/x', (c) => c.json({}));
    const hit = (headers: Record<string, string>) => a.request('http://127.0.0.1:6174/api/x', { headers }, LOCAL);
    await hit({ 'X-Forwarded-For': '100.101.102.103', 'Tailscale-User-Login': 'me@example.com', Host: HOST });
    expect(lastPlainHttpRequest()).toBeNull();
    expect(lastRemoteRequest()).toMatchObject({ ip: '100.101.102.103', scheme: 'http', via: 'tailscale' });
    await hit({ 'X-Forwarded-For': '203.0.113.50', 'X-Forwarded-Proto': 'http' });
    expect(lastPlainHttpRequest()).toMatchObject({ ip: '203.0.113.50' });
    await hit({ 'X-Forwarded-For': '203.0.113.51', 'X-Forwarded-Proto': 'https' });
    expect(lastPlainHttpRequest()).toMatchObject({ ip: '203.0.113.50' });
    expect(lastRemoteRequest()).toMatchObject({ ip: '203.0.113.51', scheme: 'https', via: 'proxy' });
  });
});
