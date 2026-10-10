import { Hono } from 'hono';
import type { Context } from 'hono';
import { readFileSync } from 'node:fs';
import type { BotManager } from '../../bots/bot-manager.js';
import type { BotManifest } from '../../bots/types.js';
import { PERMISSION_TIERS, tierPermissionsFile, isPermissionTier, type PermissionTier } from '../../bots/permission-tiers.js';
import { buildBotBundle, importBotBundle } from '../../bots/bundle.js';

const app = new Hono();

let botManager: BotManager | undefined;
let webhookSecret: string | undefined;

export function setBotManager(bm: BotManager | undefined): void {
  botManager = bm;
}

/** Shared secret for bot webhook ingress; unset = auth via the web session only. */
export function setBotsWebhookSecret(secret: string | undefined): void {
  webhookSecret = secret;
}

// Fleet roster with live states
app.get('/api/bots', (c: any) => {
  if (!botManager) {
    return c.json({ bots: [], available: false });
  }
  return c.json({ bots: botManager.getStatusSummaries(), queue: botManager.queue.counts(), available: true });
});

// Onboard a bot
app.post('/api/bots', async (c: any) => {
  if (!botManager) {
    return c.json({ error: 'Bots not available' }, 400);
  }
  const body = await c.req.json().catch(() => null) as
    { id?: string; name?: string; description?: string; persona?: string; tier?: string; manifest?: Partial<BotManifest> } | null;
  if (!body?.id || !body?.name) {
    return c.json({ error: 'id and name are required' }, 400);
  }
  if (body.tier !== undefined && !isPermissionTier(body.tier)) {
    return c.json({ error: `Unknown permission tier: ${body.tier}` }, 400);
  }
  try {
    const manifest = botManager.store.create({
      id: body.id,
      name: body.name,
      description: body.description,
      persona: body.persona,
      manifest: body.manifest,
    });
    // Tiers execute (§2.5): the chosen tier writes the full permissions.yaml
    // — tool gate AND path scopes. A tier choice that only flipped the tool
    // gate left bots unable to act.
    if (body.tier) {
      botManager.store.writePermissions(manifest.id, tierPermissionsFile(body.tier as PermissionTier));
    }
    botManager.invalidateRuntime(manifest.id);
    return c.json({ bot: manifest }, 201);
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Failed to create bot' }, 400);
  }
});

// ── Real-time fleet feed (SSE) ──────────────────────────────────────────────
// Mirrors the Kanban events route: one connection per browser tab, roster
// snapshot on connect, live bot_activity + bot_deliverable events from the
// in-process activity bus, keepalive, cleanup on abort. The web dashboard
// rides the same bus as the CLI's bot-thread live region.

/** Open fleet-feed clients — roster mutations (add crew, promote, delete) push fresh snapshots. */
const rosterSseClients = new Set<{ send: (event: string, data: unknown) => void }>();

function broadcastRoster(): void {
  if (!botManager) return;
  for (const client of rosterSseClients) {
    client.send('bot_roster', { bots: botManager.getStatusSummaries(), queue: botManager.queue.counts() });
  }
}

app.get('/api/bots/events', (c: any) => {
  const bm = botManager;
  if (!bm) return c.json({ error: 'Bots not available' }, 400);
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const controllerRef = controller;
      const client = { send: (event: string, data: unknown) => {
        try {
          controllerRef.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // client disconnected — abort handler cleans up
        }
      } };

      // Snapshot on connect so the UI paints immediately (no first-event wait).
      client.send('bot_roster', { bots: bm.getStatusSummaries(), queue: bm.queue.counts() });
      rosterSseClients.add(client);

      const unsubscribe = bm.onBotActivity((ev) => client.send('bot_activity', ev));

      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { clearInterval(keepalive); }
      }, 15000);

      c.req.raw.signal?.addEventListener('abort', () => {
        clearInterval(keepalive);
        unsubscribe();
        rosterSseClients.delete(client);
      });
    },
    cancel() {},
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
});

