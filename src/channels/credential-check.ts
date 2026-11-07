/**
 * Check a messaging channel's credentials before they're saved: one cheap,
 * read-only call per service, with what was found (the bot's name, the
 * workspace) or which field is wrong. Signal is checked locally only: its
 * own tools stop a running Signal, so nothing here touches signal-cli.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Fetch = typeof fetch;

export interface ChannelCheck {
  ok: boolean;
  /** What the credentials belong to, e.g. "@mercury_bot" or "Cosmic Stack (Slack)". */
  identity?: string;
  message: string;
  field?: string;
}

/** A vendor's JSON answer: read field by field, nothing assumed. */
type VendorJson = Record<string, unknown> | null;

async function getJson(f: Fetch, url: string, init: RequestInit = {}): Promise<{ status: number; body: VendorJson }> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(10_000) });
  let body: VendorJson = null;
  try { body = (await res.json()) as VendorJson; } catch { /* not JSON */ }
  return { status: res.status, body };
}

function offline(service: string, err: unknown): ChannelCheck {
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, message: /timeout|abort/i.test(msg) ? `${service} didn't answer in 10 seconds. Check your connection.` : `Couldn't reach ${service}: ${msg}` };
}

export const TOKEN_SHAPES = {
  telegram: /^\d{5,}:[A-Za-z0-9_-]{30,}$/,
  discord: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/,
  slackBot: /^xoxb-[A-Za-z0-9-]{20,}$/,
  slackApp: /^xapp-[A-Za-z0-9-]{20,}$/,
  phone: /^\+[1-9]\d{6,14}$/,
};

export async function checkTelegram(token: string, f: Fetch = fetch): Promise<ChannelCheck> {
  if (!TOKEN_SHAPES.telegram.test(token)) return { ok: false, field: 'botToken', message: 'That doesn\'t look like a Telegram bot token (it looks like 123456789:AAE…). Copy it again from @BotFather.' };
  try {
    const r = await getJson(f, `https://api.telegram.org/bot${token}/getMe`);
    if (r.status === 401 || r.status === 404) return { ok: false, field: 'botToken', message: 'Telegram rejected this token. Get the current one from @BotFather (/token).' };
    if (!r.body?.ok) return { ok: false, message: `Telegram answered ${r.status}${r.body?.description ? `: ${r.body.description}` : ''}.` };
    const u = r.body.result as { username?: string; first_name?: string };
    return { ok: true, identity: u.username ? `@${u.username}` : u.first_name, message: `Connected to ${u.username ? `@${u.username}` : 'your bot'}.` };
  } catch (err) { return offline('Telegram', err); }
}

export async function checkDiscord(token: string, guildId: string | undefined, channelId: string | undefined, f: Fetch = fetch): Promise<ChannelCheck> {
  if (!TOKEN_SHAPES.discord.test(token)) return { ok: false, field: 'botToken', message: 'That doesn\'t look like a Discord bot token. Copy it from the Developer Portal → your app → Bot → Reset Token.' };
  const auth = { headers: { Authorization: `Bot ${token}` } };
  try {
    const me = await getJson(f, 'https://discord.com/api/v10/users/@me', auth);
    if (me.status === 401) return { ok: false, field: 'botToken', message: 'Discord rejected this token. Reset it in the Developer Portal and paste the new one.' };
    if (me.status !== 200) return { ok: false, message: `Discord answered ${me.status}.` };
    const name = me.body?.username as string | undefined;
    if (guildId) {
      const g = await getJson(f, `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`, auth);
      if (g.status === 403 || g.status === 404) return { ok: false, field: 'guildId', message: `${name ?? 'The bot'} isn't in that server. Invite it with the OAuth2 URL from the Developer Portal, or check the server ID.` };
      if (channelId) {
        const ch = await getJson(f, `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, auth);
        if (ch.status === 403 || ch.status === 404) return { ok: false, field: 'channelId', message: 'The bot can\'t see that channel. Check the channel ID and the bot\'s permissions there.' };
      }
      return { ok: true, identity: name, message: `Connected as ${name ?? 'your bot'} in ${g.body?.name ?? 'the server'}.` };
    }
    return { ok: true, identity: name, message: `Connected as ${name ?? 'your bot'}.` };
  } catch (err) { return offline('Discord', err); }
}

export async function checkSlack(botToken: string, appToken: string, f: Fetch = fetch): Promise<ChannelCheck> {
  if (!TOKEN_SHAPES.slackBot.test(botToken)) return { ok: false, field: 'botToken', message: 'The bot token starts with xoxb-. Find it under OAuth & Permissions in your Slack app.' };
  if (!TOKEN_SHAPES.slackApp.test(appToken)) return { ok: false, field: 'appToken', message: 'The app-level token starts with xapp-. Create one under Basic Information → App-Level Tokens with connections:write.' };
  try {
    const bot = await getJson(f, 'https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${botToken}` } });
    if (!bot.body?.ok) return { ok: false, field: 'botToken', message: bot.body?.error === 'invalid_auth' || bot.body?.error === 'not_authed' ? 'Slack rejected the bot token.' : `Slack: ${bot.body?.error ?? bot.status}.` };
    const app = await getJson(f, 'https://slack.com/api/apps.connections.open', { method: 'POST', headers: { Authorization: `Bearer ${appToken}` } });
    if (!app.body?.ok) {
      const why = app.body?.error === 'invalid_auth' ? 'Slack rejected the app-level token.'
        : app.body?.error === 'missing_scope' ? 'The app-level token needs the connections:write scope.'
        : app.body?.error === 'not_allowed_token_type' ? 'That\'s not an app-level token (it should start with xapp-).'
        : `Slack: ${app.body?.error ?? app.status}. Is Socket Mode on for the app?`;
      return { ok: false, field: 'appToken', message: why };
    }
    const who = `${bot.body.user ? `@${bot.body.user}` : 'the bot'} in ${bot.body.team ?? 'your workspace'}`;
    return { ok: true, identity: who, message: `Connected as ${who}.` };
  } catch (err) { return offline('Slack', err); }
}

/** Numbers signal-cli has an account for (linked or registered on this computer). */
export function signalAccounts(dataDir = process.env.SIGNAL_CLI_CONFIG_DIR || join(homedir(), '.local', 'share', 'signal-cli')): string[] {
  const p = join(dataDir, 'data', 'accounts.json');
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { accounts?: Array<{ number?: string }> };
    return (parsed.accounts ?? []).map((a) => a.number).filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

export function checkSignal(phone: string, opts: { binary: string | null; javaOk: boolean; accounts: string[] }): ChannelCheck {
  if (!TOKEN_SHAPES.phone.test(phone)) return { ok: false, field: 'phoneNumber', message: 'Use the full number with country code, like +923001234567.' };
  if (!opts.binary) return { ok: false, message: 'Signal\'s helper program (signal-cli) isn\'t installed yet. Use "Link a device" to set it up.' };
  if (!opts.javaOk) return { ok: false, message: 'signal-cli needs Java 17 or newer on this computer. Install it (e.g. `brew install openjdk@17`), then check again.' };
  if (!opts.accounts.includes(phone)) return { ok: false, field: 'phoneNumber', message: 'This number isn\'t linked on this computer yet. Use "Link a device" and scan the code with Signal on your phone.' };
  return { ok: true, identity: phone, message: `${phone} is linked on this computer.` };
}
