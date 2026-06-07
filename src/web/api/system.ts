import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkillLoader } from '../../skills/loader.js';
import { PermissionManager, type PermissionsManifest } from '../../capabilities/permissions.js';
import { getMercuryHome } from '../../utils/config.js';
import type { Scheduler } from '../../core/scheduler.js';
import cron from 'node-cron';

const system = new Hono();
let scheduler: Scheduler | null = null;

export function setScheduler(s: Scheduler | null): void {
  scheduler = s;
}

system.get('/api/skills', (c) => {
  const loader = new SkillLoader();
  const all = loader.getAllSkills();
  const skills = all.map((skill) => {
    const full = skill.active ? loader.load(skill.name) : null;
    return {
      name: skill.name,
      description: skill.description,
      active: skill.active,
      version: full?.version ?? null,
      allowedTools: full?.['allowed-tools'] ?? [],
      hasScripts: !!full?.scriptsDir,
      hasReferences: !!full?.referencesDir,
    };
  });
  return c.json({ skills, total: skills.length });
});

system.post('/api/skills/install', async (c) => {
  const body = await c.req.json();
  const url = String(body?.url || '').trim();
  if (!url) return c.json({ success: false, error: 'url is required' }, 400);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.json({ success: false, error: 'url must start with http:// or https://' }, 400);
    }
  } catch {
    return c.json({ success: false, error: 'invalid url' }, 400);
  }

  try {
    const loader = new SkillLoader();
    const installed = await loader.installFromUrl(url);
    return c.json({ success: true, name: installed.name, path: installed.skillDir });
  } catch (err: any) {
    return c.json({ success: false, error: err?.message || 'Failed to install skill' }, 400);
  }
});

system.post('/api/skills/:name/activate', (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const loader = new SkillLoader();
  const ok = loader.setSkillActive(name, true);
  if (!ok) return c.json({ success: false, error: 'Skill not found' }, 404);
  return c.json({ success: true });
});

system.post('/api/skills/:name/deactivate', (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const loader = new SkillLoader();
  const ok = loader.setSkillActive(name, false);
  if (!ok) return c.json({ success: false, error: 'Skill not found' }, 404);
  return c.json({ success: true });
});

system.delete('/api/skills/:name', (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const loader = new SkillLoader();
  const ok = loader.deleteSkill(name);
  if (!ok) return c.json({ success: false, error: 'Skill not found' }, 404);
  return c.json({ success: true });
});

system.get('/api/permissions', (c) => {
  const manager = new PermissionManager();
  const manifest = manager.getManifest();
  return c.json({ manifest });
});

system.put('/api/permissions', async (c) => {
  const body = await c.req.json();
  const manager = new PermissionManager();
  const current = manager.getManifest();
  const next: PermissionsManifest = {
    capabilities: {
      filesystem: {
        enabled: body?.capabilities?.filesystem?.enabled ?? current.capabilities.filesystem.enabled,
        scopes: body?.capabilities?.filesystem?.scopes ?? current.capabilities.filesystem.scopes,
      },
      shell: {
        enabled: body?.capabilities?.shell?.enabled ?? current.capabilities.shell.enabled,
        blocked: body?.capabilities?.shell?.blocked ?? current.capabilities.shell.blocked,
        autoApproved: body?.capabilities?.shell?.autoApproved ?? current.capabilities.shell.autoApproved,
        needsApproval: body?.capabilities?.shell?.needsApproval ?? current.capabilities.shell.needsApproval,
        cwdOnly: body?.capabilities?.shell?.cwdOnly ?? current.capabilities.shell.cwdOnly,
      },
      git: {
        enabled: body?.capabilities?.git?.enabled ?? current.capabilities.git.enabled,
        autoApproveRead: body?.capabilities?.git?.autoApproveRead ?? current.capabilities.git.autoApproveRead,
        approveWrite: body?.capabilities?.git?.approveWrite ?? current.capabilities.git.approveWrite,
      },
    },
  };
  manager.save(next);
  return c.json({ success: true, manifest: next });
});

