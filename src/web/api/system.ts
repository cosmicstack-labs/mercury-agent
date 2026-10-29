import { Hono } from 'hono';
import type { BaseProvider } from '../../providers/base.js';
import { BUILDER_VERIFIED_NOTE, buildSkillDraft, draftProblem, type SkillDraft } from '../../skills/builder.js';
import { SELF_MADE_CATEGORY, composeSkillMd, readSelfMadeMeta, slugify } from '../../skills/self-made.js';
import { readHistory, historySince } from '../../utils/token-history.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkillLoader } from '../../skills/loader.js';
import { RegistryClient, isValidSkillId } from '../../skills/registry.js';
import { SkillStore } from '../../skills/store.js';
import { PermissionManager, type PermissionsManifest } from '../../capabilities/permissions.js';
import { getMercuryHome } from '../../utils/config.js';
import { getStatus } from './status.js';
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
      selfMade: skill.category === SELF_MADE_CATEGORY,
      version: full?.version ?? null,
      allowedTools: full?.['allowed-tools'] ?? [],
      hasScripts: !!full?.scriptsDir,
      hasReferences: !!full?.referencesDir,
    };
  });
  return c.json({ skills, total: skills.length });
});

// ── Skill builder: describe a skill, Mercury writes it, you save it ─────────

type BuilderDeps = { provider: () => BaseProvider; tools: () => string[] };
let builder: BuilderDeps | null = null;
/** Registered by the runtime: the model to write with and the tools a skill may use. */
export function setSkillBuilder(deps: BuilderDeps | null): void { builder = deps; }

system.post('/api/skills/draft', async (c) => {
  if (!builder) return c.json({ error: 'The skill builder needs Mercury running with a model.' }, 503);
  const body = (await c.req.json().catch(() => ({}))) as { request?: unknown; previous?: { draft?: unknown; feedback?: unknown } };
  const request = typeof body.request === 'string' ? body.request.trim() : '';
  if (request.length < 10) return c.json({ error: 'Say a little more about what the skill should do.' }, 400);
  if (request.length > 4000) return c.json({ error: 'Keep the description under 4,000 characters.' }, 400);
  const prev = body.previous && typeof body.previous.feedback === 'string' && body.previous.feedback.trim() && body.previous.draft && typeof body.previous.draft === 'object'
    ? { draft: body.previous.draft as SkillDraft, feedback: body.previous.feedback }
    : undefined;
  try {
    const tools = builder.tools();
    const r = await buildSkillDraft(builder.provider(), request, tools, prev);
    const exists = r.draft.name ? new SkillLoader().load(r.draft.name) : null;
    return c.json({ ...r, clash: exists && exists.category !== SELF_MADE_CATEGORY ? `"${r.draft.name}" is already an installed skill; pick another name.` : null, tools });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

/** Save a reviewed draft as a self-made skill (marked not run yet until Mercury uses it). */
system.post('/api/skills/self-made', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { draft?: Partial<SkillDraft> };
  const d = body.draft ?? {};
  const draft: SkillDraft = {
    name: String(d.name ?? '').trim(),
    description: String(d.description ?? '').trim(),
    intents: Array.isArray(d.intents) ? d.intents.map((i) => String(i).trim()).filter(Boolean) : [],
    instructions: String(d.instructions ?? '').trim(),
    ...(Array.isArray(d.allowedTools) && d.allowedTools.length ? { allowedTools: d.allowedTools.map(String) } : {}),
  };
  const problem = draftProblem(draft);
  if (problem) return c.json({ error: `Not saved: ${problem}.` }, 400);
  const slug = slugify(draft.name)!;
  const loader = new SkillLoader();
  const existing = loader.load(slug);
  if (existing && existing.category !== SELF_MADE_CATEGORY) return c.json({ error: `"${slug}" is already an installed skill. Pick a different name.`, field: 'name' }, 409);
  const file = join(loader.rootDir(), SELF_MADE_CATEGORY, slug, 'SKILL.md');
  const prior = existsSync(file) ? readSelfMadeMeta(readFileSync(file, 'utf-8')) ?? undefined : undefined;
  loader.saveSkill(`${SELF_MADE_CATEGORY}/${slug}`, composeSkillMd({ ...draft, verified: BUILDER_VERIFIED_NOTE }, prior));
  return c.json({ success: true, name: slug, updated: !!prior });
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

system.post('/api/skills/install-from-registry', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = String(body?.id || '').trim();
  if (!id) return c.json({ success: false, error: 'id is required' }, 400);

  if (!isValidSkillId(id)) {
    return c.json(
      { success: false, error: 'Invalid skill id (expected "<category>/<slug>")' },
      400,
    );
  }

  try {
    const registry = new RegistryClient();
    const store = new SkillStore({ registry });
    const result = await store.install(id, { force: Boolean(body?.force) });
    return c.json({
      success: true,
      id: result.id,
      version: result.version,
      status: result.status,
      path: result.path,
      webUrl: registry.webUrl(id),
    });
  } catch (err: any) {
    const status = err?.status === 404 ? 404 : 400;
    return c.json({ success: false, error: err?.message || 'Failed to install skill' }, status);
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

/** Day-by-day tokens for the activity heat map: ?days=1..1100 (default 371). */
system.get('/api/usage/history', (c) => {
  const parsed = parseInt(c.req.query('days') ?? '371', 10);
  const days = Number.isFinite(parsed) ? Math.max(1, Math.min(1100, parsed)) : 371;
  return c.json({ days: readHistory(days), since: historySince() });
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

  // A tracker that exists and cannot be read is not a tracker reporting zeros: the file is the
  // answer, and losing it makes `dailyBudget: 0` read as "unlimited" on the console.
  let available = true;
  if (existsSync(usagePath)) {
    try {
      data = { ...data, ...(JSON.parse(readFileSync(usagePath, 'utf8')) as Record<string, any>) };
    } catch {
      available = false;
      // keep defaults
    }
  }

  const byProvider: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  for (const row of data.requestLog || []) {
    byProvider[row.provider] = (byProvider[row.provider] || 0) + (row.totalTokens || 0);
    byChannel[row.channelType] = (byChannel[row.channelType] || 0) + (row.totalTokens || 0);
  }

  // The budget the runtime enforces is the live one. The tracker file carries whatever was
  // configured the last time tokens were written, so raising the limit used to leave this endpoint
  // reporting the old number — and `remaining` computed from it — until some turn happened to
  // rewrite the file. The file stays the fallback for a runtime that never reported one.
  const live = getStatus().tokenBudget;
  const dailyBudget = Number.isFinite(live) && live > 0 ? live : (data.dailyBudget || 0);
  return c.json({
    available,
    dailyUsed: data.dailyUsed || 0,
    dailyBudget,
    lastResetDate: data.lastResetDate,
    remaining: Math.max(0, dailyBudget - (data.dailyUsed || 0)),
    requestLog: (data.requestLog || []).slice(-100).reverse(),
    byProvider,
    byChannel,
  });
});

system.get('/api/schedules', (c) => {
  // No scheduler in this process is not an empty schedule: the pair is the same shape, and the
  // console cannot tell a bot with no routines from a runtime that never started the scheduler.
  if (!scheduler) return c.json({ available: false, schedules: [], total: 0 });
  const schedules = scheduler.getManifests().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return c.json({ available: true, schedules, total: schedules.length });
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
