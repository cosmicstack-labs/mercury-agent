import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { WorkLedger } from '../../core/work-ledger.js';
import { eventMessage, type EventTriggerConfig, type EventTriggerInput } from '../../core/event-triggers.js';
import { createEventTriggerRoutes, EventTriggerIngress, eventSignature } from './event-triggers.js';

const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'mercury-event-http-'));
  process.env.MERCURY_HOME = root;
  return root;
});
const { authGuard } = await import('../middleware.js');
const { writeRemoteSettings } = await import('../../security/remote-settings.js');

const secret = 'test-only-random-event-secret-32-bytes-minimum';
const destination = { channelType: 'web' as const, sessionId: 'b5d75621-a282-486f-a3e6-f09e06de8002' };
const config: EventTriggerConfig = { enabled: true, triggers: [
  { id: 'ci', enabled: true, secretEnv: 'TEST_EVENT_KEY', task: 'Summarize this event.', allowTools: false, destination },
  { id: 'other', enabled: true, secretEnv: 'TEST_EVENT_KEY', task: 'A separate task.', allowTools: false, destination },
] };
const servers: Server[] = [];
const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
beforeEach(() => writeRemoteSettings({ enabled: false }));
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

function headers(body: Uint8Array, deliveryId = 'build_1', triggerId = 'ci', method = 'POST', timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'content-type': 'application/json', 'x-mercury-timestamp': timestamp, 'x-mercury-delivery': deliveryId,
    'x-mercury-signature': `sha256=${eventSignature(secret, method, triggerId, deliveryId, timestamp, body)}`,
  };
}
function setup(options: { ledger?: WorkLedger; config?: EventTriggerConfig; env?: NodeJS.ProcessEnv; bodyDeadlineMs?: number } = {}) {
  const filePath = join(mkdtempSync(join(home, 'ledger-')), 'work-ledger.json');
  const ledger = options.ledger ?? new WorkLedger({ filePath });
  const enqueued: string[] = [];
  const accept = vi.fn((input: EventTriggerInput) => {
    const accepted = ledger.acceptEvent(eventMessage(input));
    if (accepted.accepted) enqueued.push(accepted.receipt.key);
    return accepted;
  });
  const ingress = new EventTriggerIngress({
    config: options.config ?? config, env: options.env ?? { TEST_EVENT_KEY: secret }, bodyDeadlineMs: options.bodyDeadlineMs,
    backend: { accept, status: (id, delivery) => ledger.getEventReceipt(id, delivery) },
  });
  const app = new Hono();
  app.use('*', authGuard);
  app.route('/', createEventTriggerRoutes(() => ingress));
  return { app, ledger, filePath, enqueued, accept };
}
async function listen(app: Hono): Promise<string> {
  const server = createAdaptorServer({ fetch: app.fetch });
  servers.push(server as Server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address');
  return `http://127.0.0.1:${address.port}`;
}
async function post(base: string, body = Buffer.from('{"build":"ok"}'), extra: Record<string, string> = {}, id = 'build_1', trigger = 'ci') {
  return fetch(`${base}/api/event-triggers/${trigger}`, { method: 'POST', headers: { ...headers(body, id, trigger), ...extra }, body });
}

describe('signed event HTTP ingress', () => {
  it('acknowledges durable acceptance once under concurrent redelivery and exposes actual outcome separately', async () => {
    const { app, ledger, filePath, enqueued } = setup();
    const base = await listen(app);
    const responses = await Promise.all(Array.from({ length: 4 }, () => post(base)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 202]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ accepted: boolean; delivery: { status: string } }>));
    expect(bodies.filter((body) => body.accepted)).toHaveLength(1);
    expect(bodies[0].delivery.status).toBe('queued');
    expect(enqueued).toEqual(['event:ci:build_1']);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).entries).toHaveLength(1);
    ledger.markRunning(enqueued[0]);
    ledger.markCompleted(enqueued[0], 'private response belongs in the conversation');
    const status = await fetch(`${base}/api/event-triggers/ci/deliveries/build_1`, { headers: headers(Buffer.alloc(0), 'build_1', 'ci', 'GET') });
    expect(status.status).toBe(200);
    const result = await status.json() as { delivery: { status: string } };
    expect(result.delivery.status).toBe('completed');
    expect(result.delivery).not.toHaveProperty('payloadHash');
    expect(JSON.stringify(result)).not.toContain('private response');
  });

  it('rejects tampered bytes, identities, stale timestamps, and signatures before JSON parsing or dispatch', async () => {
    const { app, accept } = setup();
    const base = await listen(app);
    const body = Buffer.from('{"build":"ok"}');
    const valid = headers(body);
    expect((await post(base, Buffer.from('{"build": "ok"}'), valid)).status).toBe(401);
    expect((await post(base, body, { ...valid, 'x-mercury-delivery': 'different' })).status).toBe(401);
    expect((await post(base, body, valid, 'build_1', 'other')).status).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - 301);
    expect((await post(base, body, headers(body, 'build_1', 'ci', 'POST', stale))).status).toBe(401);
    expect((await post(base, Buffer.from('not json'), { 'x-mercury-signature': `sha256=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await post(base, Buffer.from('not json'))).status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it('does not substitute browser credentials for a trigger signature, and stays opt-in', async () => {
    const live = setup();
    const base = await listen(live.app);
    expect((await fetch(`${base}/api/event-triggers/ci`, { method: 'POST', headers: { Authorization: 'Bearer anything', Cookie: 'session=anything' }, body: '{}' })).status).toBe(401);
    expect((await post(await listen(setup({ config: { enabled: false, triggers: config.triggers } }).app))).status).toBe(404);
    expect((await post(await listen(setup({ env: {} }).app))).status).toBe(503);
    expect(live.accept).not.toHaveBeenCalled();
  });

  it('preserves existing remote-access and host protections before signed routes', async () => {
    const { app, accept } = setup();
    const base = await listen(app);
    expect((await post(base, undefined, { 'x-forwarded-for': '203.0.113.10' })).status).toBe(403);
    const body = Buffer.from('{}');
    const rebound = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/api/event-triggers/ci`, { method: 'POST', headers: { ...headers(body), host: 'evil.example' } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject);
      request.end(body);
    });
    expect(rebound).toBe(421);
    expect(accept).not.toHaveBeenCalled();
  });

  it('bounds streamed bodies even without Content-Length and rejects unsupported encodings', async () => {
    const { app, accept } = setup();
    const base = await listen(app);
    const body = Buffer.from(`"${'x'.repeat(64 * 1024)}"`);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/api/event-triggers/ci`, { method: 'POST', headers: headers(body) }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject);
      request.write(body.subarray(0, 32 * 1024));
      request.end(body.subarray(32 * 1024));
    });
    expect(status).toBe(413);
    expect((await post(base, Buffer.from('{}'), { 'content-encoding': 'gzip' })).status).toBe(415);
    expect((await post(base, Buffer.from([0xff, 0xfe]))).status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it('bounds slow readers and frees their slots after the read deadline', async () => {
    const { app } = setup({ bodyDeadlineMs: 40 });
    let cancelled = 0;
    const stalled = () => {
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
      const request = new Request('http://127.0.0.1/api/event-triggers/ci', { method: 'POST', headers: headers(Buffer.alloc(0)), body, duplex: 'half' } as RequestInit & { duplex: 'half' });
      return app.fetch(request, LOCAL);
    };
    const readers = Array.from({ length: 4 }, stalled);
    expect((await stalled()).status).toBe(503);
    expect((await Promise.all(readers)).map((response) => response.status)).toEqual([408, 408, 408, 408]);
    expect(cancelled).toBe(4);
    const body = Buffer.from('{}');
    expect((await app.request('http://127.0.0.1/api/event-triggers/ci', { method: 'POST', headers: headers(body), body }, LOCAL)).status).toBe(202);
  });

  it('bounds signed delivery bursts without admitting the rejected event', async () => {
    const { app, enqueued } = setup();
    const base = await listen(app);
    for (let id = 0; id < 10; id++) expect((await post(base, Buffer.from('{}'), {}, `build_${id}`)).status).toBe(202);
    const response = await post(base, Buffer.from('{}'), {}, 'build_11');
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(enqueued).toHaveLength(10);
  });

  it('does not acknowledge failed persistence and can accept a later safe retry', async () => {
    const { app, filePath, ledger, enqueued } = setup();
    mkdirSync(filePath);
    const base = await listen(app);
    expect((await post(base)).status).toBe(503);
    expect(enqueued).toEqual([]);
    expect(ledger.getEventReceipt('ci', 'build_1')).toBeUndefined();
    rmSync(filePath, { recursive: true });
    expect((await post(base)).status).toBe(202);
    expect(enqueued).toHaveLength(1);
  });

  it('survives restart and refuses replay of uncertain or cancelled deliveries', async () => {
    const first = setup();
    const base = await listen(first.app);
    expect((await post(base)).status).toBe(202);
    first.ledger.markRunning('event:ci:build_1');
    expect((await post(base, Buffer.from('{}'), {}, 'cancelled')).status).toBe(202);
    first.ledger.markCancelled('event:ci:cancelled');
    const ledger = new WorkLedger({ filePath: first.filePath });
    expect(ledger.recoverInterrupted()).toEqual([]);
    const restarted = setup({ ledger });
    const second = await listen(restarted.app);
    const response = await post(second);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: false, reviewRequired: true, delivery: { status: 'paused' } });
    const cancelled = await post(second, Buffer.from('{}'), {}, 'cancelled');
    expect(await cancelled.json()).toMatchObject({ accepted: false, delivery: { status: 'cancelled' } });
    expect(restarted.enqueued).toEqual([]);
  });
});