system.get('/api/usage', (c) => {
  const usagePath = join(getMercuryHome(), 'token-usage.json');
  let data: {
    dailyUsed: number;
    dailyBudget: number;
    lastResetDate: string;
    requestLog: Array<{
      timestamp: number;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      channelType: string;
    }>;
  } = {
    dailyUsed: 0,
    dailyBudget: 0,
    lastResetDate: new Date().toISOString().slice(0, 10),
    requestLog: [],
  };

  if (existsSync(usagePath)) {
    try {
      data = { ...data, ...(JSON.parse(readFileSync(usagePath, 'utf8')) as Record<string, any>) };
    } catch {
      // keep defaults
    }
  }

  const byProvider: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  for (const row of data.requestLog || []) {
    byProvider[row.provider] = (byProvider[row.provider] || 0) + (row.totalTokens || 0);
    byChannel[row.channelType] = (byChannel[row.channelType] || 0) + (row.totalTokens || 0);
  }

  return c.json({
    dailyUsed: data.dailyUsed || 0,
    dailyBudget: data.dailyBudget || 0,
    lastResetDate: data.lastResetDate,
    remaining: Math.max(0, (data.dailyBudget || 0) - (data.dailyUsed || 0)),
    requestLog: (data.requestLog || []).slice(-100).reverse(),
    byProvider,
    byChannel,
  });
});

system.get('/api/schedules', (c) => {
  if (!scheduler) return c.json({ schedules: [], total: 0 });
  const schedules = scheduler.getManifests().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return c.json({ schedules, total: schedules.length });
});

system.put('/api/schedules/:id', async (c) => {
  if (!scheduler) return c.json({ success: false, error: 'Scheduler unavailable' }, 503);
  const id = c.req.param('id');
  const existing = scheduler.getManifest(id);
  if (!existing) return c.json({ success: false, error: 'Schedule not found' }, 404);

  const body = await c.req.json();
  const description = typeof body.description === 'string' && body.description.trim()
    ? body.description.trim()
    : existing.description;
  const prompt = typeof body.prompt === 'string' ? body.prompt : existing.prompt;
  const skillName = typeof body.skillName === 'string' ? body.skillName : existing.skillName;

  let cronExpr: string | undefined = undefined;
  let delaySeconds: number | undefined = undefined;

  if (body.cron !== undefined && body.cron !== null && String(body.cron).trim() !== '') {
    cronExpr = String(body.cron).trim();
    if (!cron.validate(cronExpr)) {
      return c.json({ success: false, error: 'Invalid cron expression' }, 400);
    }
  } else if (body.delaySeconds !== undefined && body.delaySeconds !== null && Number(body.delaySeconds) > 0) {
    delaySeconds = Number(body.delaySeconds);
  } else if (existing.cron) {
    cronExpr = existing.cron;
  } else if (existing.delaySeconds) {
    delaySeconds = existing.delaySeconds;
  }

  if (!cronExpr && !delaySeconds) {
    return c.json({ success: false, error: 'Provide cron or delaySeconds' }, 400);
  }

  const manifest = {
    ...existing,
    id,
    description,
    prompt,
    skillName,
    cron: cronExpr,
    delaySeconds,
    executeAt: delaySeconds ? new Date(Date.now() + delaySeconds * 1000).toISOString() : undefined,
  };

  scheduler.replaceManifest(manifest);
  scheduler.persistSchedules();
  return c.json({ success: true, schedule: scheduler.getManifest(id) });
});

system.delete('/api/schedules/:id', (c) => {
  if (!scheduler) return c.json({ success: false, error: 'Scheduler unavailable' }, 503);
  const id = c.req.param('id');
  const existing = scheduler.getManifest(id);
  if (!existing) return c.json({ success: false, error: 'Schedule not found' }, 404);
  scheduler.removeTask(id);
  scheduler.persistSchedules();
  return c.json({ success: true });
});

export default system;
