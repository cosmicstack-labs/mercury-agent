/**
 * The /bots chat command: onboarding wizard, fleet management, replay, export/import.
 * Moved out of Agent (P2.1 split); `agent` is the Agent instance.
 */
import type { Agent } from '../agent.js';
import type { ChannelMessage } from '../../types/channel.js';
import { formatRelative, formatBytes } from './format.js';
import path from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { refinePersona } from '../../bots/persona-template.js';
import { PERMISSION_TIERS, tierPermissionsFile, isPermissionTier, type PermissionTier } from '../../bots/permission-tiers.js';
import { buildBotBundle, writeBundle, readBundle, importBotBundle } from '../../bots/bundle.js';
import { applyBotFieldPatch } from '../../bots/edit.js';

export async function handleBotsCommand(agent: Agent, trimmed: string, msg: ChannelMessage, channel: any): Promise<void> {
  const bm = agent.botManager;
  // A /bots command typed from INSIDE a bot thread replies THERE (cli.ts
  // parks the thread id) — the roster/journal/inbox render in the bot's
  // transcript instead of bouncing the user back to the main chat.
  const pendingBot = (channel as any).consumePendingBotChatTarget?.() ?? null;
  const channelId = pendingBot ? `bot:${pendingBot}` : msg.channelId;
  if (!bm) {
    await channel.send('Bots are not available (BotManager not wired).', channelId);
    return;
  }
  const rawArgs = trimmed.slice('/bots'.length).trim();
  const parts = rawArgs.length > 0 ? rawArgs.split(/\s+/) : [];
  const action = (parts[0] ?? '').toLowerCase();

  // All bot-targeting actions accept id OR name — resolve to the id here.
  if (['open', 'send', 'journal', 'inbox', 'budget', 'edit', 'delete', 'enable', 'disable', 'stop', 'pause', 'start', 'run', 'persona', 'crew', 'add-crew', 'remove-crew', 'promote', 'demote', 'permissions'].includes(action) && parts[1]) {
    const resolved = bm.resolveBotId(parts[1]);
    if (resolved) parts[1] = resolved;
  }

  // Any explicit /bots command cancels pending onboarding capture — the
  // user has moved on; a later task in the bot chat must never be eaten
  // by the persona/budget state machine (review K1).
  if (agent.pendingPersonaFor && action !== '') {
    agent.pendingPersonaFor = null;
  }

  const stateIcons: Record<string, string> = { idle: '⚪', queued: '🔵', running: '🟢', paused: '🟡', disabled: '⛔' };
  const runIcons: Record<string, string> = { completed: '✅', failed: '❌', halted: '⛔', paused: '⏸', denied: '🚫' };

  if (action === '' || action === 'list') {
    const summaries = bm.getStatusSummaries();
    if (summaries.length === 0) {
      await channel.send('No bots configured. Use `/bots create <id> "Name" "Description"` to onboard one.', channelId);
      return;
    }
    // Fleet tree: 👑 leads first with crew nested beneath (multi-level,
    // recursive); parentless solos flat after.
    const fmt = (s: typeof summaries[number], indent: string) => {
      const icon = stateIcons[s.state] ?? '❓';
      const badge = s.fleetRole === 'lead' ? ' 👑' : '';
      // Crew runs are short and asynchronous — a snapshot rarely catches
      // them green. Make activity legible anyway: leads show how many crew
      // are working right now, every bot shows its last run outcome.
      const crewNote = s.fleetRole === 'lead' && s.crewWorking
        ? ` · 🟢 ${s.crewWorking} crew working`
        : '';
      const lastRun = s.lastRunAt ? ` · last run ${s.lastRunState ?? '?'} ${formatRelative(s.lastRunAt)}` : '';
      const activity = s.activity ? `\n${indent}   ↳ ${s.activity}` : '';
      const attention = s.needsYou ? ' · ⚠ needs you' : '';
      // Where the owner finds results — on the fleet's folder, not per crew.
      const folder = !s.parent ? `\n${indent}   📁 ${tildify(bm.store.deliverablesDir(s.id))}` : '';
      return `${indent}${icon} **${s.name}** (${s.id})${badge} — ${s.state}${crewNote}${attention}${lastRun}${folder}${activity}`;
    };
    const lines: string[] = [`**Bots** (${summaries.length})`, ''];
    const rendered = new Set<string>();
    const renderCrew = (leadId: string, depth: number) => {
      const crew = summaries.filter(s => s.parent === leadId);
      for (const c of crew) {
        const indent = '  '.repeat(depth);
        lines.push(fmt(c, depth > 0 ? `${indent}└─` : '  '));
        rendered.add(c.id);
        renderCrew(c.id, depth + 1);
      }
      if (crew.length === 0 && depth === 1) {
        lines.push(`${'  '.repeat(depth)}└─ (empty crew — \`/bots add-crew\` or the lead can bot_spawn)`);
      }
    };
    for (const root of summaries.filter(s => !s.parent)) {
      lines.push(fmt(root, ''));
      rendered.add(root.id);
      if (root.fleetRole === 'lead') renderCrew(root.id, 1);
    }
    for (const s of summaries) {
      if (!rendered.has(s.id)) lines.push(fmt(s, '')); // detached crew (defensive)
    }
    const running = summaries.filter(s => s.state === 'running').length;
    lines.push('', `Running: ${running} | Queued: ${summaries.reduce((a, s) => a + (s.state === 'queued' ? 1 : 0), 0)}`);
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'open') {
    const target = parts[1]?.toLowerCase();
    const manifest = target ? bm.store.get(target) : null;
    if (!target || !manifest) {
      await channel.send(`No bot "${target ?? ''}". See \`/bots\` for the roster.`, channelId);
      return;
    }
    if (typeof (channel as any).enterBotChat === 'function') {
      // Hydrate a cold thread from the durable journal (last 10 runs,
      // compact) — the bot may have worked unattended for hours.
      const history = bm.getJournal(target, 10).map(r => ({
        content: `${r.state === 'completed' ? '✅' : r.state === 'failed' ? '❌' : '⛔'} (${r.trigger}, ${formatRelative(r.startedAt)}${r.durationMs ? `, ${(r.durationMs / 1000).toFixed(0)}s` : ''}) ${r.summary?.slice(0, 300) ?? r.runId}`,
        timestamp: r.startedAt,
      })).reverse();
      (channel as any).enterBotChat(target, manifest.name, history);
      return;
    }
    await channel.send(`Opening a bot chat is only supported in the TUI — use \`/bots send ${target} <message>\` here.`, channelId);
    return;
  }

  if (action === 'create' || action === 'onboard') {
    // /bots create <id> "Name" "Description" ["persona text"]
    const id = (parts[1] ?? '').toLowerCase();
    if (!id) {
      await channel.send('Usage: `/bots create <id> "Name" "Description" "persona (optional)"` — the bot starts with a fail-closed default profile you can refine via its profile files.', channelId);
      return;
    }
    const rest = parts.slice(2).join(' ');
    const quoted = [...rest.matchAll(/"([^"]*)"/g)].map(m => m[1]);
    const name = quoted[0] ?? id.toUpperCase();
    const description = quoted[1];
    const personaText = quoted[2];
    try {
      const manifest = bm.store.create({ id, name, description });
      agent.pendingPersonaNewlyCreated = true;
      if (personaText) {
        bm.store.writePersona(id, personaText + '\n');
        bm.invalidateRuntime(id);
        await channel.send(`🤖 Bot **${manifest.name}** (\`${id}\`) onboarded with your persona — enabled, fail-closed defaults.\n📁 Its results will appear in \`${tildify(bm.store.deliverablesDir(id))}\` (\`/bots folder ${id}\` opens it).\nStart using it: \`/bot ${id} <task>\`, \`/bots open ${id}\`, or just \`@${id} <task>\`.`, channelId);
        await agent.offerFleetStep(bm, id, manifest.name, msg, channel);
        return;
      }
      // No persona given — open its chat and prompt for one now (TUI only).
      if (typeof (channel as any).enterBotChat === 'function') {
        (channel as any).enterBotChat(id, manifest.name);
        agent.pendingPersonaFor = id;
        await channel.send(
          `🤖 **${manifest.name}** onboarded (fail-closed defaults). 📁 Results: \`${tildify(bm.store.deliverablesDir(id))}\`\n\nNow give it its character — your next message here becomes its **persona** (who it is, how it works, how it reports). Send \`/skip\` to keep the starter template, or \`/persona\` later to change it.`,
          `bot:${id}`,
        );
      } else {
        await channel.send(`🤖 Bot **${manifest.name}** (\`${id}\`) onboarded — enabled, fail-closed defaults.\n📁 Results will appear in \`${tildify(bm.store.deliverablesDir(id))}\`.\nPersona: \`${bm.store.botDir(id)}/persona.md\` — set it now with \`/bots persona ${id} <text>\`.`, channelId);
      }
    } catch (err: any) {
      await channel.send(`Could not create bot "${id}": ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'persona') {
    const target = parts[1]?.toLowerCase();
    const personaText = parts.slice(2).join(' ');
    if (!target) {
      await channel.send('Usage: `/bots persona <id> <full persona text in one message>` — or open the bot chat (`/bots open <id>`) and type `/persona`.', channelId);
      return;
    }
    const resolved = bm.resolveBotId(target) ?? target;
    if (!bm.store.exists(resolved)) {
      await channel.send(`No bot "${target}". See \`/bots\` for the roster.`, channelId);
      return;
    }
    if (!personaText) {
      // Bare `/persona` (typed inside the bot chat): arm the capture —
      // the next message in that thread becomes the persona. This is the
      // promised flow ("edit it anytime with /persona here"); it must not
      // degrade to the /bots roster.
      agent.pendingBudgetFor = null;
      agent.pendingPersonaFor = resolved;
      const name = bm.store.get(resolved)?.name ?? resolved;
      await channel.send(`✍️ Persona capture armed for **${name}** — your next message in this chat becomes its persona. \`/skip\` keeps the current one.`, `bot:${resolved}`);
      return;
    }
    await agent.finalizePersona(bm, resolved, personaText, msg);
    return;
  }

  if (action === 'send') {
    const target = parts[1]?.toLowerCase();
    const message = parts.slice(2).join(' ');
    if (!target || !message) {
      await channel.send('Usage: `/bots send <id> <message>`', channelId);
      return;
    }
    const result = bm.enqueue(target, { trigger: 'chat', prompt: message, source: { channelType: msg.channelType, channelId } });
    if (!result.accepted) {
      await channel.send(`Could not message **${target}**: [reason: ${result.reasonCode}]`, channelId);
      return;
    }
    await channel.send(`🤖 Queued for **${target}** (job ${result.jobId}) — runs outside the main conversation.`, channelId);
    return;
  }

  if (action === 'enable' || action === 'disable') {
    const target = parts[1]?.toLowerCase();
    if (!target) {
      await channel.send(`Usage: \`/bots ${action} <id>\``, channelId);
      return;
    }
    try {
      bm.setEnabled(target, action === 'enable');
      await channel.send(`${action === 'enable' ? '✅ Enabled' : '⏸ Disabled'} bot **${target}**.`, channelId);
    } catch (err: any) {
      await channel.send(`Failed: ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'budget') {
    const target = parts[1]?.toLowerCase();
    const value = (parts[2] ?? '').toLowerCase();
    if (!target || !value) {
      const suggested = agent.config.bots?.suggestedDailyTokenBudget ?? 5_000_000;
      await channel.send(`Usage: \`/bots budget <id> <tokens|suggest|none>\` — every bot has a daily cap (default ${suggested.toLocaleString()}/day); suggest = that default, none = unlimited.`, channelId);
      return;
    }
    try {
      bm.store.update(target, m => {
        // 0 = explicitly unlimited; absent = the fleet default applies (ADR-020).
        if (value === 'none') { m.autonomy = { ...m.autonomy, dailyTokenBudget: 0 }; }
        else if (value === 'suggest') { if (m.autonomy) delete m.autonomy.dailyTokenBudget; }
        else {
          const n = parseInt(value, 10);
          if (!Number.isFinite(n) || n <= 0) throw new Error('budget must be a positive integer, "suggest", or "none"');
          m.autonomy = { ...m.autonomy, dailyTokenBudget: n };
        }
      });
      bm.invalidateRuntime(target);
      const m = bm.store.get(target);
      const cap = m ? bm.dailyCapFor(m) : 0;
      const applied = cap > 0 ? `${cap.toLocaleString()}/day${m?.autonomy?.dailyTokenBudget === undefined ? ' (fleet default)' : ''}` : 'none (unlimited)';
      await channel.send(`💰 Budget for **${target}**: ${applied}. Hit the cap → the bot pauses until the next day, never killed.`, channelId);
    } catch (err: any) {
      await channel.send(`Failed: ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'edit') {
    const target = parts[1]?.toLowerCase();
    const path = parts[2];
    const value = parts.slice(3).join(' ');
    if (!target || !path || !value) {
      await channel.send('Usage: `/bots edit <id> <field> <value>`\nEditable fields: name, description, model.provider, model.model, memory.scope, memory.allowCrossBotRecall, comms.canMessage, tools.allow, tools.deny, autonomy.maxConcurrent, autonomy.maxSteps, autonomy.dailyTokenBudget', channelId);
      return;
    }
    try {
      const manifest = bm.store.get(target);
      if (!manifest) throw new Error(`Bot "${target}" does not exist`);
      const result = applyBotFieldPatch(manifest, path, value);
      if (!result.ok) {
        await channel.send(`⚠ ${result.error}`, channelId);
        return;
      }
      bm.store.save(manifest);
      bm.invalidateRuntime(target);
      await channel.send(`✏️ **${target}**.${path} = ${result.display}`, channelId);
    } catch (err: any) {
      await channel.send(`Failed: ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'delete') {
    const target = parts[1]?.toLowerCase();
    const confirmed = parts[2]?.toLowerCase() === 'confirm';
    if (!target || !bm.store.exists(target)) {
      await channel.send('Usage: `/bots delete <id> confirm` — removes the profile dir, halts any running turn, and dead-letters pending jobs. This cannot be undone.', channelId);
      return;
    }
    if (!confirmed && typeof (channel as any).askToContinue === 'function') {
      const crewCount = bm.store.crewOf(target).length;
      const proceed = await (channel as any).askToContinue(`Delete bot **${target}** and its profile (persona, memory links, journal)? This cannot be undone.${crewCount > 0 ? ` Its ${crewCount} crew member(s) will be deleted with it (fleet cascade).` : ''}`);
      if (!proceed) {
        await channel.send('Deletion cancelled.', channelId);
        return;
      }
    } else if (!confirmed) {
      await channel.send(`Type \`/bots delete ${target} confirm\` to permanently delete.`, channelId);
      return;
    }
    try {
      await bm.halt(target);
      bm.store.delete(target);
      bm.invalidateRuntime(target);
      await channel.send(`🗑 Bot **${target}** deleted (running turn halted; its profile directory is gone).`, channelId);
    } catch (err: any) {
      await channel.send(`Failed: ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'export') {
    // /bots export <id> [path] — a shareable bundle: manifests + personas +
    // permissions + skills (single JSON; a lead's bundle carries its whole
    // crew tree). Sandbox, journal, and .env never travel.
    const target = parts[1]?.toLowerCase();
    if (!target || !bm.store.exists(target)) {
      await channel.send('Usage: `/bots export <id> [outPath]` — writes a shareable JSON bundle (fleet leads include their crew).', channelId);
      return;
    }
    try {
      const bundle = buildBotBundle(bm.store, target);
      const outPath = parts.slice(2).join(' ') || undefined;
      const path = writeBundle(bundle, outPath?.trim() || undefined);
      const crewNote = bundle.kind === 'fleet' ? ` (fleet — ${bundle.bots.length} bots incl. crew)` : '';
      await channel.send(`📦 Exported **${target}**${crewNote} → \`${path}\`\nIncluded: manifests, personas, permissions, skills. Never included: sandbox, journals, .env (local state + secrets).`, channelId);
    } catch (err: any) {
      await channel.send(`Export failed: ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'import') {
    // /bots import <path> — recreate bots from a bundle. Imported bots
    // start DISABLED (fail-closed); enable each one consciously.
    const rawPath = parts.slice(1).join(' ').trim();
    if (!rawPath) {
      await channel.send('Usage: `/bots import <bundlePath>` — recreates bots from a `.bot.json` bundle. Imported bots start disabled; enable with `/bots enable <id>`.', channelId);
      return;
    }
    try {
      const bundle = readBundle(rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath);
      const report = importBotBundle(bm.store, bundle, { overwrite: parts.includes('--overwrite') });
      const lines: string[] = [];
      if (report.created.length > 0) lines.push(`✅ Created: ${report.created.map(id => `\`${id}\``).join(', ')} (disabled — enable with \`/bots enable <id>\`)`);
      for (const s of report.skipped) lines.push(`⏭ \`${s.id}\`: ${s.reason}`);
      if (lines.length === 0) lines.push('Nothing to import.');
      await channel.send(`📥 Import from \`${rawPath}\`:\n${lines.join('\n')}`, channelId);
    } catch (err: any) {
      await channel.send(`Import failed: ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'stop' || action === 'pause') {
    const target = parts[1]?.toLowerCase();
    if (!target) {
      await channel.send('Usage: `/bots stop <id>` or `/bots stop all` (kill switch — every bot halts, queued work is held)', channelId);
      return;
    }
    if (target === 'all') {
      const r = await bm.stopAll();
      await channel.send(`🛑 Kill switch: ${r.stopped} bot(s) stopped, ${r.halted} running turn(s) halted, ${r.heldJobs} queued job(s) held. Nothing runs until \`/bots start all\` (or per bot).`, channelId);
      return;
    }
    const result = await bm.stop(target);
    const crewNote = result.crewStopped > 0 ? `\n🛑 Fleet cascade: ${result.crewStopped} crew bot(s) stopped with it.` : '';
    const heldNote = result.heldJobs > 0 ? `\n↩ ${result.heldJobs} queued job(s) held fleet-wide — resume with \`/bots start ${target}\`.` : '';
    await channel.send(result.halted
      ? `⛔ Halt signal sent to **${target}** — it will stop after the current tool step.${crewNote}${heldNote}`
      : `⛔ **${target}** stopped — nothing was running.${crewNote}${heldNote}`, channelId);
  }

  if (action === 'start' && parts[1]?.toLowerCase() === 'all') {
    const r = bm.startAll();
    await channel.send(`▶ Started ${r.started} fleet(s)/solo bot(s); ${r.resumed} held job(s) resumed; paused routines cleared.`, channelId);
    return;
  }

  if (action === 'start') {
    const target = parts[1]?.toLowerCase();
    if (!target) {
      await channel.send('Usage: `/bots start <id>`', channelId);
      return;
    }
    try {
      const { resumed } = bm.start(target);
      await channel.send(resumed > 0
        ? `▶️ **${target}** started — ${resumed} held job(s) back in the queue.`
        : `▶️ **${target}** started — nothing was held; it is idle and ready for tasks.`, channelId);
    } catch (err: any) {
      await channel.send(`Failed: ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'run') {
    const target = parts[1]?.toLowerCase();
    const routine = parts.slice(2).join(' ') || undefined;
    if (!target) {
      await channel.send('Usage: `/bots run <id> [routineName]` — no routine = a bare wake turn.', channelId);
      return;
    }
    const result = bm.runNow(target, routine);
    if (!result.accepted) {
      if (result.reasonCode === 'routine_unknown') {
        const names = (bm.store.get(target)?.schedules ?? []).map(r => r.name);
        await channel.send(`No routine "${routine}" on **${target}**.${names.length ? ` Configured: ${names.join(', ')}` : ' This bot has no routines — add them with `/bots edit <id>` or /bots open.'}`, channelId);
        return;
      }
      await channel.send(`Could not run **${target}**: [reason: ${result.reasonCode}]`, channelId);
      return;
    }
    await channel.send(routine
      ? `🏃 Routine **${routine}** fired on **${target}** (job ${result.jobId}) — runs outside the main conversation.`
      : `🏃 Wake sent to **${target}** (job ${result.jobId}) — it gets a turn to check its mailbox and pending work.`, channelId);
    return;
  }

  if (action === 'journal') {
    const target = parts[1]?.toLowerCase();
    if (!target) {
      await channel.send('Usage: `/bots journal <id>`', channelId);
      return;
    }
    const records = bm.getJournal(target, 10);
    if (records.length === 0) {
      await channel.send(`No runs recorded yet for **${target}**.`, channelId);
      return;
    }
    const lines = [`**${target} — recent runs**`, ''];
    for (const r of [...records].reverse()) {
      const icon = r.state === 'completed' ? '✅' : r.state === 'failed' ? '❌' : r.state === 'paused' ? '⏸' : '⛔';
      const reason = r.reasonCode ? ` · [reason: ${r.reasonCode}]` : '';
      const outcome = r.outcome ? ` · ${r.outcome === 'none' ? '⚠ no outcome' : r.outcome}` : '';
      const runFor = r.turnStartedAt ? ((Date.now() - r.turnStartedAt < r.durationMs ? r.durationMs : (r.startedAt + r.durationMs - r.turnStartedAt)) / 1000).toFixed(0) + 's run' : (r.durationMs / 1000).toFixed(1) + 's';
      lines.push(`${icon} ${r.runId} · ${r.trigger} · ${r.state} · ${runFor} · ${(r.tokensIn + r.tokensOut).toLocaleString()} tok${r.steps !== undefined ? ` · ${r.steps} steps` : ''}${outcome}${reason}`);
      for (const d of r.deliverables ?? []) lines.push(`   📁 ${tildify(d)}`);
      if (r.summary) lines.push(`   ${r.summary.slice(0, 100)}`);
    }
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'inbox') {
    const target = parts[1]?.toLowerCase();
    if (!target) {
      await channel.send('Usage: `/bots inbox <id>`', channelId);
      return;
    }
    const mail = bm.peekMailbox(target);
    if (mail.length === 0) {
      await channel.send(`**${target}** mailbox is empty.`, channelId);
      return;
    }
    const lines = [`**${target} — inbox** (${mail.length})`, ''];
    for (const m of mail) {
      lines.push(`🤖 from **${m.from}**: ${m.content.slice(0, 120)}`);
    }
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'dlq') {
    // /bots dlq clear [id] — drop dead-lettered jobs (the journal keeps the runs).
    if (parts[1]?.toLowerCase() === 'clear') {
      const target = parts[2]?.toLowerCase();
      if (target && !bm.store.exists(target)) {
        await channel.send(`No bot "${target}".`, channelId);
        return;
      }
      const n = bm.clearDlq(target);
      await channel.send(n > 0 ? `🧹 Cleared ${n} dead-lettered job(s)${target ? ` for **${target}**` : ''}. The runs stay in \`/bots journal\`.` : 'Dead-letter queue was already empty.', channelId);
      return;
    }
    const target = parts[1]?.toLowerCase();
    const entries = target ? bm.getDlq(target) : bm.getDlq();
    if (entries.length === 0) {
      await channel.send('Dead-letter queue is empty — nothing failed permanently.', channelId);
      return;
    }
    const lines = ['**Dead-letter queue** (replay: `/bots replay <botId> <jobId>` · clear: `/bots dlq clear [id]`)', ''];
    for (const e of entries.slice(0, 10)) {
      lines.push(`🚫 **${e.botId}** ${e.id} · ${e.trigger} · attempts ${e.attempts} · [reason: ${e.reasonCode ?? 'unknown'}] · ${e.prompt.slice(0, 60)}`);
    }
    if (entries.length > 10) lines.push(`…and ${entries.length - 10} more`);
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'replay') {
    const target = parts[1]?.toLowerCase();
    const jobId = parts[2];
    if (!target || !jobId) {
      await channel.send('Usage: `/bots replay <botId> <jobId>`', channelId);
      return;
    }
    const result = bm.replayDlq(target, jobId);
    if (!result.accepted) {
      await channel.send(`Replay failed: [reason: ${result.reasonCode}] — is that job id in the DLQ?`, channelId);
      return;
    }
    await channel.send(`↻ Job ${jobId} re-enqueued for **${target}** (new job ${result.jobId}).`, channelId);
    return;
  }

  if (action === 'permissions') {
    // /bots permissions <id> [tier] — show or set the capability tier.
    const target = parts[1]?.toLowerCase();
    const tierArg = (parts[2] ?? '').toLowerCase();
    if (!target || !bm.store.exists(target)) {
      await channel.send('Usage: `/bots permissions <id> [readonly|builder|operator|full]` — omit the tier to see the current one.', channelId);
      return;
    }
    if (!tierArg) {
      const perms = bm.store.readPermissions(target);
      const deny = new Set(perms.tools?.deny ?? bm.store.get(target)?.tools?.deny ?? []);
      const matched = Object.entries(PERMISSION_TIERS).find(([, t]) => t.deny.length === deny.size && t.deny.every(d => deny.has(d)))?.[0];
      const current = matched ?? 'custom';
      const effective = deny.has('run_command') ? 'no shell' : 'shell within its path scopes';
      const scopeCount = perms.paths?.length ?? 0;
      await channel.send(`🔐 **${target}**: ${current} (deny: ${[...deny].join(', ') || 'none'}, path scopes: ${scopeCount}) — ${effective}. Source: its permissions.yaml. Set with \`/bots permissions ${target} <readonly|builder|operator|full>\`.`, channelId);
      return;
    }
    if (!isPermissionTier(tierArg)) {
      await channel.send('Unknown tier — use `readonly`, `builder`, `operator`, or `full`.', channelId);
      return;
    }
    bm.store.writePermissions(target, tierPermissionsFile(tierArg));
    bm.store.update(target, m => { delete (m as any).tools; });
    bm.invalidateRuntime(target);
    await channel.send(`🔐 Permissions for **${target}**: **${PERMISSION_TIERS[tierArg].label}** — ${PERMISSION_TIERS[tierArg].description}\n(Written to its permissions.yaml — the single source of truth.)`, channelId);
    return;
  }

  if (action === 'promote' || action === 'demote') {
    // /bots promote <id> — solo/crew → fleet lead (demote: lead → solo).
    const target = parts[1]?.toLowerCase();
    if (!target || !bm.store.exists(target)) {
      await channel.send(`Usage: \`/bots ${action} <id>\``, channelId);
      return;
    }
    try {
      bm.store.update(target, m => {
        if (action === 'promote') {
          m.fleetRole = 'lead';
        } else {
          m.fleetRole = undefined;
          if (bm.store.crewOf(target).length > 0) throw new Error(`**${target}** still has crew — remove-crew first`);
        }
      });
      bm.invalidateRuntime(target);
      await channel.send(action === 'promote'
        ? `👑 **${target}** is now a fleet lead. It will self-organize: give it a setup task and it will build its own crew with bot_spawn (persona-derived), or add crew with \`/bots add-crew ${target} …\`.`
        : `⬇ **${target}** demoted to a solo bot.`, channelId);
    } catch (err: any) {
      await channel.send(`Failed: ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'crew') {
    // /bots crew <leadId> — the fleet tree + per-crew recent runs.
    const leadId = parts[1]?.toLowerCase();
    if (!leadId || !bm.store.exists(leadId)) {
      await channel.send('Usage: `/bots crew <leadId>`', channelId);
      return;
    }
    const lead = bm.store.get(leadId);
    if (lead?.fleetRole !== 'lead') {
      await channel.send(`**${lead?.name ?? leadId}** is not a fleet lead.`, channelId);
      return;
    }
    const crew = bm.store.crewOf(leadId);
    const lines = [`👑 **${lead.name}** fleet (${crew.length}/${bm.maxCrew()})`, ''];
    if (crew.length === 0) {
      lines.push('(empty — `/bots add-crew` or tell the lead to bot_spawn)');
    }
    const stateIcons2: Record<string, string> = { idle: '⚪', queued: '🔵', running: '🟢', paused: '🟡', disabled: '⛔' };
    for (const c of crew) {
      const summary = bm.getStatusSummaries().find(s => s.id === c.id);
      const runs = bm.getJournal(c.id, 3);
      const lastRun = runs.length > 0 ? `last: ${runs[runs.length - 1].state}` : 'no runs yet';
      lines.push(`${stateIcons2[summary?.state ?? 'idle']} **${c.name}** (${c.id})${c.description ? ` — ${c.description}` : ''} · ${lastRun}`);
      for (const r of runs.slice(-2).reverse()) {
        lines.push(`   ↳ ${r.state === 'completed' ? '✅' : r.state === 'failed' ? '❌' : '⛔'} ${r.summary?.slice(0, 90) ?? r.runId}`);
      }
    }
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'add-crew') {
    // /bots add-crew <leadId> <id> "Name" "Description" ["persona"]
    const leadId = parts[1]?.toLowerCase();
    const rest = parts.slice(2).join(' ');
    const quoted = [...rest.matchAll(/"([^"]*)"/g)].map(m => m[1]);
    const id = quoted[0] ?? parts[2];
    if (!leadId || !id || !quoted[0]) {
      await channel.send('Usage: `/bots add-crew <leadId> <id> "Name" "Description" "persona (optional)"`', channelId);
      return;
    }
    if (!bm.store.exists(leadId) || bm.store.get(leadId)?.fleetRole !== 'lead') {
      await channel.send(`**${leadId}** is not a fleet lead.`, channelId);
      return;
    }
    try {
      let persona: string | undefined;
      if (quoted[2]) {
        (channel as any).sendHeartbeat?.('⏳ Building the crew persona (up to ~60s)…');
        const refined = await refinePersona(quoted[2], quoted[0], agent.providers.getDefault());
        (channel as any).clearHeartbeat?.();
        persona = refined ?? quoted[2];
      }
      const result = bm.addCrew(leadId, { id, name: quoted[0], description: quoted[1], persona });
      if (!result.ok) {
        await channel.send(`⚠ ${result.error}`, channelId);
        return;
      }
      await channel.send(`👑 Crew member **${quoted[0]}** (\`${result.manifest.id}\`) added to **${leadId}** — fail-closed defaults, comms linked to the lead${persona ? ', persona refined' : ''}.`, channelId);
    } catch (err: any) {
      await channel.send(`Failed: ${err?.message}`, channelId);
    }
    return;
  }

  if (action === 'remove-crew') {
    const leadId = parts[1]?.toLowerCase();
    const crewId = parts[2]?.toLowerCase();
    if (!leadId || !crewId) {
      await channel.send('Usage: `/bots remove-crew <leadId> <crewId>`', channelId);
      return;
    }
    const crew = bm.store.get(crewId);
    if (!crew || crew.parent !== leadId) {
      await channel.send(`**${crewId}** is not crew of **${leadId}**. See \`/bots crew ${leadId}\`.`, channelId);
      return;
    }
    if (typeof (channel as any).askToContinue === 'function') {
      const proceed = await (channel as any).askToContinue(`Retire crew member **${crew.name}** (${crewId})? Profile, sandbox, and queue are removed permanently.`);
      if (!proceed) {
        await channel.send('Retirement cancelled.', channelId);
        return;
      }
    }
    const result = await bm.removeCrew(leadId, crewId);
    await channel.send(result.ok ? `👑 Crew member **${crewId}** retired from **${leadId}**.` : `⚠ ${result.error}`, channelId);
    return;
  }

  if (action === 'outputs' || action === 'deliverables') {
    // /bots outputs [id] — what the bots delivered, and where it is on disk.
    const target = parts[1]?.toLowerCase();
    if (target && !bm.store.exists(target)) {
      await channel.send(`No bot "${target}". See \`/bots\` for the roster.`, channelId);
      return;
    }
    const items = bm.listDeliverables(target).slice(0, 30);
    const root = target ? bm.store.deliverablesDir(target) : bm.store.deliverablesRoot();
    if (items.length === 0) {
      await channel.send(`Nothing delivered yet. Results will appear in \`${tildify(root)}\` — a bot delivers with bot_deliver when a result is finished.`, channelId);
      return;
    }
    const lines = [`**Deliverables** — ${tildify(root)}`, ''];
    for (const d of items) {
      lines.push(`${d.final ? '📄' : '📝'} ${formatRelative(d.mtimeMs)} · **${d.botId}** · ${d.name} (${formatBytes(d.bytes)})`);
    }
    lines.push('', '📄 final · 📝 work in progress (under work/) · `/bots folder <id>` opens the folder');
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'cost' || action === 'usage') {
    // /bots cost [days] — where the tokens go, per bot and per fleet.
    const days = Math.max(1, Math.min(90, parseInt(parts[1] ?? '7', 10) || 7));
    const report = bm.costReport(days);
    if (report.bots.length === 0) {
      await channel.send('No bots configured.', channelId);
      return;
    }
    const k = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
    const lines = [`**Bot token spend** — today and the last ${days} days`, ''];
    if (report.fleetCap > 0) lines.push(`Fleet today: ${k(report.fleetToday)} / ${k(report.fleetCap)}${report.fleetPaused ? ' · ⛔ paused (cap reached)' : ''}`, '');
    for (const fleet of report.fleets) {
      const lead = report.bots.find(b => b.id === fleet.id)!;
      const members = report.bots.filter(b => b.parent === fleet.id);
      const row = (b: typeof lead, indent: string) => {
        const capNote = b.cap > 0 ? ` / ${k(b.cap)}${b.paused ? ' ⛔' : ''}` : ' (no cap)';
        const w = b.window;
        const empty = w.noOutcome > 0 ? ` · ⚠ ${w.noOutcome} empty` : '';
        return `${indent}**${b.name}** — today ${k(b.today.tokensIn + b.today.tokensOut)}${capNote} · ${days}d ${k(w.tokensIn + w.tokensOut)} in ${w.runs} runs (${w.failed} failed, ${w.deliverables} delivered${empty})`;
      };
      lines.push(row(lead, members.length ? '👑 ' : ''));
      for (const m of members) lines.push(row(m, '  └─ '));
      if (members.length) lines.push(`  fleet total: ${days}d ${k(fleet.window.tokensIn + fleet.window.tokensOut)} · ${fleet.window.deliverables} delivered`);
    }
    const total = report.bots.reduce((a, b) => a + b.window.tokensIn + b.window.tokensOut, 0);
    lines.push('', `All bots, ${days}d: ${k(total)} tokens. \`/bots budget <id>\` sets a cap; \`/bots show <id>\` opens a run.`);
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'show' || action === 'transcript') {
    // /bots show <id> [runId] — what a run actually did.
    const target = parts[1]?.toLowerCase();
    if (!target || !bm.store.exists(target)) {
      await channel.send('Usage: `/bots show <id> [runId]` — the tool trace and reply of a run (newest when no id).', channelId);
      return;
    }
    const t = bm.readTranscript(target, parts[2]);
    if (!t) {
      await channel.send(`No transcript${parts[2] ? ` for run ${parts[2]}` : ''} — transcripts exist for runs made after the governance update.`, channelId);
      return;
    }
    const r = t.record;
    const lines = [`**${target} · run ${r.runId}** — ${r.trigger} · ${r.state}${r.outcome ? ` · ${r.outcome}` : ''} · ${(r.tokensIn + r.tokensOut).toLocaleString()} tok · ${r.steps ?? '?'} steps${r.reasonCode ? ` · [${r.reasonCode}]` : ''}`, ''];
    if (t.prompt) lines.push(`**Task:** ${t.prompt.replace(/\s+/g, ' ').slice(0, 240)}`, '');
    if (t.trace.length > 0) {
      lines.push(`**Tools (${t.trace.length}):**`);
      for (const step of t.trace.slice(0, 25)) lines.push(`${step.ok ? '✓' : '✗'} ${step.name}${step.arg ? ` ${step.arg.slice(0, 70)}` : ''}`);
      if (t.trace.length > 25) lines.push(`…and ${t.trace.length - 25} more`);
      lines.push('');
    }
    for (const d of r.deliverables ?? []) lines.push(`📁 ${tildify(d)}`);
    if (r.claimedWithoutAction) lines.push('⚠ The reply claimed delivery or execution the trace does not show.');
    lines.push('', `**Reply:** ${t.output.slice(0, 1200)}${t.output.length > 1200 ? '…' : ''}`);
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'tasks') {
    // /bots tasks <leadId> — what a lead has delegated and what came back.
    const target = parts[1]?.toLowerCase();
    if (!target || !bm.store.exists(target)) {
      await channel.send('Usage: `/bots tasks <leadId>` — open and recent delegated tasks of a fleet lead.', channelId);
      return;
    }
    const tasks = bm.tasksFor(target);
    if (tasks.length === 0) {
      await channel.send(`**${target}** has not delegated any tasks yet.`, channelId);
      return;
    }
    const icons: Record<string, string> = { queued: '🔵', running: '🟢', done: '✅', failed: '❌', halted: '⏹', cancelled: '🚫' };
    const lines = [`**${target} — delegated tasks** (newest first)`, ''];
    for (const t of tasks) {
      const r = t.result;
      lines.push(`${icons[t.status] ?? '•'} ${t.id} → **${t.assignee}**${t.stage ? ` (${t.stage})` : ''} · ${t.status}${r?.outcome ? ` · ${r.outcome}` : ''} · ${formatRelative(t.completedAt ?? t.startedAt ?? t.createdAt)}`);
      lines.push(`   ${t.goal.slice(0, 100)}`);
      for (const d of r?.deliverables ?? []) lines.push(`   📁 ${tildify(d)}`);
    }
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'folder') {
    // /bots folder <id> — open the deliverables folder in Finder / Explorer / the file manager.
    const target = parts[1]?.toLowerCase();
    if (!target || !bm.store.exists(target)) {
      await channel.send('Usage: `/bots folder <id>` — opens the bot\'s deliverables folder.', channelId);
      return;
    }
    const dir = bm.store.deliverablesDir(target);
    mkdirSync(dir, { recursive: true });
    const opened = await openFolder(dir);
    await channel.send(opened ? `📁 Opened \`${tildify(dir)}\`` : `📁 ${tildify(dir)}\n(could not open a file manager here — copy the path)`, channelId);
    return;
  }

  if (action === 'storage') {
    const usage = bm.getStorage();
    if (usage.length === 0) {
      await channel.send('No bot storage in use.', channelId);
      return;
    }
    const lines = ['**Bot storage**', ''];
    let total = 0;
    for (const u of usage) {
      total += u.bytes;
      lines.push(`**${u.id}**: ${formatBytes(u.bytes)} (journal ${formatBytes(u.journalBytes)})`);
    }
    lines.push('', `Total: ${formatBytes(total)} — caps are enforced at write time (transcripts keep last 50 runs; journals rotate at 5 MB).`);
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  await channel.send(
    '**Bots commands**\n' +
    '`/bots` — roster with live states\n' +
    '`/bots open <id>` — open a bot chat (transcript swaps to the bot thread)\n' +
    '`/bots create <id> "Name" "Description"` — onboard a bot\n' +
    '`/bot <id> <message>` — message a bot from any channel\n' +
    '`/bots persona <id> <text>` — set/replace its character (with template conversion)\n' +
    '`/bots budget <id> <tokens|suggest|none>` — daily token budget (default 5M/day; none = unlimited)\n' +
    '`/bots outputs [id]` — what the bots delivered, and where\n' +
    '`/bots tasks <leadId>` — a lead\'s delegated tasks and their results\n' +
    '`/bots folder <id>` — open a bot\'s deliverables folder\n' +
    '`/bots edit <id> <field> <value>` — edit any config field anytime\n' +
    '`/bots journal <id>` — recent runs\n' +
    '`/bots inbox <id>` — pending bot-to-bot mail\n' +
    '`/bots dlq [clear [id]]` — dead-lettered jobs; clear drops them\n' +
    '`/bots cost [days]` — token spend per bot and fleet, against caps\n' +
    '`/bots show <id> [runId]` — what a run actually did (tools, deliverables, reply)\n' +
    '`/bots stop all` / `/bots start all` — fleet kill switch\n' +
    '`/bots replay <botId> <jobId>` — re-run a dead-lettered job\n' +
    '`/bots storage` — disk usage\n' +
    '`/bots enable|disable|stop|start <id>` — control (stop holds queued jobs; start resumes them)\n' +
    '`/bots run <id> [routineName]` — fire a routine now, or a bare wake turn\n' +
    '`/bots crew <leadId>` — fleet tree with per-crew runs\n' +
    '`/bots promote <id>` / demote — make a bot a fleet lead (it then self-organizes) / back to solo\n' +
    '`/bots permissions <id> [tier]` — capability tier: readonly | builder | operator | full\n' +
    '`/bots add-crew <leadId> <id> "Name" "Desc" ["persona"]` — add a sub-bot to a fleet\n' +
    '`/bots remove-crew <leadId> <crewId>` — retire a crew member\n' +
    '`/bots delete <id> confirm` — permanently delete',
    channelId,
  );
}

/** ~ for the home dir — paths shown to people, not to tools. */
function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Open a folder in the platform file manager; false when there is none (headless/SSH). */
async function openFolder(dir: string): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? ['open', [dir]]
    : process.platform === 'win32' ? ['explorer', [dir]]
      : ['xdg-open', [dir]];
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd[0] as string, cmd[1] as string[], { timeout: 5000 }, (err) => resolve(!err));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
