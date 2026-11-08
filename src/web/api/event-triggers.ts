import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import {
  EVENT_BODY_LIMIT, EVENT_DELIVERY_PATTERN, EVENT_SIGNATURE_WINDOW_MS,
  EventTriggerError, type EventTriggerBackend, type EventTriggerConfig,
} from '../../core/event-triggers.js';
import { logger } from '../../utils/logger.js';
import type { EventReceipt } from '../../core/work-ledger.js';

function deliveryStatus(receipt: EventReceipt) {
  const { triggerId, deliveryId, status, acceptedAt, updatedAt, expiresAt } = receipt;
  return { triggerId, deliveryId, status, acceptedAt, updatedAt, expiresAt };
}

const BODY_DEADLINE_MS = 5000;
const MAX_READERS = 4;
const REQUESTS_PER_MINUTE = 120;
const DELIVERIES_PER_TRIGGER_MINUTE = 10;

/** Exact bytes and route identity are bound together; a signature cannot cross triggers. */
export function eventSignature(secret: string, method: string, triggerId: string, deliveryId: string, timestamp: string, body: Uint8Array): string {
  return createHmac('sha256', secret)
    .update(`mercury-event-v1\n${method}\n${triggerId}\n${deliveryId}\n${timestamp}\n`)
    .update(body).digest('hex');
}

interface Window { start: number; count: number }
interface IngressOptions {
  config: EventTriggerConfig;
  backend: EventTriggerBackend;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  bodyDeadlineMs?: number;
}

/** Bounded state: one global window, at most 32 configured trigger windows, four body readers. */
export class EventTriggerIngress {
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly submissions = new Map<string, Window>();
  private requests: Window = { start: 0, count: 0 };
  private readers = 0;

  constructor(private readonly options: IngressOptions) {
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
  }

  private take(window: Window, limit: number): boolean {
    const now = this.now();
    if (now - window.start >= 60_000 || now < window.start) { window.start = now; window.count = 0; }
    if (window.count >= limit) return false;
    window.count++;
    return true;
  }

  async handle(c: Context, statusOnly: boolean): Promise<Response> {
    const config = this.options.config;
    const id = c.req.param('id') ?? '';
    const trigger = config.enabled ? config.triggers.find((item) => item.enabled && item.id === id) : undefined;
    if (!trigger) return c.json({ error: 'Not found' }, 404);
    const secret = this.env[trigger.secretEnv];
    if (!secret || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 1024) {
      return c.json({ error: 'Event trigger is unavailable', code: 'secret_unavailable' }, 503);
    }
    const timestamp = c.req.header('x-mercury-timestamp') ?? '';
    const deliveryId = c.req.header('x-mercury-delivery') ?? '';
    const signature = c.req.header('x-mercury-signature') ?? '';
    if (!/^\d{10,13}$/.test(timestamp) || !EVENT_DELIVERY_PATTERN.test(deliveryId)
      || !/^sha256=[a-f0-9]{64}$/.test(signature)
      || Math.abs(this.now() - Number(timestamp) * 1000) > EVENT_SIGNATURE_WINDOW_MS
      || (statusOnly && c.req.param('deliveryId') !== deliveryId)) {
      return c.json({ error: 'Invalid event authentication' }, 401);
    }
    if (!this.take(this.requests, REQUESTS_PER_MINUTE)) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Too many event requests', code: 'rate_limit' }, 429);
    }
    if (this.readers >= MAX_READERS) return c.json({ error: 'Event ingress is busy', code: 'ingress_busy' }, 503);
    this.readers++;
    try {
      const declared = c.req.header('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > EVENT_BODY_LIMIT)) {
        return c.json({ error: 'Event payload exceeds 64 KiB' }, 413);
      }
      if (c.req.header('content-encoding') && c.req.header('content-encoding') !== 'identity') {
        return c.json({ error: 'Compressed event bodies are not supported' }, 415);
      }
      let body: Buffer;
      try { body = await this.readBody(c.req.raw); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        return c.json({ error: code === 'too_large' ? 'Event payload exceeds 64 KiB' : 'Event body could not be read' }, code === 'too_large' ? 413 : 408);
      }
      const expected = eventSignature(secret, c.req.method, trigger.id, deliveryId, timestamp, body);
      if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.slice(7), 'hex'))) {
        return c.json({ error: 'Invalid event authentication' }, 401);
      }
      // Authentication precedes JSON parsing, lookup of delivery state, and queue admission.
      if (statusOnly) {
        const receipt = this.options.backend.status(trigger.id, deliveryId);
        return receipt ? c.json({ delivery: deliveryStatus(receipt), reviewRequired: receipt.status === 'paused' }) : c.json({ error: 'Delivery not found or receipt expired' }, 404);
      }
      const mediaType = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (mediaType !== 'application/json') return c.json({ error: 'Expected application/json' }, 415);
      let payload: string;
      try {
        payload = new TextDecoder('utf-8', { fatal: true }).decode(body);
        JSON.parse(payload);
      } catch { return c.json({ error: 'Invalid UTF-8 JSON body' }, 400); }
      const window = this.submissions.get(id) ?? { start: this.now(), count: 0 };
      this.submissions.set(id, window);
      if (!this.take(window, DELIVERIES_PER_TRIGGER_MINUTE)) {
        c.header('Retry-After', '60');
        return c.json({ error: 'Too many deliveries for this trigger', code: 'rate_limit' }, 429);
      }
      const result = this.options.backend.accept({ trigger, deliveryId, payload, payloadHash: createHash('sha256').update(body).digest('hex') });
      return c.json({ accepted: result.accepted, delivery: deliveryStatus(result.receipt), reviewRequired: result.receipt.status === 'paused' }, result.accepted ? 202 : 200);
    } catch (error) {
      if (error instanceof EventTriggerError) {
        if (error.status === 429) c.header('Retry-After', '60');
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      logger.error({ triggerId: id, error: error instanceof Error ? error.message : String(error) }, 'Event delivery admission failed');
      return c.json({ error: 'Event delivery could not be durably accepted', code: 'acceptance_failed' }, 503);
    } finally {
      this.readers--;
    }
  }

  private async readBody(request: Request): Promise<Buffer> {
    if (!request.body) return Buffer.alloc(0);
    const reader = request.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks, size);
        size += value.byteLength;
        if (size > EVENT_BODY_LIMIT) throw new Error('too_large');
        chunks.push(value);
      }
    };
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('body_timeout')), this.options.bodyDeadlineMs ?? BODY_DEADLINE_MS); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export function createEventTriggerRoutes(getIngress: () => EventTriggerIngress | null): Hono {
  const routes = new Hono();
  routes.post('/api/event-triggers/:id', (c) => getIngress()?.handle(c, false) ?? c.json({ error: 'Not found' }, 404));
  routes.get('/api/event-triggers/:id/deliveries/:deliveryId', (c) => getIngress()?.handle(c, true) ?? c.json({ error: 'Not found' }, 404));
  return routes;
}

let ingress: EventTriggerIngress | null = null;
export function configureEventTriggers(config: EventTriggerConfig, backend: EventTriggerBackend): void {
  ingress = config.enabled ? new EventTriggerIngress({ config, backend }) : null;
}
export default createEventTriggerRoutes(() => ingress);
