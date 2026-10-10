import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from './store.js';
import { BotQueue } from './queue.js';
import { BotJournal } from './journal.js';
import { runBotDoctor, formatDoctorReport } from './doctor.js';

describe('runBotDoctor', () => {
  let root: string;
  let store: BotStore;
  let queue: BotQueue;
  let journal: BotJournal;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-bot-doctor-'));
    store = new BotStore(join(root, 'bots'));
    mkdirSync(join(root, 'bots', 'researcher'), { recursive: true });
    queue = new BotQueue(join(root, 'bots'), 100);
    journal = new BotJournal(join(root, 'bots', 'researcher'));
  });

  afterEach(() => {
    // The queue owns the SQLite handle — close it or Windows locks queue.db
    // (EBUSY) and the tmpdir teardown fails.
    queue.close();
    rmSync(root, { recursive: true, force: true });
  });

  const record = (state: 'completed' | 'failed', reasonCode?: string) => ({
    runId: 'r1',
    botId: 'researcher',
    trigger: 'cron' as const,
    state,
    startedAt: Date.now(),
    durationMs: 100,
    tokensIn: 1,
    tokensOut: 1,
    reasonCode,
  });

  it('is healthy with no bots and no findings', () => {
    const report = runBotDoctor({ store, queue, journalFor: () => journal });
    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('flags a bot whose last run failed, with the reason code', () => {
    store.create({ id: 'researcher', name: 'Research' });
    journal.append(record('failed', 'provider_auth'));
    const report = runBotDoctor({ store, queue, journalFor: () => journal });
    expect(report.healthy).toBe(false);
    expect(report.findings.some(f => f.check === 'last-run' && f.detail.includes('provider_auth'))).toBe(true);
  });

  it('flags DLQ depth, erroring past the threshold', () => {
    store.create({ id: 'researcher', name: 'Research' });
    for (let i = 0; i < 7; i++) {
      queue.enqueue({
        id: `j${i}`, botId: 'researcher', trigger: 'chat', prompt: `p${i}`,
        attempts: 0, createdAt: i, idempotencyKey: `k${i}`,
      });
      queue.settle(`j${i}`, 'dead', 'unknown_error');
    }
    const report = runBotDoctor({ store, queue, journalFor: () => journal });
    const dlqFinding = report.findings.find(f => f.check === 'dlq')!;
    expect(dlqFinding.botId).toBe('researcher');
    expect(dlqFinding.detail).toContain('7 dead-lettered');
    expect(dlqFinding.severity).toBe('error');
  });

  it('flags orphaned DLQ entries for bots with no profile', () => {
    queue.enqueue({
      id: 'x1', botId: 'ghost', trigger: 'chat', prompt: 'p',
      attempts: 0, createdAt: Date.now(), idempotencyKey: 'k',
    });
    queue.settle('x1', 'dead', 'unknown_error');
    const report = runBotDoctor({ store, queue, journalFor: () => journal });
    expect(report.findings.some(f => f.check === 'orphan-dlq' && f.botId === 'ghost')).toBe(true);
  });

  it('flags a configured routine missing from the scheduler', () => {
    store.create({
      id: 'researcher',
      name: 'Research',
      manifest: { schedules: [{ name: 'morning', cron: '0 9 * * *', prompt: 'go' }] },
    });
    const report = runBotDoctor({ store, queue, journalFor: () => journal, scheduledRoutineIds: [] });
    expect(report.findings.some(f => f.check === 'schedule-registered')).toBe(true);
    // Registered → no finding
    const ok = runBotDoctor({ store, queue, journalFor: () => journal, scheduledRoutineIds: ['bot:researcher:morning'] });
    expect(ok.findings.some(f => f.check === 'schedule-registered')).toBe(false);
  });

  it('flags config validation errors', () => {
    const { writeFileSync } = require('node:fs');
    const manifestDir = join(root, 'bots', 'badbot');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'bot.yaml'), 'id: badbot\nname: ""\n', 'utf-8');
    const report = runBotDoctor({ store, queue, journalFor: () => journal });
    const configFinding = report.findings.find(f => f.botId === 'badbot' && f.check === 'config');
    expect(configFinding?.severity).toBe('error');
    expect(configFinding?.detail).toContain('name is required');
    expect(report.healthy).toBe(false);
  });

  it('flags malformed permissions.yaml entries (missing "scope") as an error', () => {
    store.create({ id: 'researcher', name: 'Research' });
    store.writePermissions('researcher', {
      paths: [
        { scope: 'self', read: true, write: true },
        { socpe: '/tmp/cookies', read: true } as unknown as { scope: string; read: boolean },
      ],
    });
    const report = runBotDoctor({ store, queue, journalFor: () => journal });
    const finding = report.findings.find(f => f.botId === 'researcher' && f.check === 'permissions');
    expect(finding?.severity).toBe('error');
    expect(finding?.detail).toContain('socpe');
    expect(report.healthy).toBe(false);
  });

  it('formatDoctorReport maps unhealthy to an actionable message', () => {
    const healthy = formatDoctorReport({ findings: [], healthy: true, checked: 2 });
    expect(healthy).toContain('healthy');
    const sick = formatDoctorReport({
      findings: [{ botId: 'a', severity: 'error', check: 'dlq', detail: '1 dead-lettered job(s)' }],
      healthy: false,
      checked: 2,
    });
    expect(sick).toContain('[a] dlq');
  });
});
describe('doctor liveness (stale bots)', () => {
  it('flags an enabled bot with a declared cadence that has not run in twice its interval', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercury-doctor-stale-'));
    try {
      const store = new BotStore(join(root, 'bots'));
      const queue = new BotQueue(join(root, 'bots'), 100);
      try {
        store.create({ id: 'ticker', name: 'Ticker', manifest: { schedules: [{ name: 'cycle', cron: '*/15 * * * *', prompt: 'x' }] } });
        const journal = new BotJournal(store.botDir('ticker'));
        journal.append({ runId: 'r1', botId: 'ticker', trigger: 'cron', state: 'completed', startedAt: Date.now() - 5 * 3600 * 1000, durationMs: 1000, tokensIn: 1, tokensOut: 1 });
        const report = runBotDoctor({ store, queue, journalFor: () => journal, scheduledRoutineIds: ['bot:ticker:cycle'] });
        const stale = report.findings.find(f => f.check === 'stale');
        expect(stale?.detail).toContain('every 15 min');
        // A fresh run clears it.
        journal.append({ runId: 'r2', botId: 'ticker', trigger: 'cron', state: 'completed', startedAt: Date.now(), durationMs: 1000, tokensIn: 1, tokensOut: 1 });
        expect(runBotDoctor({ store, queue, journalFor: () => journal, scheduledRoutineIds: ['bot:ticker:cycle'] }).findings.some(f => f.check === 'stale')).toBe(false);
      } finally {
        queue.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
