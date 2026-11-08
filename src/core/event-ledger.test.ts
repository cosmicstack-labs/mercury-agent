import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkLedger } from './work-ledger.js';
import { EVENT_RECEIPT_TTL_MS, eventMessage, type EventTrigger } from './event-triggers.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const trigger: EventTrigger = {
  id: 'ci', enabled: true, secretEnv: 'MERCURY_CI_KEY', task: 'Summarize the result.', allowTools: false,
  destination: { channelType: 'web', sessionId: 'b5d75621-a282-486f-a3e6-f09e06de8002' },
};
function message(id: string, payload = '{}') {
  return eventMessage({ trigger, deliveryId: id, payload, payloadHash: createHash('sha256').update(payload).digest('hex') });
}
function file() {
  const root = mkdtempSync(join(tmpdir(), 'mercury-event-ledger-'));
  roots.push(root);
  return join(root, 'work-ledger.json');
}

describe('durable event receipts', () => {
  it('persists receipt and queued work together before acceptance, then dedupes after restart', () => {
    const filePath = file();
    const ledger = new WorkLedger({ filePath });
    const accepted = ledger.acceptEvent(message('one'));
    expect(accepted.accepted).toBe(true);
    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(saved.entries[0].key).toBe(accepted.receipt.key);
    expect(saved.eventReceipts[0].key).toBe(accepted.receipt.key);
    const restarted = new WorkLedger({ filePath });
    expect(restarted.acceptEvent(message('one'))).toMatchObject({ accepted: false, receipt: { status: 'queued' } });
    expect(restarted.recoverInterrupted().map((entry) => entry.key)).toEqual([accepted.receipt.key]);
  });
  it('rejects a changed payload for an existing delivery identity', () => {
    const ledger = new WorkLedger({ filePath: file() });
    ledger.acceptEvent(message('same', '{"x":1}'));
    expect(() => ledger.acceptEvent(message('same', '{"x":2}'))).toThrow('different payload');
  });
  it('retains dedupe receipts when normal terminal history is pruned', () => {
    const filePath = file();
    const ledger = new WorkLedger({ filePath, maxTerminalEntries: 0 });
    const { receipt } = ledger.acceptEvent(message('one'));
    ledger.markRunning(receipt.key);
    ledger.markCompleted(receipt.key, 'done');
    ledger.markDelivered(receipt.key);
    expect(ledger.get(receipt.key)).toBeUndefined();
    expect(new WorkLedger({ filePath }).acceptEvent(message('one'))).toMatchObject({ accepted: false, receipt: { status: 'completed' } });
  });
  it('pauses a crashed execution and never replays it, including repeated restarts', () => {
    const filePath = file();
    const ledger = new WorkLedger({ filePath });
    const { receipt } = ledger.acceptEvent(message('uncertain'));
    ledger.markRunning(receipt.key);
    const restarted = new WorkLedger({ filePath });
    expect(restarted.recoverInterrupted()).toEqual([]);
    expect(restarted.get(receipt.key)).toMatchObject({ status: 'paused', finalResponse: expect.stringContaining('Side effects may have happened') });
    expect(restarted.getEventReceipt('ci', 'uncertain')?.status).toBe('paused');
    expect(new WorkLedger({ filePath }).recoverInterrupted()).toEqual([]);
    expect(new WorkLedger({ filePath }).acceptEvent(message('uncertain')).accepted).toBe(false);
  });
  it.each(['paused', 'failed', 'cancelled'] as const)('never restarts %s deliveries', (status) => {
    const filePath = file();
    const ledger = new WorkLedger({ filePath });
    const { receipt } = ledger.acceptEvent(message('one'));
    if (status === 'paused') ledger.markPaused(receipt.key, 'inspect');
    if (status === 'failed') ledger.markFailed(receipt.key, 'interrupted/ambiguous');
    if (status === 'cancelled') ledger.markCancelled(receipt.key);
    const restarted = new WorkLedger({ filePath });
    expect(restarted.recoverInterrupted()).toEqual([]);
    expect(restarted.acceptEvent(message('one')).accepted).toBe(false);
    expect(restarted.getEventReceipt('ci', 'one')?.status).toBe(status === 'failed' ? 'paused' : status);
  });
  it('refuses ordinary retry machinery for event work', () => {
    const ledger = new WorkLedger({ filePath: file() });
    const { receipt } = ledger.acceptEvent(message('one'));
    ledger.markRunning(receipt.key);
    expect(() => ledger.markRetry(receipt.key, 'interrupted', Date.now())).toThrow('never automatically retried');
    expect(ledger.getEventReceipt('ci', 'one')?.status).toBe('running');
  });
  it('bounds pending work and receipts without evicting replay evidence', () => {
    const ledger = new WorkLedger({ filePath: file(), maxPendingEvents: 1, maxEventReceipts: 2 });
    const first = ledger.acceptEvent(message('one'));
    expect(() => ledger.acceptEvent(message('two'))).toThrow('queue is full');
    ledger.markPaused(first.receipt.key, 'review required');
    expect(() => ledger.acceptEvent(message('two'))).toThrow('queue is full');
    ledger.markCompleted(first.receipt.key, 'done');
    expect(() => ledger.acceptEvent(message('two'))).toThrow('queue is full');
    ledger.markDelivered(first.receipt.key);
    const second = ledger.acceptEvent(message('two'));
    ledger.markCompleted(second.receipt.key, 'done');
    expect(() => ledger.acceptEvent(message('three'))).toThrow('Receipt capacity');
    expect(ledger.acceptEvent(message('one')).accepted).toBe(false);
  });
  it('expires terminal receipts after the retention period but retains unresolved pauses', () => {
    let now = 10_000;
    const ledger = new WorkLedger({ filePath: file(), maxTerminalEntries: 0, maxEventReceipts: 2, now: () => now });
    const completed = ledger.acceptEvent(message('done')).receipt;
    ledger.markCompleted(completed.key, 'done');
    ledger.markDelivered(completed.key);
    const paused = ledger.acceptEvent(message('paused')).receipt;
    ledger.markPaused(paused.key, 'inspect effects');
    now += EVENT_RECEIPT_TTL_MS + 1;
    expect(ledger.acceptEvent(message('new')).accepted).toBe(true);
    expect(ledger.getEventReceipt('ci', 'done')).toBeUndefined();
    expect(ledger.acceptEvent(message('paused')).accepted).toBe(false);
  });
  it('does not leave a phantom receipt or in-memory acceptance after a disk write fails', () => {
    const filePath = file();
    const ledger = new WorkLedger({ filePath });
    mkdirSync(filePath); // An atomic rename cannot overwrite a directory on Linux or Windows.
    expect(() => ledger.acceptEvent(message('one'))).toThrow();
    expect(ledger.getEventReceipt('ci', 'one')).toBeUndefined();
    expect(ledger.get('event:ci:one')).toBeUndefined();
    rmSync(filePath, { recursive: true });
    expect(ledger.acceptEvent(message('one')).accepted).toBe(true);
  });
  it.each(['receipt', 'work', 'status'])('blocks admission when %s recovery evidence is inconsistent', (missing) => {
    const filePath = file();
    new WorkLedger({ filePath }).acceptEvent(message('one'));
    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    if (missing === 'receipt') saved.eventReceipts = [];
    if (missing === 'work') saved.entries = [];
    if (missing === 'status') saved.eventReceipts[0].status = 'completed';
    writeFileSync(filePath, JSON.stringify(saved));
    expect(() => new WorkLedger({ filePath }).acceptEvent(message('one'))).toThrow('damaged work ledger');
  });
  it('does not report a terminal outcome when its atomic write failed', () => {
    const filePath = file();
    const ledger = new WorkLedger({ filePath });
    ledger.acceptEvent(message('one'));
    renameSync(filePath, `${filePath}.saved`);
    mkdirSync(filePath);
    expect(() => ledger.markCancelled('event:ci:one')).toThrow();
    expect(ledger.getEventReceipt('ci', 'one')?.status).toBe('queued');
    expect(ledger.get('event:ci:one')?.status).toBe('queued');
    rmSync(filePath, { recursive: true });
    renameSync(`${filePath}.saved`, filePath);
    expect(new WorkLedger({ filePath }).getEventReceipt('ci', 'one')?.status).toBe('queued');
    ledger.markCancelled('event:ci:one');
    expect(new WorkLedger({ filePath }).getEventReceipt('ci', 'one')?.status).toBe('cancelled');
  });
  it('persists a fail-closed fence when dedupe evidence is corrupt', () => {
    const filePath = file();
    writeFileSync(filePath, '{bad json');
    const ledger = new WorkLedger({ filePath });
    expect(() => ledger.acceptEvent(message('one'))).toThrow('damaged work ledger');
    expect(() => new WorkLedger({ filePath }).acceptEvent(message('one'))).toThrow('damaged work ledger');
    expect(JSON.parse(readFileSync(filePath, 'utf8')).eventIngressBlocked).toBe(true);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('fences a missing recent %s receipt before history pruning can lose replay evidence', (status) => {
    const filePath = file();
    const ledger = new WorkLedger({ filePath });
    const { receipt } = ledger.acceptEvent(message('one'));
    if (status === 'completed') { ledger.markCompleted(receipt.key, 'done'); ledger.markDelivered(receipt.key); }
    if (status === 'failed') ledger.markFailed(receipt.key, 'failed');
    if (status === 'cancelled') ledger.markCancelled(receipt.key);
    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    saved.eventReceipts = [];
    writeFileSync(filePath, JSON.stringify(saved));
    const restarted = new WorkLedger({ filePath, maxTerminalEntries: 0 });
    const normal = { ...message('normal'), id: 'normal', metadata: {} };
    restarted.accept(normal);
    expect(() => restarted.acceptEvent(message('one'))).toThrow('damaged work ledger');
  });

  it('allows legitimately expired terminal receipts alongside retained ordinary history', () => {
    let now = 10_000;
    const filePath = file();
    const ledger = new WorkLedger({ filePath, now: () => now });
    const { receipt } = ledger.acceptEvent(message('one'));
    ledger.markCompleted(receipt.key, 'done');
    ledger.markDelivered(receipt.key);
    now += EVENT_RECEIPT_TTL_MS + 1;
    ledger.accept({ ...message('normal'), id: 'normal', metadata: {} });
    expect(ledger.getEventReceipt('ci', 'one')).toBeUndefined();
    const restarted = new WorkLedger({ filePath, now: () => now });
    expect(restarted.acceptEvent(message('one')).accepted).toBe(false);
    expect(restarted.acceptEvent(message('new')).accepted).toBe(true);
  });
});
