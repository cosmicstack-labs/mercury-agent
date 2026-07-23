import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelMessage } from '../types/channel.js';
import { getWorkKey, WorkLedger } from './work-ledger.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { maxTerminalEntries?: number; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-work-ledger-'));
  dirs.push(dir);
  const filePath = join(dir, 'work-ledger.json');
  return { dir, filePath, ledger: new WorkLedger({ filePath, ...options }) };
}

function message(id: string, metadata?: Record<string, unknown>): ChannelMessage {
  return {
    id,
    channelId: 'chat-1',
    channelType: 'signal',
    senderId: 'user-1',
    content: `work ${id}`,
    timestamp: 100,
    metadata,
  };
}

describe('WorkLedger', () => {
  it('uses stable identifier precedence and rejects duplicate acceptance', () => {
    const { ledger } = setup();
    const msg = message('transport-id', { requestId: 'request-id', canonicalMessageId: 'canonical-id' });

    expect(getWorkKey(msg)).toBe('request:request-id');
    expect(ledger.accept(msg).accepted).toBe(true);
    expect(ledger.accept({ ...msg, content: 'duplicate payload' }).accepted).toBe(false);
    expect(ledger.get('request:request-id')?.message.content).toBe('work transport-id');
  });

  it('atomically persists owner-only state and recovers interrupted jobs', () => {
    const { filePath, ledger } = setup();
    const queued = ledger.accept(message('queued')).entry;
    const running = ledger.accept(message('running')).entry;
    ledger.markRunning(running.key);

    const recovered = new WorkLedger({ filePath }).recoverInterrupted();

    expect(recovered.map((entry) => entry.key)).toEqual([queued.key, running.key]);
    expect(recovered[0].message.metadata?.workRecovered).toBe(true);
    expect(recovered[0].message.metadata?.workWasInterrupted).toBe(false);
    expect(recovered[1].message.metadata?.workWasInterrupted).toBe(true);
    expect(recovered[1].attempts).toBe(1);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1);
  });

  it('keeps completed responses in the outbox until delivery succeeds', () => {
    const { filePath, ledger } = setup();
    const entry = ledger.accept(message('outbox')).entry;
    ledger.markRunning(entry.key);
    ledger.markCompleted(entry.key, 'durable result');
    ledger.markDeliveryError(entry.key, new Error('offline'));

    const restarted = new WorkLedger({ filePath });
    expect(restarted.getUndeliveredResponses()).toMatchObject([
      { key: entry.key, finalResponse: 'durable result', delivered: false, deliveryError: 'offline' },
    ]);

    restarted.markDelivered(entry.key);
    expect(new WorkLedger({ filePath }).getUndeliveredResponses()).toEqual([]);
  });

  it('keeps explicit failure responses retryable until delivered', () => {
    const { ledger } = setup();
    const entry = ledger.accept(message('failed-outbox')).entry;
    ledger.markRunning(entry.key);
    ledger.markFailed(entry.key, 'provider unavailable', 'Mercury could not finish after retrying providers.');

    expect(ledger.getUndeliveredResponses()).toMatchObject([
      { key: entry.key, status: 'failed', finalResponse: 'Mercury could not finish after retrying providers.', delivered: false },
    ]);
  });

  it('persists delayed retries as queued work', () => {
    const { filePath, ledger } = setup();
    const entry = ledger.accept(message('retry')).entry;
    ledger.markRunning(entry.key);
    ledger.markRetry(entry.key, 'network unavailable', 50_000);

    const restored = new WorkLedger({ filePath }).get(entry.key);
    expect(restored).toMatchObject({ status: 'queued', attempts: 1, error: 'network unavailable', nextAttemptAt: 50_000 });
  });

  it('checkpoints continuation context instead of discarding completed tool progress', () => {
    const { filePath, ledger } = setup();
    const entry = ledger.accept(message('continuation')).entry;
    ledger.markRunning(entry.key);
    ledger.markRetry(entry.key, 'Generation was interrupted after one or more tools completed', 10_000, {
      continuation: true,
      workCwd: '/tmp/project',
      activity: 'Writing composition',
      summary: 'Screenshot and voiceover completed',
    });

    const restored = new WorkLedger({ filePath }).get(entry.key);
    expect(restored).toMatchObject({
      status: 'queued',
      message: { metadata: {
        workContinuation: true,
        continuationAttempt: 1,
        workCwd: '/tmp/project',
        continuationActivity: 'Writing composition',
        continuationSummary: 'Screenshot and voiceover completed',
      } },
    });
    expect(restored).not.toHaveProperty('finalResponse');
  });

  it('automatically revives legacy ambiguous failures after an upgrade', () => {
    const { filePath, ledger } = setup();
    const entry = ledger.accept(message('legacy-interruption')).entry;
    ledger.markRunning(entry.key);
    ledger.markFailed(entry.key, 'Work stopped in an interrupted/ambiguous state; side effects may be partial');
    ledger.markDelivered(entry.key);

    const recovered = new WorkLedger({ filePath }).recoverInterrupted();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'queued',
      delivered: false,
      finalResponse: undefined,
      message: { metadata: { workContinuation: true, continuationAttempt: 1 } },
    });
  });

  it('quarantines invalid state and starts a valid empty ledger', () => {
    const { dir, filePath } = setup();
    writeFileSync(filePath, '{not-json', { mode: 0o600 });

    const ledger = new WorkLedger({ filePath, now: () => 1234 });

    expect(ledger.getUndeliveredResponses()).toEqual([]);
    expect(readdirSync(dir)).toContain('work-ledger.json.corrupt-1234');
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ version: 1, entries: [] });
  });

  it('bounds terminal history without pruning active work', () => {
    let now = 1_000;
    const { ledger } = setup({ maxTerminalEntries: 1, now: () => now++ });
    const active = ledger.accept(message('active')).entry;
    const first = ledger.accept(message('first')).entry;
    ledger.markFailed(first.key, 'first failed');
    const second = ledger.accept(message('second')).entry;
    ledger.markCompleted(second.key, 'second complete');
    ledger.markDelivered(second.key);

    expect(ledger.get(active.key)?.status).toBe('queued');
    expect(ledger.get(second.key)?.status).toBe('completed');
    expect(ledger.get(first.key)).toBeUndefined();
  });
});
