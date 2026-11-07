import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ENABLED', 'DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SIGNAL_PHONE_NUMBER']) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-channels-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), [
    'identity:', '  owner: Test',
    'channels:', '  telegram:', '    enabled: true', '    botToken: "123456789:AAEsavedsavedsavedsavedsavedsaved00"',
    '    admins:', '      - userId: 1', '        chatId: 1', '        firstName: Salman', '        approvedAt: "2026-10-01T00:00:00.000Z"',
    '    members: []',
    '    pending:', '      - userId: 2', '        chatId: 22', '        firstName: Heer', '        requestedAt: "2026-10-27T00:00:00.000Z"',
    '',
  ].join('\n'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

import channels, { applyAccess, setChannelTestHooks } from './channels.js';
import { loadConfig } from '../../utils/config.js';

const call = (method: string, path: string, body?: unknown) => channels.request(`http://127.0.0.1${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const yaml = () => readFileSync(join(home, 'mercury.yaml'), 'utf-8');

interface ChannelRow {
  type: string;
  settings: Record<string, unknown>;
  access: { admins: unknown[]; members: unknown[]; pending: unknown[] };
}
interface ChannelsListBody { channels: ChannelRow[] }
interface ChannelSaveBody { identity?: string; channel: ChannelRow }
type DiscordUser = ReturnType<typeof loadConfig>['channels']['discord']['admins'][number];

describe('channels settings', () => {
  it('lists every channel with keys hidden and people in one shape', async () => {
    const body = (await (await call('GET', '/api/channels')).json()) as ChannelsListBody;
    expect(body.channels.map((c) => c.type)).toEqual(['telegram', 'discord', 'slack', 'signal']);
    const tg = body.channels[0];
    expect(tg.settings.botToken).toBe('1234••••ed00');
    expect(JSON.stringify(body)).not.toContain('savedsaved');
    expect(tg.access.admins).toEqual([expect.objectContaining({ id: '1', name: 'Salman', role: 'admin' })]);
    expect(tg.access.pending).toEqual([expect.objectContaining({ id: '2', name: 'Heer' })]);
  });

  it('approves a request, and refuses to leave the channel without an admin', async () => {
    const ok = await call('POST', '/api/channels/telegram/access', { action: 'approve', id: '2' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ChannelSaveBody).channel.access.members).toEqual([expect.objectContaining({ id: '2' })]);
    expect((await call('POST', '/api/channels/telegram/access', { action: 'remove', id: '1' })).status).toBe(409);
    expect((await call('POST', '/api/channels/telegram/access', { action: 'demote', id: '1' })).status).toBe(409);
    expect((await call('POST', '/api/channels/telegram/access', { action: 'promote', id: '2' })).status).toBe(200);
    expect((await call('POST', '/api/channels/telegram/access', { action: 'demote', id: '1' })).status).toBe(200);
    expect(yaml()).toMatch(/admins:\n\s+- userId: 2/);
  });

  it('never saves a hidden key, and never turns on with credentials that fail', async () => {
    expect((await call('PUT', '/api/channels/telegram', { botToken: '1234••••ed00' })).status).toBe(400);
    setChannelTestHooks({ fetch: vi.fn().mockResolvedValue({ status: 401, json: async () => ({ ok: false }) }) as never });
    const bad = await call('PUT', '/api/channels/discord', { enabled: true, botToken: 'MTIz' + 'NDU2Nzg5MDEyMzQ1Njc4.GabcDe.abcdefghijklmnopqrstuvwxyz0123' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: 'botToken' });
    expect(loadConfig().channels.discord.enabled).toBe(false);
  });

  it('saves Slack once both tokens check out', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true, user: 'mercury', team: 'Cosmic' }) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true }) });
    setChannelTestHooks({ fetch: f as never });
    const res = await call('PUT', '/api/channels/slack', { enabled: true, botToken: 'xoxb' + '-1234567890-abcdefghijklmnopqrst', appToken: 'xapp' + '-1-A123-4567890-abcdefghijklmnop', channelId: 'C123' });
    const body = (await res.json()) as ChannelSaveBody;
    expect(res.status).toBe(200);
    expect(body.identity).toBe('@mercury in Cosmic');
    expect(body.channel.settings).toMatchObject({ hasBotToken: true, hasAppToken: true, channelId: 'C123' });
    expect(loadConfig().channels.slack.enabled).toBe(true);
  });

  it('Signal is checked locally and can be turned off without any check', async () => {
    setChannelTestHooks({ signal: () => ({ binary: '/x', javaOk: true, accounts: ['+923001234567'] }) });
    const r = await call('PUT', '/api/channels/signal', { enabled: true, phoneNumber: '+92 300 1234567', mode: 'private' });
    expect(r.status).toBe(200);
    expect(loadConfig().channels.signal).toMatchObject({ phoneNumber: '+923001234567', mode: 'private', enabled: true });
    expect((await call('PUT', '/api/channels/signal', { enabled: false })).status).toBe(200);
  });

  it('Discord and Slack keep the role field in step when promoting', () => {
    const cfg = loadConfig();
    cfg.channels.discord.admins = [{ userId: 'a', role: 'admin', approvedAt: 'x' } as DiscordUser];
    cfg.channels.discord.members = [{ userId: 'b', role: 'member', approvedAt: 'x' } as DiscordUser];
    expect(applyAccess('discord', cfg, 'promote', 'b')).toEqual({ ok: true });
    expect(cfg.channels.discord.admins.find((u) => u.userId === 'b')?.role).toBe('admin');
  });
});
