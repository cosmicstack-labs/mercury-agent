import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failure = vi.hoisted(() => ({ write: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, writeSync: (...args: Parameters<typeof fs.writeSync>) => {
    if (failure.write) throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
    return Reflect.apply(fs.writeSync, fs, args);
  } };
});

const { WorkLedger } = await import('./work-ledger.js');
const { eventMessage } = await import('./event-triggers.js');
const roots: string[] = [];
afterEach(() => { failure.write = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mercury-event-audit-'));
  roots.push(root);
  return { root, filePath: join(root, 'work-ledger.json') };
}
function message(id: string) {
  return eventMessage({ trigger: { id: 'ci', enabled: true, secretEnv: 'TEST_EVENT_SECRET', task: 'summarize', allowTools: false, networkTools: [], destination: { channelType: 'web', sessionId: '00000000-0000-4000-8000-000000000001' } }, deliveryId: id, payload: '{}', payloadHash: '0'.repeat(64) });
}

describe('event ledger persistence failures', () => {
  it('keeps ingress fenced on next restart when writing corruption fence fails', () => {
    const { root, filePath } = fixture();
    writeFileSync(filePath, '{bad json');
    failure.write = true;
    expect(() => new WorkLedger({ filePath })).toThrow('No space');
    expect(readdirSync(root).some((name) => name.includes('.corrupt-'))).toBe(true);
    failure.write = false;
    expect(() => new WorkLedger({ filePath }).acceptEvent(message('old-delivery'))).toThrow('damaged work ledger');
  });

  it('retains unrelated terminal memory state when persisting new work fails after pruning', () => {
    const { filePath } = fixture();
    let now = 0;
    const ledger = new WorkLedger({ filePath, terminalMaxAgeMs: 10, now: () => now });
    ledger.acceptEvent(message('one'));
    ledger.markCompleted('event:ci:one', 'done');
    ledger.markDelivered('event:ci:one');
    const before = readFileSync(filePath, 'utf8');
    now = 100;
    failure.write = true;
    expect(() => ledger.acceptEvent(message('two'))).toThrow('No space');
    failure.write = false;
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(ledger.get('event:ci:one')).toMatchObject({ status: 'completed', delivered: true });
  });

  it('keeps the last durable state when recording crash recovery fails', () => {
    const { filePath } = fixture();
    const ledger = new WorkLedger({ filePath });
    ledger.acceptEvent(message('one'));
    ledger.markRunning('event:ci:one');
    const restarted = new WorkLedger({ filePath });
    failure.write = true;
    expect(() => restarted.recoverInterrupted()).toThrow('No space');
    expect(restarted.getEventReceipt('ci', 'one')?.status).toBe('running');
    expect(restarted.get('event:ci:one')?.status).toBe('running');
    failure.write = false;
    expect(restarted.recoverInterrupted()).toEqual([]);
    expect(restarted.getEventReceipt('ci', 'one')?.status).toBe('paused');
    expect(new WorkLedger({ filePath }).getEventReceipt('ci', 'one')?.status).toBe('paused');
  });
});
