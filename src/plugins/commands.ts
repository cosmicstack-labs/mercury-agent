/**
 * `/plugins` in chat (terminal, Telegram, web, Discord, Slack) and dispatch
 * of slash commands that plugins contribute.
 *
 *   /plugins                         everything: installed + catalog, with status
 *   /plugins search <text>
 *   /plugins info <id>
 *   /plugins install <id|path|url|github:owner/repo> [--yes]
 *   /plugins enable <id>             /plugins disable <id>
 *   /plugins update [id|all]         /plugins rollback <id>
 *   /plugins uninstall <id> [--purge] [--yes]
 *   /plugins set <id> <key> <value>
 *
 * Install and uninstall always preview first (what the plugin needs, what
 * will be removed) and act only with --yes; on Telegram that's one tap.
 * Members (non-admins on role-aware channels) can only list and read.
 */
import type { ChannelMessage } from '../types/channel.js';
import { getPluginManager } from './manager.js';
import { getPluginService } from './service.js';
import { getCatalog } from './catalog.js';
import { getPluginCommand, listPluginCommands } from './tool-bridge.js';
import { RESERVED_COMMANDS, type PluginListItem } from './types.js';
import { PluginDialog, renderPrompt } from './dialog.js';

export { RESERVED_COMMANDS };

interface ChannelLike {
  send(content: string, targetId?: string): Promise<void>;
  sendWithActions?(content: string, rows: Array<Array<{ label: string; command: string }>>, targetId?: string): Promise<void>;
  type?: string;
}

const STATUS_ICON: Record<PluginListItem['status'], string> = {
  enabled: '✅', disabled: '⏸', 'update-available': '⬆️', available: '○', incompatible: '🚫', installed: '•', error: '⚠️',
};

