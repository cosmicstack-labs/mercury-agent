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