// ── Deliverables (owner-curated outputs zone — bot_deliver) ────────────────
// Fleet-wide inbox, newest first.
app.get('/api/bots/outputs', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  return c.json({ outputs: botManager.listDeliverables() });
});

// ── Tier catalog for the onboarding wizard ──────────────────────────────────
app.get('/api/bots/tiers', (c: any) => {
  const tiers = Object.entries(PERMISSION_TIERS).map(([id, t]) => ({
    id, label: t.label, description: t.description, deny: t.deny,
  }));
  return c.json({ tiers });
});

// Import a shared bundle (bots start disabled — review before enabling).
app.post('/api/bots/import', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const bundle = await c.req.json().catch(() => null) as any;
  if (!bundle) return c.json({ error: 'Invalid JSON body' }, 400);
  try {
    const report = importBotBundle(botManager.store, bundle, c.req.query('overwrite') === '1' ? { overwrite: true } : {});
    for (const created of report.created) botManager.invalidateRuntime(created);
    return c.json({ report });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Invalid bundle' }, 400);
  }
});

// Single bot detail (manifest + live state + journal tail)
app.get('/api/bots/:id', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  let manifest;
  try {
    manifest = botManager.store.get(id);
  } catch {
    return c.json({ error: 'Bot not found' }, 404);
  }
  if (!manifest) return c.json({ error: 'Bot not found' }, 404);
  const summary = botManager.getStatusSummaries().find(s => s.id === id) ?? null;
  return c.json({
    bot: manifest,
    state: summary,
    journal: botManager.getJournal(id, 10),
    inbox: botManager.peekMailbox(id),
  });
});

// Patch config (enable/disable, model, tools, memory, comms, schedules)
app.patch('/api/bots/:id', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  const patch = await c.req.json().catch(() => null) as Partial<BotManifest> | null;
  if (!patch) return c.json({ error: 'Invalid JSON body' }, 400);
  try {
    const updated = botManager.store.update(id, m => {
      // Only config-editable fields; id/name identity fields are immutable here.
      if (patch.enabled !== undefined) m.enabled = patch.enabled;
      if (patch.description !== undefined) m.description = patch.description;
      if (patch.model !== undefined) m.model = patch.model;
      if (patch.tools !== undefined) m.tools = patch.tools;
      if (patch.memory !== undefined) m.memory = patch.memory;
      if (patch.comms !== undefined) m.comms = patch.comms;
      if (patch.schedules !== undefined) m.schedules = patch.schedules;
      if (patch.autonomy !== undefined) m.autonomy = patch.autonomy;
      if (patch.retention !== undefined) m.retention = patch.retention;
    });
    botManager.invalidateRuntime(id);
    return c.json({ bot: updated });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Failed to update bot' }, 400);
  }
});

// Message a bot (durable enqueue; returns the job id immediately)
app.post('/api/bots/:id/message', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { message?: string; from?: string } | null;
  if (!body?.message) return c.json({ error: 'message is required' }, 400);
  const result = botManager.enqueue(id, { trigger: 'api', prompt: body.message, fromBot: body.from });
  if (!result.accepted) {
    return c.json({ accepted: false, reasonCode: result.reasonCode }, 409);
  }
  return c.json({ accepted: true, jobId: result.jobId, status: 'accepted' }, 202);
});

// Inbox (pending bot-to-bot mail)
app.get('/api/bots/:id/inbox', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  return c.json({ inbox: botManager.peekMailbox(c.req.param('id')) });
});

// Run journal
app.get('/api/bots/:id/journal', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const limit = parseInt(c.req.query('limit') ?? '20', 10);
  return c.json({ journal: botManager.getJournal(c.req.param('id'), limit) });
});

// Dead-letter queue + replay
app.get('/api/bots/:id/dlq', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  return c.json({ dlq: botManager.getDlq(c.req.param('id')) });
});

app.post('/api/bots/:id/replay/:jobId', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const result = botManager.replayDlq(c.req.param('id'), c.req.param('jobId'));
  if (!result.accepted) return c.json(result, 404);
  return c.json({ ...result, status: 'accepted' });
});