function mb(bytes?: number): string {
  if (!bytes) return '';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function statusBits(i: PluginListItem): string {
  const bits: string[] = [];
  if (i.status === 'enabled') bits.push('enabled');
  else if (i.status === 'disabled') bits.push(i.disabled?.code === 'user' || !i.disabled ? 'disabled' : `disabled: ${i.disabled.message}`);
  else if (i.status === 'update-available') bits.push('update available');
  else if (i.status === 'error') bits.push(`not running${i.lastError ? `: ${i.lastError}` : ''}`);
  else if (i.status === 'incompatible') bits.push(`incompatible: ${i.incompatibleReason ?? ''}`);
  else bits.push('available');
  bits.push(i.tier);
  if (i.kind === 'out-of-process') bits.push('own process');
  const size = mb(i.sizeBytes);
  if (size) bits.push(size);
  if (i.tools.length) bits.push(`${i.tools.length} tool${i.tools.length === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

function version(i: PluginListItem): string {
  return i.installedVersion
    ? (i.status === 'update-available' ? `${i.installedVersion} → ${i.latestVersion}` : i.installedVersion)
    : i.latestVersion ?? '';
}

function line(i: PluginListItem): string {
  return `${STATUS_ICON[i.status]} ${i.name} ${version(i)} (${i.id}): ${statusBits(i)}`.replace(/\s+/g, ' ').trim();
}

function describe(i: PluginListItem): string {
  const lines = [
    `🧩 ${i.name} (${i.id})`,
    i.description,
    '',
    `Version: ${version(i)}`,
    `Status: ${statusBits(i)}`,
    `Runs: ${i.kind === 'out-of-process' ? 'in its own process (crashes can’t affect Mercury)' : 'inside Mercury'}`,
    `Source: ${i.tier === 'local' ? 'installed from a path or URL (unverified)' : `${i.tier} catalog${i.verified ? ', checksum verified' : ''}`}`,
  ];
  if (i.tools.length) lines.push(`Tools: ${i.tools.join(', ')}`);
  if (i.commands.length) lines.push(`Commands: ${i.commands.join(', ')}`);
  if (i.channel) lines.push(`Channel: ${i.channel.type}${i.channel.state ? ` · ${i.channel.state}` : ''}${i.channel.account ? ` · ${i.channel.account}` : ''}${i.channel.detail ? ` (${i.channel.detail})` : ''}`);
  const p = i.permissions;
  lines.push(`Network: ${p?.network.length ? p.network.join(', ') : 'none'}`);
  lines.push(`Secrets it can read: ${p?.secrets.length ? p.secrets.join(', ') : 'none'}`);
  if (p?.desktop) lines.push('⚠️ Controls this computer: it can see your screen, move the mouse and type, in any app.');
  for (const m of i.missing ?? []) lines.push(`⚠️ ${m.unlocks} is off: needs ${m.needs}. ${m.fix}`);
  const providers = Object.keys(i.permissions?.providers ?? {});
  if (providers.length) lines.push(`Uses your Mercury providers: ${providers.join(', ')}`);
  if (i.lastError && i.status !== 'enabled') lines.push(`Last error: ${i.lastError}`);
  return lines.join('\n');
}

function actionsFor(i: PluginListItem): Array<{ label: string; command: string }> {
  const short = i.name.slice(0, 18);
  if (i.status === 'available') return [{ label: `⬇ Install ${short}`, command: `/plugins install ${i.id}` }, { label: 'ℹ Info', command: `/plugins info ${i.id}` }];
  if (i.status === 'incompatible' && !i.installedVersion) return [{ label: `ℹ ${short}`, command: `/plugins info ${i.id}` }];
  const row: Array<{ label: string; command: string }> = [];
  if (i.status === 'update-available') row.push({ label: `⬆ Update ${short}`, command: `/plugins update ${i.id}` });
  if (i.enabled) row.push({ label: `⏸ Disable ${i.status === 'update-available' ? '' : short}`.trim(), command: `/plugins disable ${i.id}` });
  else row.push({ label: `▶ Enable ${short}`, command: `/plugins enable ${i.id}` });
  row.push({ label: '🗑 Uninstall', command: `/plugins uninstall ${i.id}` });
  return row;
}

const HELP = [
  'Usage:',
  '  /plugins                         list installed and available plugins',
  '  /plugins <id>                    that plugin\'s menu: settings, link, turn off, uninstall',
  '  /plugins setup <id>              walk through its setup again',
  '  /plugins search <text>           find plugins',
  '  /plugins info <id>               details, tools and permissions',
  '  /plugins install <id|path|url>   install (asks to confirm)',
  '  /plugins enable|disable <id>',
  '  /plugins update [id|all]',
  '  /plugins rollback <id>           go back to the previous version',
  '  /plugins uninstall <id> [--purge]  remove (keeps data unless --purge)',
  '  /plugins set <id> <key> <value>  change a plugin setting',
  '  /plugins pair <id> <phone>       link a channel plugin\'s account (pairing code)',
  '  /plugins unlink <id>             log a channel plugin out',
].join('\n');

function isMember(msg: ChannelMessage): boolean {
  return msg.senderRole === 'member';
}

// ── guided dialogs (setup, /plugins <id> menu) ───────────────────────────

const DIALOG_TTL_MS = 15 * 60_000;
const dialogs = new Map<string, { dialog: PluginDialog; at: number }>();

function hasButtons(channel: ChannelLike): boolean {
  return typeof channel.sendWithActions === 'function' && channel.type === 'telegram';
}

/** A dialog is waiting for an answer in this chat. */
export function hasPluginDialog(chatId: string): boolean {
  const d = dialogs.get(chatId);
  if (d && Date.now() - d.at > DIALOG_TTL_MS) dialogs.delete(chatId);
  return dialogs.has(chatId);
}

async function showDialog(dialog: PluginDialog, msg: ChannelMessage, channel: ChannelLike, lead?: string): Promise<void> {
  const to = msg.channelId;
  const prompt = await dialog.current();
  if (!prompt) {
    dialogs.delete(to);
    if (lead) await channel.send(lead, to);
    return;
  }
  dialogs.set(to, { dialog, at: Date.now() });
  const text = [lead, renderPrompt(prompt, hasButtons(channel))].filter(Boolean).join('\n\n');
  if (hasButtons(channel) && prompt.options?.length) {
    const rows = prompt.options.map((o, i) => [{ label: o.label.slice(0, 40), command: `/plugins pick ${i + 1}` }]);
    await channel.sendWithActions!(text, rows, to);
  } else {
    await channel.send(text, to);
  }
}

/** Answer the dialog open in this chat (a number, an option's words, or free text). */
export async function answerPluginDialog(text: string, msg: ChannelMessage, channel: ChannelLike): Promise<void> {
  const entry = dialogs.get(msg.channelId);
  if (!entry) return;
  try {
    const r = await entry.dialog.answer(text);
    if (r.finished) {
      dialogs.delete(msg.channelId);
      if (r.message) await channel.send(r.message, msg.channelId);
      return;
    }
    await showDialog(entry.dialog, msg, channel, r.message);
  } catch (err) {
    await channel.send(`✗ ${(err as Error).message}`, msg.channelId);
  }
}

async function openDialog(dialog: PluginDialog | null, msg: ChannelMessage, channel: ChannelLike, fallback: string, lead?: string): Promise<void> {
  if (!dialog) {
    await channel.send([lead, fallback].filter(Boolean).join('\n\n'), msg.channelId);
    return;
  }
  await showDialog(dialog, msg, channel, lead);
}

const SUBCOMMANDS = new Set(['list', 'ls', 'help', 'search', 'info', 'install', 'add', 'enable', 'disable', 'update', 'upgrade', 'rollback', 'uninstall', 'remove', 'set', 'pair', 'unlink', 'setup', 'pick', 'cancel', 'test']);

export async function handlePluginsCommand(trimmed: string, msg: ChannelMessage, channel: ChannelLike): Promise<void> {
  const to = msg.channelId;
  const reply = (text: string) => channel.send(text, to);
  const tokens = trimmed.replace(/^\/plugins?\b/, '').trim().split(/\s+/).filter(Boolean);
  const yes = tokens.includes('--yes') || tokens.includes('-y');
  const purge = tokens.includes('--purge');
  const args = tokens.filter((t) => !t.startsWith('--') && t !== '-y');
  let [sub = 'list', target, ...rest] = args;
  const mgr = getPluginService();
  // `/plugins whatsapp` opens that plugin's menu.
  if (sub && !SUBCOMMANDS.has(sub)) {
    rest = [];
    target = sub;
    sub = 'menu';
  }
  const mutating = ['install', 'enable', 'disable', 'update', 'rollback', 'uninstall', 'remove', 'set', 'pair', 'unlink', 'setup', 'test'].includes(sub);
  if (mutating && isMember(msg)) {
    await reply('Only the owner or an admin can change plugins.');
    return;
  }

  try {
    switch (sub) {
      case 'list':
      case 'ls': {
        const { items, catalogError, stale, safeMode } = await mgr.list();
        const installed = items.filter((i) => i.installedVersion);
        const available = items.filter((i) => !i.installedVersion);
        const lines = [`🧩 Plugins · ${installed.length} installed, ${installed.filter((i) => i.status === 'enabled').length} enabled · ${available.length} in the catalog`];
        if (safeMode) lines.push('🛟 Safe mode: plugins are off for this run (restart without --safe-mode).');
        if (installed.length) lines.push('', 'Installed', ...installed.map(line));
        if (available.length) lines.push('', 'Available', ...available.slice(0, 25).map(line));
        if (!installed.length && !available.length) lines.push('', 'Nothing installed yet, and the catalog is empty or unreachable.');
        if (catalogError) lines.push('', `Catalog ${stale ? 'offline (showing the last copy)' : 'unavailable'}: ${catalogError}`);
        lines.push('', 'Tip: /plugins info <id> · /plugins install <id> · /plugins help');
        if (typeof channel.sendWithActions === 'function' && channel.type !== 'cli' && !isMember(msg)) {
          const rows = [...installed, ...available].slice(0, 10).map(actionsFor);
          await channel.sendWithActions(lines.join('\n'), rows, to);
        } else {
          await reply(lines.join('\n'));
        }
        return;
      }
      case 'help':
        await reply(HELP);
        return;
      case 'menu': {
        const d = await PluginDialog.menu(mgr, target!, !isMember(msg));
        await openDialog(d, msg, channel, `No plugin called "${target}". Try /plugins.`);
        return;
      }
      case 'setup': {
        if (!target) { await reply('Usage: /plugins setup <id>'); return; }
        await openDialog(await PluginDialog.setup(mgr, target), msg, channel, `"${target}" has nothing to set up (or isn't installed).`);
        return;
      }
      case 'pick':
        if (!hasPluginDialog(msg.channelId)) { await reply('That menu has expired. Open it again with /plugins <id>.'); return; }
        await answerPluginDialog(target ?? '', msg, channel);
        return;
      case 'cancel':
        if (hasPluginDialog(msg.channelId)) await answerPluginDialog('cancel', msg, channel);
        return;
      case 'test':
        if (!target) { await reply('Usage: /plugins test <id>'); return; }
        await reply(`✅ ${await mgr.testChannel(target)}`);
        return;
      case 'search': {
        const q = [target, ...rest].join(' ').toLowerCase();
        if (!q) { await reply('Usage: /plugins search <text>'); return; }
        const { items } = await mgr.list();
        const hits = items.filter((i) => `${i.id} ${i.name} ${i.description}`.toLowerCase().includes(q));
        await reply(hits.length ? hits.map(line).join('\n') : `No plugins match "${q}".`);
        return;
      }
      case 'info': {
        if (!target) { await reply('Usage: /plugins info <id>'); return; }
        const i = await mgr.info(target);
        if (!i) { await reply(`No plugin called "${target}". Try /plugins.`); return; }
        if (typeof channel.sendWithActions === 'function' && channel.type !== 'cli' && !isMember(msg)) await channel.sendWithActions(describe(i), [actionsFor(i)], to);
        else await reply(describe(i));
        return;
      }
      case 'install':
      case 'add': {
        if (!target) { await reply('Usage: /plugins install <id | folder | file.tgz | https URL | github:owner/repo>'); return; }
        if (!yes) {
          await reply(await installPreview(target));
          if (typeof channel.sendWithActions === 'function' && channel.type !== 'cli') {
            await channel.sendWithActions('Install it?', [[{ label: '✅ Install', command: `/plugins install ${target} --yes` }, { label: '✖ Cancel', command: '/plugins' }]], to);
          } else {
            await reply(`To install, run: /plugins install ${target} --yes`);
          }
          return;
        }
        await reply(`⬇ Installing ${target}…`);
        const r = await mgr.install(target);
        const info = await mgr.info(r.id);
        const verifiedNote = r.verified ? 'checksum verified' : (r.tier === 'local' ? 'unverified source' : 'not verified');
        const done = r.unchanged
          ? `${r.name} ${r.version} is already installed${info?.enabled ? ' and enabled' : ''}.`
          : `✅ Installed ${r.name} ${r.version} (${verifiedNote})${info?.status === 'enabled' ? ' and enabled' : ''}.${info?.tools.length ? `\nTools: ${info.tools.join(', ')}` : ''}${r.previousVersion ? `\nPrevious version ${r.previousVersion} kept for /plugins rollback ${r.id}.` : ''}`;
        // Walk the owner through the plugin's setup right away (CLI runs its own interactive setup).
        const setup = channel.type === 'cli-batch' || r.unchanged ? null : await PluginDialog.setup(mgr, r.id);
        if (setup) await showDialog(setup, msg, channel, done);
        else await reply(done);
        return;
      }
      case 'enable':
        if (!target) { await reply('Usage: /plugins enable <id>'); return; }
        await mgr.enable(target);
        await reply(`▶ Enabled ${target}.`);
        return;
      case 'disable':
        if (!target) { await reply('Usage: /plugins disable <id>'); return; }
        await mgr.disable(target);
        await reply(`⏸ Disabled ${target}. Its data and settings are kept; /plugins enable ${target} turns it back on.`);
        return;
      case 'update':
      case 'upgrade': {
        const id = target && target !== 'all' ? target : undefined;
        const changed = await mgr.update(id);
        await reply(changed.length ? changed.map((c) => `⬆ ${c.id}: ${c.from} → ${c.to}`).join('\n') : (id ? `${id} is up to date.` : 'All catalog plugins are up to date.'));
        return;
      }
      case 'rollback': {
        if (!target) { await reply('Usage: /plugins rollback <id>'); return; }
        const r = await mgr.rollback(target);
        await reply(`↩ ${target}: ${r.from} → ${r.to}`);
        return;
      }
      case 'uninstall':
      case 'remove': {
        if (!target) { await reply('Usage: /plugins uninstall <id> [--purge]'); return; }
        const i = await mgr.info(target);
        if (!i?.installedVersion) { await reply(`"${target}" is not installed.`); return; }
        if (!yes) {
          const what = purge ? 'its code, data and settings' : 'its code (data and settings are kept; add --purge to delete them too)';
          if (typeof channel.sendWithActions === 'function' && channel.type !== 'cli') {
            await channel.sendWithActions(`Uninstall ${i.name}? This removes ${what}.`, [[
              { label: '🗑 Uninstall', command: `/plugins uninstall ${target} --yes` },
              { label: '🗑 + delete data', command: `/plugins uninstall ${target} --purge --yes` },
              { label: '✖ Cancel', command: '/plugins' },
            ]], to);
          } else {
            await reply(`Uninstalling ${i.name} removes ${what}.\nTo confirm, run: /plugins uninstall ${target}${purge ? ' --purge' : ''} --yes`);
          }
          return;
        }
        await mgr.uninstall(target, purge);
        await reply(`🗑 Uninstalled ${i.name}${purge ? ' and deleted its data' : ' (data kept)'}.`);
        return;
      }
      case 'set': {
        const [key, ...valueParts] = rest;
        if (!target || !key || !valueParts.length) { await reply('Usage: /plugins set <id> <key> <value>'); return; }
        await mgr.setSetting(target, key, valueParts.join(' '));
        await reply(`⚙ ${target}.${key} updated.`);
        return;
      }
      case 'pair': {
        if (!target) { await reply('Usage: /plugins pair <id> <phone number of the account to link>'); return; }
        const phone = rest.join('');
        if (!phone) {
          await reply(`In chat, pairing uses a code: /plugins pair ${target} <phone number of the spare account>.\nFor a QR code, run \`mercury plugins pair ${target}\` in a terminal or use the dashboard.`);
          return;
        }
        const st = await mgr.pair(target, { method: 'code', phone });
        if (st.state === 'connected') { await reply(`✅ Already linked${st.account ? ` as ${st.account}` : ''}.`); return; }
        await reply(st.pairCode
          ? `🔗 Pairing code: *${st.pairCode}*\nOn the phone with that number: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, then type the code.\n⚠️ Unofficial protocol: use a spare number, not your main one.`
          : `Couldn't get a pairing code${st.detail ? `: ${st.detail}` : ''}.`);
        return;
      }
      case 'unlink': {
        if (!target) { await reply('Usage: /plugins unlink <id>'); return; }
        await mgr.unlink(target);
        await reply(`🔌 ${target} unlinked.`);
        return;
      }
      default:
        await reply(`Unknown /plugins command "${sub}".\n\n${HELP}`);
    }
  } catch (err) {
    await reply(`✗ ${(err as Error).message}`);
  }
}

