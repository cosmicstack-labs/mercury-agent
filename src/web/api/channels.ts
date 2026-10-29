import { Hono } from 'hono';
import {
  approveDiscordPendingRequest, approveSignalPendingRequest, approveSlackPendingRequest, approveTelegramPendingRequest,
  clearDiscordAccess, clearSignalAccess, clearSlackAccess, clearTelegramAccess,
  loadConfig, rejectDiscordPendingRequest, rejectSignalPendingRequest, rejectSlackPendingRequest, rejectTelegramPendingRequest,
  saveConfig, type MercuryConfig,
} from '../../utils/config.js';
import { checkDiscord, checkSignal, checkSlack, checkTelegram, signalAccounts, TOKEN_SHAPES, type ChannelCheck } from '../../channels/credential-check.js';
import type { ExternalChannel } from '../../channels/registry.js';
import { logger } from '../../utils/logger.js';
import { checkJavaAvailable, findSignalCli, isNativeBinary } from '../../signal/binary.js';

/**
 * Messaging channels (Telegram, Discord, Slack, Signal) from any client:
 * set up and change credentials (checked live first), turn on and off, and
 * manage who may talk to Mercury. WhatsApp is a plugin (/api/plugins).
 *
 *   GET  /api/channels                   every channel: settings (keys masked), running, people
 *   POST /api/channels/:type/check       test what's typed, nothing saved
 *   PUT  /api/channels/:type             save settings / on-off; the channel restarts by itself
 *   POST /api/channels/:type/access      { action: approve|reject|remove|promote|demote|reset, id?, role? }
 *   POST /api/channels/signal/link       link this computer to a Signal account (QR), then poll GET
 *
 * Changes go to the live config the running channels read, then to disk, so
 * a channel's own next save can never undo them; credentials and on/off
 * restart just that channel.
 */

export interface ChannelRuntime {
  /** The live config object the channels hold. */
  config(): MercuryConfig;
  restart(type: ExternalChannel): Promise<{ running: boolean; error?: string }>;
  running(type: ExternalChannel): boolean;
  /** Tell someone they were let in (best effort, through the running channel). */
  notify(type: ExternalChannel, target: string, text: string): Promise<void>;
}

let runtime: ChannelRuntime | null = null;
export function setChannelRuntime(r: ChannelRuntime | null): void { runtime = r; }

type Fetch = typeof fetch;
let doFetch: Fetch | undefined;
let signalProbe: () => { binary: string | null; javaOk: boolean; accounts: string[] } = defaultSignalProbe;
/** Test seams. */
export function setChannelTestHooks(h: { fetch?: Fetch; signal?: typeof signalProbe }): void {
  if (h.fetch !== undefined) doFetch = h.fetch;
  if (h.signal) signalProbe = h.signal;
}

/** Local only: never downloads signal-cli and never starts it (that would stop a running Signal). */
function defaultSignalProbe() {
  const binary = findSignalCli();
  // A native build runs on its own; the JAR (and its launcher) needs Java 17+.
  const javaOk = !!binary && (isNativeBinary(binary) || checkJavaAvailable());
  return { binary, javaOk, accounts: signalAccounts() };
}

const TYPES: ExternalChannel[] = ['telegram', 'discord', 'slack', 'signal'];
const LABEL: Record<ExternalChannel, string> = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', signal: 'Signal' };

function isType(t: string): t is ExternalChannel {
  return (TYPES as string[]).includes(t);
}

function live(): MercuryConfig {
  return runtime ? runtime.config() : loadConfig();
}

function persist(config: MercuryConfig): void {
  saveConfig(config);
}