// Enable/disable/stop/start controls
app.post('/api/bots/:id/enable', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  try {
    botManager.setEnabled(c.req.param('id'), true);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 400);
  }
});

app.post('/api/bots/:id/disable', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  try {
    botManager.setEnabled(c.req.param('id'), false);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 400);
  }
});

app.post('/api/bots/:id/stop', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const result = await botManager.stop(c.req.param('id'));
  return c.json({ ok: true, halted: result.halted, heldJobs: result.heldJobs, message: haltedMessage(result) });
});

app.post('/api/bots/:id/start', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  try {
    const result = botManager.start(c.req.param('id'));
    return c.json({ ok: true, resumed: result.resumed, message: result.resumed > 0 ? `Resumed ${result.resumed} held job(s)` : 'Nothing held — bot is ready' });
  } catch (err: any) {
    return c.json({ error: err?.message }, 404);
  }
});

// Fleet semantics — the CLI parity paths (§2.5 / agent.ts offerFleetStep):
// promote → lead; auto-build the matched crew detached with live roster
// broadcasts (30-90s of LLM proposal — the dashboard shows crew cards the
// moment each is created).
app.post('/api/bots/:id/promote', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  if (!botManager.store.exists(id)) return c.json({ error: 'Bot not found' }, 404);
  const result = botManager.promoteLead(id);
  if (!result.ok) return c.json({ error: 'Bot not found' }, 404);
  broadcastRoster();
  return c.json({ ok: true, message: 'Bot is now a fleet lead — it can add/retire crew itself (bot_spawn), or you add specialists from its Ops panel.' });
});

app.post('/api/bots/:id/autocrew', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  if (!botManager.store.exists(id)) return c.json({ error: 'Bot not found' }, 404);
  const bm = botManager;
  bm.autoCrew(id, {
    onMember: (_name, _memberId) => broadcastRoster(),
    onError: (msg) => {
      for (const client of rosterSseClients) client.send('bot_notice', { message: msg });
      broadcastRoster();
    },
    onDone: () => {
      for (const client of rosterSseClients) client.send('bot_notice', { message: `Fleet ready — ${bm.getStatusSummaries().filter((s) => s.parent === id).length} crew member(s) created. Dispatch tasks to any crew bot.` });
      broadcastRoster();
    },
  });
  return c.json({ accepted: true, status: 'building' }, 202);
});

// Fire a routine now (body { routine }) or send a bare wake turn
app.post('/api/bots/:id/run', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const body = await c.req.json().catch(() => null) as { routine?: string } | null;
  const result = botManager.runNow(c.req.param('id'), body?.routine);
  if (!result.accepted) return c.json(result, result.reasonCode === 'routine_unknown' ? 404 : 409);
  return c.json({ ...result, status: 'accepted' }, 202);
});

// Fleet views: crew roster of a lead + add-crew
app.get('/api/bots/:id/crew', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  if (!botManager.store.isLead(id)) return c.json({ error: 'Not a fleet lead' }, 400);
  return c.json({
    lead: botManager.store.get(id),
    crew: botManager.store.crewOf(id),
    maxCrew: botManager.maxCrew(),
  });
});

app.post('/api/bots/:id/crew', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { id?: string; name?: string; description?: string; persona?: string; tier?: string } | null;
  if (!body?.id || !body?.name) return c.json({ error: 'id and name are required' }, 400);
  if (body.tier !== undefined && !isPermissionTier(body.tier)) {
    return c.json({ error: `Unknown permission tier: ${body.tier}` }, 400);
  }
  const result = botManager.addCrew(id, { id: body.id, name: body.name, description: body.description, persona: body.persona });
  if (!result.ok) return c.json({ error: result.error }, 400);
  // A tier choice overrides the crew's verbatim lead inheritance (§2.5:
  // inherit-unless-edited — an explicit tier IS an edit).
  if (body.tier) {
    botManager.store.writePermissions(result.manifest.id, tierPermissionsFile(body.tier as PermissionTier));
  }
  return c.json({ bot: result.manifest }, 201);
});

