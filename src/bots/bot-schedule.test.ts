import { describe, it, expect, beforeEach } from 'vitest';
import { createBotScheduleTool, type BotScheduler } from './tools/bot-schedule.js';

function makeScheduler(): BotScheduler & { manifests: any[] } {
  const manifests: any[] = [];
  return {
    manifests,
    addDelayedTask(m: any) { manifests.push({ type: 'delayed', ...m }); },
    addPersistedTask(m: any) { manifests.push({ type: 'persisted', ...m }); },
    persistSchedules() { void 0; },
    getManifests() { return manifests; },
  } as any;
}

describe('bot_schedule (bot self-scheduling)', () => {
  let scheduler: ReturnType<typeof makeScheduler>;
  let tool: any;

  beforeEach(() => {
    scheduler = makeScheduler();
    tool = createBotScheduleTool(scheduler, 'publisher');
  });

  it('schedules a one-shot delayed run that survives restart (executeAt persisted)', async () => {
    const reply = await tool.execute({ prompt: 'post the follow-up thread', delayMinutes: 60 });
    expect(reply).toContain('60 min');
    expect(scheduler.manifests).toHaveLength(1);
    const m = scheduler.manifests[0];
    expect(m.type).toBe('delayed');
    expect(m.botId).toBe('publisher');
    expect(m.delaySeconds).toBe(3600);
    expect(m.executeAt).toBeTruthy();
    expect(m.id).toMatch(/^bot:publisher:self-/);
  });

  it('schedules recurring routines by name and replaces on re-schedule', async () => {
    const first = await tool.execute({ prompt: 'weekly scan', cron: '0 9 * * 1', name: 'Weekly Scan' });
    expect(first).toContain('routine');
    const m = scheduler.manifests[0];
    expect(m.type).toBe('persisted');
    expect(m.cron).toBe('0 9 * * 1');
    expect(m.id).toBe('bot:publisher:routine-weekly-scan');
    expect(m.botId).toBe('publisher');
  });

  it('rejects invalid cron and requires a name for cron', async () => {
    expect(await tool.execute({ prompt: 'x', cron: 'every morning', name: 'n' })).toContain('not a 5-field cron');
    expect(await tool.execute({ prompt: 'x', cron: '0 9 * * 1' })).toContain('need a name');
  });

  it('rejects ambiguous input: both one-shot and cron', async () => {
    const reply = await tool.execute({ prompt: 'x', delayMinutes: 30, cron: '0 9 * * 1', name: 'n' });
    expect(reply).toContain('exactly one');
  });

  it('caps pending one-shots at 10 per bot (runaway-loop guard)', async () => {
    for (let i = 0; i < 10; i++) {
      const reply = await tool.execute({ prompt: `task ${i}`, delayMinutes: i + 1 });
      expect(reply).toContain('Scheduled');
    }
    const reply = await tool.execute({ prompt: 'task 11', delayMinutes: 5 });
    expect(reply).toContain('pending self-scheduled runs');
    expect(scheduler.manifests).toHaveLength(10);
  });

  it('rejects delays beyond the 30-day horizon and invalid ISO timestamps', async () => {
    expect(await tool.execute({ prompt: 'x', delayMinutes: 50000 })).toContain('day horizon');
    expect(await tool.execute({ prompt: 'x', executeAt: 'not-a-date' })).toContain('not a valid ISO');
    const tooFar = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();
    expect(await tool.execute({ prompt: 'x', executeAt: tooFar })).toContain('day horizon');
  });

  it('the cap counts only this bot\'s one-shots', async () => {
    for (let i = 0; i < 10; i++) {
      await tool.execute({ prompt: `t${i}`, delayMinutes: 5 });
    }
    const otherTool = createBotScheduleTool(scheduler, 'other-bot');
    const reply = await (otherTool as any).execute({ prompt: 'other', delayMinutes: 5 });
    expect(reply).toContain('Scheduled');
  });
});