function mask(v: string | undefined): string {
  if (!v) return '';
  return v.length < 10 ? '••••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

const masked = (v: unknown) => typeof v === 'string' && v.includes('•');

// ── People, in one shape for every channel ──────────────────────────────────

/** A person as each channel stores them (Telegram, Discord, Slack, Signal use different fields). */
interface ChannelUser {
  userId?: string | number; chatId?: string | number; phoneNumber?: string;
  name?: string; firstName?: string; username?: string; userName?: string; displayName?: string;
  approvedAt?: string; pairedAt?: string; pairingCode?: string; requestedAt?: string; role?: string;
}
type ChannelPeople = { admins: ChannelUser[]; members: ChannelUser[]; pending: ChannelUser[] };

interface Person { id: string; name: string; detail?: string; role: 'admin' | 'member'; since?: string }
interface Pending { id: string; name: string; detail?: string; code?: string; requestedAt?: string }

function people(type: ExternalChannel, c: MercuryConfig['channels']) {
  const ch = c[type] as unknown as ChannelPeople;
  const person = (u: ChannelUser, role: 'admin' | 'member'): Person => {
    const uid = String(u.userId ?? '');
    if (type === 'telegram') return { id: uid, name: u.firstName || (u.username ? `@${u.username}` : uid), detail: u.username ? `@${u.username}` : undefined, role, since: u.approvedAt };
    const phone = u.phoneNumber ?? '';
    if (type === 'signal') return { id: phone, name: u.name || phone, detail: u.name ? phone : undefined, role, since: u.pairedAt };
    if (type === 'slack') return { id: uid, name: u.displayName || u.userName || uid, detail: u.userName ? `@${u.userName}` : undefined, role, since: u.approvedAt };
    return { id: uid, name: u.displayName || u.username || uid, detail: u.username ? `@${u.username}` : undefined, role, since: u.approvedAt };
  };
  const pending = (u: ChannelUser): Pending => {
    const id = type === 'signal' ? (u.phoneNumber ?? '') : String(u.userId ?? '');
    const name = type === 'telegram' ? (u.firstName || (u.username ? `@${u.username}` : id)) : type === 'signal' ? (u.name || id) : (u.displayName || u.username || u.userName || id);
    return { id, name, detail: u.username ? `@${u.username}` : u.userName ? `@${u.userName}` : undefined, code: u.pairingCode, requestedAt: u.requestedAt };
  };
  return {
    admins: (ch.admins ?? []).map((u) => person(u, 'admin')),
    members: (ch.members ?? []).map((u) => person(u, 'member')),
    pending: (ch.pending ?? []).map(pending),
  };
}

function describe(type: ExternalChannel, config: MercuryConfig) {
  const c = config.channels;
  const settings: Record<string, unknown> =
    type === 'telegram' ? { botToken: mask(c.telegram.botToken), hasBotToken: !!c.telegram.botToken, streaming: c.telegram.streaming !== false }
    : type === 'discord' ? { botToken: mask(c.discord.botToken), hasBotToken: !!c.discord.botToken, guildId: c.discord.guildId ?? '', channelId: c.discord.channelId ?? '', adminRoleName: c.discord.adminRoleName ?? '', streaming: c.discord.streaming !== false }
    : type === 'slack' ? { botToken: mask(c.slack.botToken), hasBotToken: !!c.slack.botToken, appToken: mask(c.slack.appToken), hasAppToken: !!c.slack.appToken, channelId: c.slack.channelId ?? '', streaming: c.slack.streaming !== false }
    : { phoneNumber: c.signal.phoneNumber ?? '', mode: c.signal.mode || 'group', groupName: c.signal.groupName ?? '', groupId: c.signal.groupId ?? '' };
  const ch = c[type] as { enabled: boolean };
  const configured = type === 'telegram' ? !!c.telegram.botToken : type === 'discord' ? !!c.discord.botToken : type === 'slack' ? !!c.slack.botToken && !!c.slack.appToken : !!c.signal.phoneNumber;
  return {
    type,
    label: LABEL[type],
    enabled: ch.enabled,
    configured,
    running: runtime?.running(type) ?? false,
    settings,
    access: people(type, c),
  };
}

// ── Drafts and checks ───────────────────────────────────────────────────────

type Draft = Record<string, unknown>;

/** What the channel's credentials would be after this edit (an empty or omitted secret keeps the saved one). */
function merged(type: ExternalChannel, config: MercuryConfig, body: Draft): Record<string, string> {
  const c = config.channels;
  const keep = (v: unknown, saved: string | undefined) => (typeof v === 'string' && v.trim() && !masked(v) ? v.trim() : saved ?? '');
  const text = (v: unknown, saved: string | undefined) => (typeof v === 'string' ? v.trim() : saved ?? '');
  if (type === 'telegram') return { botToken: keep(body.botToken, c.telegram.botToken) };
  if (type === 'discord') return { botToken: keep(body.botToken, c.discord.botToken), guildId: text(body.guildId, c.discord.guildId), channelId: text(body.channelId, c.discord.channelId), adminRoleName: text(body.adminRoleName, c.discord.adminRoleName) };
  if (type === 'slack') return { botToken: keep(body.botToken, c.slack.botToken), appToken: keep(body.appToken, c.slack.appToken), channelId: text(body.channelId, c.slack.channelId) };
  return { phoneNumber: text(body.phoneNumber, c.signal.phoneNumber).replace(/[\s-]/g, ''), mode: text(body.mode, c.signal.mode || 'group'), groupName: text(body.groupName, c.signal.groupName) };
}

async function check(type: ExternalChannel, d: Record<string, string>): Promise<ChannelCheck> {
  if (type === 'telegram') return checkTelegram(d.botToken, doFetch);
  if (type === 'discord') return checkDiscord(d.botToken, d.guildId || undefined, d.channelId || undefined, doFetch);
  if (type === 'slack') return checkSlack(d.botToken, d.appToken, doFetch);
  return checkSignal(d.phoneNumber, signalProbe());
}

function maskedProblem(body: Draft): string | null {
  for (const k of ['botToken', 'appToken']) if (masked(body[k])) return k;
  return null;
}

// ── Routes ──────────────────────────────────────────────────────────────────

const channels = new Hono();

channels.get('/api/channels', (c) => {
  const config = live();
  return c.json({ channels: TYPES.map((t) => describe(t, config)), liveRestart: !!runtime });
});

channels.post('/api/channels/:type/check', async (c) => {
  const type = c.req.param('type');
  if (!isType(type)) return c.json({ ok: false, message: 'Unknown channel' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as Draft;
  const bad = maskedProblem(body);
  if (bad) return c.json({ ok: false, field: bad, message: 'That is the hidden form of the saved key. Paste the full key, or leave it empty to keep the saved one.' });
  return c.json(await check(type, merged(type, live(), body)));
});

channels.put('/api/channels/:type', async (c) => {
  const type = c.req.param('type');
  if (!isType(type)) return c.json({ error: 'Unknown channel' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as Draft;
  const bad = maskedProblem(body);
  if (bad) return c.json({ error: 'That is the hidden form of the saved key. Paste the full key, or leave it empty to keep the saved one.', field: bad }, 400);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be true or false' }, 400);
  if (type === 'signal' && body.mode !== undefined && body.mode !== 'group' && body.mode !== 'private') return c.json({ error: 'mode is group or private', field: 'mode' }, 400);

  const config = live();
  const ch = config.channels[type] as { enabled: boolean };
  const d = merged(type, config, body);
  const willRun = typeof body.enabled === 'boolean' ? body.enabled : ch.enabled;
  // Never turn on (or keep running) with credentials that don't work.
  let identity: string | undefined;
  if (willRun) {
    const r = await check(type, d);
    if (!r.ok) return c.json({ error: r.message, field: r.field }, 400);
    identity = r.identity;
  }

  const cc = config.channels;
  if (type === 'telegram') cc.telegram.botToken = d.botToken;
  if (type === 'discord') Object.assign(cc.discord, { botToken: d.botToken, guildId: d.guildId || undefined, channelId: d.channelId || undefined, adminRoleName: d.adminRoleName || undefined });
  if (type === 'slack') Object.assign(cc.slack, { botToken: d.botToken, appToken: d.appToken, channelId: d.channelId || undefined });
  if (type === 'signal') {
    if (cc.signal.phoneNumber && d.phoneNumber !== cc.signal.phoneNumber) { cc.signal.groupId = undefined; }
    Object.assign(cc.signal, { phoneNumber: d.phoneNumber, mode: d.mode, groupName: d.groupName || cc.signal.groupName });
  }
  if (typeof body.streaming === 'boolean' && type !== 'signal') (cc[type] as { streaming?: boolean }).streaming = body.streaming;
  if (typeof body.enabled === 'boolean') ch.enabled = body.enabled;
  persist(config);

  let state: { running: boolean; error?: string } = { running: false };
  if (runtime) {
    try { state = await runtime.restart(type); } catch (err) { state = { running: false, error: err instanceof Error ? err.message : String(err) }; }
  }
  return c.json({ ok: true, channel: describe(type, config), identity, ...state, restartRequired: !runtime });
});

channels.post('/api/channels/:type/access', async (c) => {
  const type = c.req.param('type');
  if (!isType(type)) return c.json({ error: 'Unknown channel' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { action?: unknown; id?: unknown; role?: unknown };
  const action = String(body.action ?? '');
  const id = typeof body.id === 'string' ? body.id.trim() : typeof body.id === 'number' ? String(body.id) : '';
  const config = live();
  const r = applyAccess(type, config, action, id, body.role === 'admin' ? 'admin' : body.role === 'member' ? 'member' : undefined);
  if (!r.ok) return c.json({ error: r.error }, r.status ?? 400);
  persist(config);
  if (r.welcome && runtime?.running(type)) {
    void runtime.notify(type, r.welcome.target, r.welcome.text).catch((err) => logger.warn({ channel: type, err: err instanceof Error ? err.message : String(err) }, 'Could not tell the approved person'));
  }
  return c.json({ ok: true, channel: describe(type, config) });
});

type AccessResult = { ok: true; welcome?: { target: string; text: string } } | { ok: false; error: string; status?: 400 | 404 | 409 };

/** One place for every channel's access rules: approve, reject, remove, promote, demote, reset. */
export function applyAccess(type: ExternalChannel, config: MercuryConfig, action: string, id: string, role?: 'admin' | 'member'): AccessResult {
  const ch = config.channels[type] as unknown as ChannelPeople;
  const keyOf = (u: ChannelUser) => String(type === 'signal' ? u.phoneNumber : u.userId);
  const find = (list: ChannelUser[]) => list.find((u) => keyOf(u) === id);
  if (action !== 'reset' && !id) return { ok: false, error: 'Who? (id is required)' };

  switch (action) {
    case 'approve': {
      const req = find(ch.pending);
      if (!req) return { ok: false, error: 'That request is no longer waiting (approved or turned down elsewhere).', status: 404 };
      // The first person in becomes the admin, so the channel always has one.
      const r = role ?? (ch.admins.length === 0 ? 'admin' : 'member');
      const approved = type === 'telegram' ? approveTelegramPendingRequest(config, Number(id), r)
        : type === 'discord' ? approveDiscordPendingRequest(config, id, r)
        : type === 'slack' ? approveSlackPendingRequest(config, id, r)
        : approveSignalPendingRequest(config, id, r);
      if (!approved) return { ok: false, error: 'Could not approve that request.', status: 409 };
      const target = type === 'telegram' ? String(req.chatId ?? req.userId) : id;
      return { ok: true, welcome: { target, text: r === 'admin' ? '✅ You\'re in, as an admin. Talk to Mercury here any time.' : '✅ You\'re in. Talk to Mercury here any time.' } };
    }
    case 'reject': {
      const done = type === 'telegram' ? rejectTelegramPendingRequest(config, Number(id))
        : type === 'discord' ? rejectDiscordPendingRequest(config, id)
        : type === 'slack' ? rejectSlackPendingRequest(config, id)
        : rejectSignalPendingRequest(config, id);
      return done ? { ok: true } : { ok: false, error: 'That request is no longer waiting.', status: 404 };
    }
    case 'remove': {
      const admin = find(ch.admins);
      if (admin && ch.admins.length <= 1) return { ok: false, error: 'That\'s the only admin. Make someone else admin first, or reset access.', status: 409 };
      if (!admin && !find(ch.members)) return { ok: false, error: 'No such person.', status: 404 };
      ch.admins = ch.admins.filter((u) => keyOf(u) !== id);
      ch.members = ch.members.filter((u) => keyOf(u) !== id);
      return { ok: true };
    }
    case 'promote': {
      const m = find(ch.members);
      if (!m) return { ok: false, error: 'Only members can be made admin.', status: 404 };
      ch.members = ch.members.filter((u) => keyOf(u) !== id);
      ch.admins.push('role' in m ? { ...m, role: 'admin' } : m);
      return { ok: true };
    }
    case 'demote': {
      const a = find(ch.admins);
      if (!a) return { ok: false, error: 'Only admins can be made members.', status: 404 };
      if (ch.admins.length <= 1) return { ok: false, error: 'The channel needs at least one admin.', status: 409 };
      ch.admins = ch.admins.filter((u) => keyOf(u) !== id);
      ch.members.push('role' in a ? { ...a, role: 'member' } : a);
      return { ok: true };
    }
    case 'reset': {
      if (type === 'telegram') clearTelegramAccess(config);
      else if (type === 'discord') clearDiscordAccess(config);
      else if (type === 'slack') clearSlackAccess(config);
      else clearSignalAccess(config);
      return { ok: true };
    }
    default:
      return { ok: false, error: 'action must be approve, reject, remove, promote, demote or reset' };
  }
}

// ── Signal: link this computer as a device of the owner's Signal account ────

interface LinkState { status: 'starting' | 'waiting' | 'linked' | 'failed'; uri?: string; qrImage?: string; phoneNumber?: string; error?: string; startedAt: number }
let link: LinkState | null = null;

channels.post('/api/channels/signal/link', async (c) => {
  if (link && (link.status === 'starting' || link.status === 'waiting') && Date.now() - link.startedAt < 120_000) return c.json(link);
  link = { status: 'starting', startedAt: Date.now() };
  const current = link;
  try {
    const { ensureSignalCli } = await import('../../signal/binary.js');
    const { startLinking, waitForLinkCompletion } = await import('../../signal/setup.js');
    const { qrSvg } = await import('../../plugins/qr-svg.js');
    // signal-cli runs one process per account; the running channel stops while linking.
    const config = live();
    if (runtime?.running('signal')) { config.channels.signal.enabled = false; await runtime.restart('signal'); config.channels.signal.enabled = true; }
    const binary = await ensureSignalCli();
    const before = new Set(signalAccounts());
    const session = await startLinking(binary);
    if (!session) throw new Error('signal-cli couldn\'t start linking. Is Java 17+ installed?');
    current.status = 'waiting';
    current.uri = session.uri;
    current.qrImage = `data:image/svg+xml;base64,${Buffer.from(qrSvg(session.uri)).toString('base64')}`;
    void waitForLinkCompletion(session, 120_000).then(async (ok) => {
      if (!ok) { current.status = 'failed'; current.error = 'The code wasn\'t scanned in 2 minutes. Try again.'; return; }
      const added = signalAccounts().find((n) => !before.has(n)) ?? signalAccounts()[0];
      const cfg = live();
      if (added) cfg.channels.signal.phoneNumber = added;
      cfg.channels.signal.enabled = true;
      persist(cfg);
      current.status = 'linked';
      current.phoneNumber = added;
      if (runtime) await runtime.restart('signal').catch(() => {});
    });
    return c.json(current);
  } catch (err) {
    current.status = 'failed';
    current.error = err instanceof Error ? err.message : String(err);
    return c.json(current, 502);
  }
});

channels.get('/api/channels/signal/link', (c) => c.json(link ?? { status: 'none' }));

export { TOKEN_SHAPES };
export default channels;