// Persona (character file) — read + write
app.get('/api/bots/:id/persona', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  if (!botManager.store.exists(id)) return c.json({ error: 'Bot not found' }, 404);
  return c.json({ persona: botManager.store.readPersona(id) });
});

app.put('/api/bots/:id/persona', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const body = await c.req.json().catch(() => null) as { persona?: string } | null;
  if (typeof body?.persona !== 'string' || !body.persona.trim()) {
    return c.json({ error: 'persona (non-empty string) is required' }, 400);
  }
  try {
    botManager.store.writePersona(c.req.param('id'), body.persona);
    botManager.invalidateRuntime(c.req.param('id'));
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Bot not found' }, 404);
  }
});

// Permissions.yaml — the single source of truth (tool gate, path scopes,
// shell lists). PUT with a tier applies the tier wholesale; PUT with a
// full document is the "custom" path. Fleet inheritance: a crew bot shows
// its inherited file; writing creates its own explicit copy.
app.get('/api/bots/:id/permissions', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  if (!botManager.store.exists(id)) return c.json({ error: 'Bot not found' }, 404);
  return c.json({ permissions: botManager.store.readPermissions(id) });
});

app.put('/api/bots/:id/permissions', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  if (!botManager.store.exists(id)) return c.json({ error: 'Bot not found' }, 404);
  const body = await c.req.json().catch(() => null) as { tier?: string; permissions?: any } | null;
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  try {
    if (body.tier !== undefined) {
      if (!isPermissionTier(body.tier)) return c.json({ error: `Unknown permission tier: ${body.tier}` }, 400);
      botManager.store.writePermissions(id, tierPermissionsFile(body.tier as PermissionTier));
    } else if (body.permissions !== undefined) {
      botManager.store.writePermissions(id, body.permissions);
    } else {
      return c.json({ error: 'Supply tier or permissions' }, 400);
    }
    botManager.invalidateRuntime(id);
    return c.json({ permissions: botManager.store.readPermissions(id) });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Invalid permissions document' }, 400);
  }
});

// Shareable bundle (identity + persona + permissions + skills; a lead's
// bundle carries its whole crew). Delivered as an attachment download.
app.get('/api/bots/:id/bundle', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  try {
    const bundle = buildBotBundle(botManager.store, id, { withSkills: true });
    const json = JSON.stringify(bundle, null, 2);
    return new Response(json, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${id}-bundle.json"`,
      },
    });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Failed to build bundle' }, 400);
  }
});

// Token spend per bot and fleet (ADR-022)
app.get('/api/bots-cost', (c: Context) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const days = Math.max(1, Math.min(90, parseInt(c.req.query('days') ?? '7', 10) || 7));
  return c.json(botManager.costReport(days));
});

// Fleet kill switch
app.post('/api/bots-stop-all', async (c: Context) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  return c.json(await botManager.stopAll());
});
app.post('/api/bots-start-all', (c: Context) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  return c.json(botManager.startAll());
});

// Drop dead-lettered jobs (all, or ?bot=<id>)
app.delete('/api/bots-dlq', (c: Context) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const bot = c.req.query('bot') || undefined;
  if (bot && !botManager.store.exists(bot)) return c.json({ error: 'Bot not found' }, 404);
  return c.json({ cleared: botManager.clearDlq(bot) });
});

// A lead's delegated tasks
app.get('/api/bots/:id/tasks', (c: Context) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  if (!botManager.store.exists(c.req.param('id'))) return c.json({ error: 'Bot not found' }, 404);
  return c.json({ tasks: botManager.tasksFor(c.req.param('id')) });
});

// Run transcripts: list, and one run (newest when runId is "latest")
app.get('/api/bots/:id/runs', (c: Context) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  if (!botManager.store.exists(c.req.param('id'))) return c.json({ error: 'Bot not found' }, 404);
  return c.json({ runs: botManager.listTranscripts(c.req.param('id')) });
});
app.get('/api/bots/:id/runs/:runId', (c: Context) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  if (!botManager.store.exists(id)) return c.json({ error: 'Bot not found' }, 404);
  const runId = c.req.param('runId');
  const t = botManager.readTranscript(id, runId === 'latest' ? undefined : runId);
  if (!t) return c.json({ error: 'Transcript not found' }, 404);
  return c.json(t);
});