async function installPreview(target: string): Promise<string> {
  const { entries } = await getCatalog();
  const entry = entries.find((e) => e.id === target);
  if (entry) {
    const art = entry.artifact ?? Object.values(entry.artifacts ?? {})[0];
    return [
      `🧩 ${entry.name} ${entry.version} (${entry.id}) · ${entry.tier}`,
      entry.description,
      '',
      `Runs: ${entry.kind === 'out-of-process' ? 'in its own process' : 'inside Mercury'}`,
      `Download: ${mb(art?.size) || 'unknown size'}, checksum-verified`,
      `Tools: ${entry.tools.length ? entry.tools.join(', ') : 'none listed'}`,
      `Network: ${entry.permissions.network.length ? entry.permissions.network.join(', ') : 'none'}`,
      `Secrets it can read: ${entry.permissions.secrets.length ? entry.permissions.secrets.join(', ') : 'none'}`,
    ].join('\n');
  }
  return [
    `⚠️ "${target}" is not from the catalog, so its contents aren't verified by Mercury.`,
    'Only install plugins from sources you trust: an in-process plugin runs inside Mercury with your permissions.',
    'After install, /plugins info <id> shows its tools, network access and the secrets it can read.',
  ].join('\n');
}

/** Run `/<name> args` if a plugin registered that command. Returns false if none did. */
export function tryPluginCommand(trimmed: string, msg: ChannelMessage, channel: ChannelLike): boolean {
  const m = /^\/([a-z][a-z0-9_]{0,29})(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m || RESERVED_COMMANDS.has(m[1])) return false;
  const cmd = getPluginCommand(m[1]);
  if (!cmd) return false;
  const to = msg.channelId;
  if (isMember(msg)) {
    void channel.send('Only the owner or an admin can run plugin commands.', to).catch(() => {});
    return true;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), 120_000);
  void cmd.run((m[2] ?? '').trim(), { reply: (text) => channel.send(String(text).slice(0, 8000), to), signal: ac.signal })
    .catch((err) => {
      getPluginManager().recordFailure(cmd.pluginId, `/${cmd.name}: ${(err as Error).message}`);
      return channel.send(`✗ /${cmd.name} (${cmd.pluginName}) failed: ${(err as Error).message}`, to);
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
  return true;
}

export function pluginCommandHelp(): string[] {
  return listPluginCommands().filter((c) => !RESERVED_COMMANDS.has(c.name)).map((c) => `/${c.name}: ${c.description} (${c.pluginName})`);
}
