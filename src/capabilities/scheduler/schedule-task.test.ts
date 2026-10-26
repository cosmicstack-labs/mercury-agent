import { describe, expect, it } from 'vitest';
import { createScheduleTaskTool } from './schedule-task.js';
import { PermissionManager } from '../permissions.js';
import type { ScheduledTaskManifest } from '../../core/scheduler.js';

function setup(role?: 'admin' | 'member') {
  const added: ScheduledTaskManifest[] = [];
  const asked: string[] = [];
  const scheduler = {
    addDelayedTask: (m: ScheduledTaskManifest) => added.push(m),
    addPersistedTask: (m: ScheduledTaskManifest) => added.push(m),
    persistSchedules: () => {},
  };
  const permissions = {
    requestApproval: async (prompt: string) => { asked.push(prompt); return true; },
    getCurrentSenderRole: () => role,
  } as unknown as PermissionManager;
  const tool = createScheduleTaskTool(scheduler as never, permissions, () => ({ channelId: 'whatsapp:o@lid', channelType: 'whatsapp' })) as unknown as {
    execute: (a: Record<string, unknown>) => Promise<string>;
  };
  return { tool, added, asked };
}

describe('schedule_task with allow_tools', () => {
  it('"call me in 10 minutes": the owner approves the call once, at creation', async () => {
    const { tool, added, asked } = setup('admin');
    const out = await tool.execute({ delay_seconds: 600, description: 'Call about the meeting', prompt: 'Call the owner about the meeting.', allow_tools: ['whatsapp__call_owner'] });
    expect(out).toMatch(/Will trigger in 600 seconds/);
    expect(asked[0]).toMatch(/may use whatsapp__call_owner without asking again/);
    expect(added[0]).toMatchObject({ allowTools: ['whatsapp__call_owner'], sourceChannelType: 'whatsapp', delaySeconds: 600 });
  });

  it('recurring tasks keep allow_tools too', async () => {
    const { tool, added } = setup();
    await tool.execute({ cron: '0 18 * * *', description: 'Evening briefing call', prompt: 'Call me with the briefing.', allow_tools: ['whatsapp__call_owner'] });
    expect(added[0]).toMatchObject({ cron: '0 18 * * *', allowTools: ['whatsapp__call_owner'] });
  });

  it('only plugin tools, and never from a member', async () => {
    const { tool, added } = setup();
    expect(await tool.execute({ delay_seconds: 60, description: 'x', prompt: 'x', allow_tools: ['run_command'] })).toMatch(/only takes plugin tools/);
    const member = setup('member');
    expect(await member.tool.execute({ delay_seconds: 60, description: 'x', prompt: 'x', allow_tools: ['whatsapp__call_owner'] })).toMatch(/Only the owner/);
    expect([...added, ...member.added]).toEqual([]);
  });

  it('without allow_tools nothing is pre-approved', async () => {
    const { tool, added, asked } = setup('admin');
    await tool.execute({ delay_seconds: 60, description: 'Remind me', prompt: 'Remind me to stretch' });
    expect(added[0].allowTools).toBeUndefined();
    expect(asked[0]).toBe('Create scheduled task: Remind me');
  });
});

describe('turn grants', () => {
  it('a granted plugin tool runs without asking for that turn only', async () => {
    const pm = new PermissionManager();
    pm.setCurrentContext('whatsapp', 'whatsapp:o@lid');
    pm.onAsk(async () => 'no');
    pm.setTurnPluginGrants(['whatsapp__call_owner']);
    expect(await pm.approvePluginTool('whatsapp__call_owner', 'x')).toBe(true);
    expect(await pm.approvePluginTool('other__tool', 'x')).toBe(false);
    pm.setTurnPluginGrants([]);
    expect(await pm.approvePluginTool('whatsapp__call_owner', 'x')).toBe(false);
  });
});