// This bot's deliverables
app.get('/api/bots/:id/outputs', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  if (!botManager.store.exists(c.req.param('id'))) return c.json({ error: 'Bot not found' }, 404);
  return c.json({ outputs: botManager.listDeliverables(c.req.param('id')) });
});

// Text preview of a deliverable (≤64KB)
app.get('/api/bots/:id/outputs/:name/preview', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const result = botManager.readDeliverable(c.req.param('id'), c.req.param('name'));
  if (!result.found) return c.json({ error: 'Deliverable not found' }, 404);
  return c.json({ preview: result.preview ?? '', truncated: !!result.truncated });
});

// Byte-exact download of a deliverable (content-type guessed from ext).
app.get('/api/bots/:id/outputs/:name/download', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  const name = c.req.param('name');
  const file = botManager.deliverableFile(id, name);
  if (!file) return c.json({ error: 'Deliverable not found' }, 404);
  try {
    const buf = readFileSync(file);
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    });
  } catch {
    return c.json({ error: 'Deliverable not found' }, 404);
  }
});

// Owner curation: remove a deliverable
app.delete('/api/bots/:id/outputs/:name', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const result = botManager.deleteDeliverable(c.req.param('id'), c.req.param('name'));
  if (!result.ok) return c.json({ error: 'Deliverable not found' }, 404);
  return c.json({ ok: true });
});

function haltedMessage(result: { halted: boolean; heldJobs: number }): string {
  const base = result.halted ? 'Halt signal sent' : 'Nothing running';
  return result.heldJobs > 0 ? `${base}; ${result.heldJobs} queued job(s) held` : base;
}

// Storage view
app.get('/api/bots-storage', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  return c.json({ usage: botManager.getStorage(), queue: botManager.queue.counts() });
});

// Delete a bot entirely (profile dir removed)
app.delete('/api/bots/:id', (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  try {
    void botManager.halt(id);
    botManager.store.delete(id);
    botManager.invalidateRuntime(id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 400);
  }
});

// Generic webhook ingress: validate → dedupe → durable enqueue, ack fast
// (BOTS-ARCHITECTURE §2.3). Callers: external systems pushing events into a
// bot (e.g. an RSS monitor or CI pipeline waking the researcher bot).
app.post('/api/bots/:id/hooks/:hook', async (c: any) => {
  if (!botManager) return c.json({ error: 'Bots not available' }, 400);
  const id = c.req.param('id');
  // Auth: shared secret header when configured (webhook callers have no
  // browser session); otherwise the normal authGuard already applied.
  if (webhookSecret) {
    const provided = c.req.header('x-mercury-hook-secret');
    if (provided !== webhookSecret) {
      return c.json({ error: 'Invalid hook secret' }, 401);
    }
  }
  let text: string;
  if (contentTypeIsJson(c.req.header('content-type'))) {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
    text = typeof body.text === 'string' ? body.text : JSON.stringify(body);
  } else {
    text = await c.req.text();
  }
  if (!text.trim()) return c.json({ error: 'Empty payload' }, 400);
  // Idempotency: an explicit event id joins the prompt, so the queue's
  // idempotency key dedupes redeliveries of the same event.
  const eventId = c.req.header('x-event-id');
  const prompt = eventId ? `[hook:${c.req.param('hook')}:${eventId}] ${text}` : `[hook:${c.req.param('hook')}] ${text}`;
  const result = botManager.enqueue(id, { trigger: 'api', prompt });
  if (!result.accepted) {
    return c.json({ accepted: false, reasonCode: result.reasonCode }, 409);
  }
  return c.json({ accepted: true, jobId: result.jobId, status: 'accepted' }, 202);
});

function contentTypeIsJson(value: string | undefined): boolean {
  return (value ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml',
  csv: 'text/csv', pdf: 'application/pdf', html: 'text/html', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip',
};

export default app;