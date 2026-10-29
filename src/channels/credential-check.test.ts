import { describe, expect, it, vi } from 'vitest';
import { checkDiscord, checkSignal, checkSlack, checkTelegram } from './credential-check.js';

const reply = (...rs: Array<[number, unknown]>) => {
  const f = vi.fn();
  for (const [status, body] of rs) f.mockResolvedValueOnce({ status, json: async () => body });
  return f as unknown as typeof fetch;
};
const TG = '123456789:AAEabcdefghijklmnopqrstuvwxyz0123456';
const DC = 'MTIz' + 'NDU2Nzg5MDEyMzQ1Njc4.GabcDe.abcdefghijklmnopqrstuvwxyz0123';

describe('channel credential checks', () => {
  it('Telegram: shape first, then getMe names the bot', async () => {
    expect((await checkTelegram('nope')).field).toBe('botToken');
    expect(await checkTelegram(TG, reply([200, { ok: true, result: { username: 'mercury_bot' } }]))).toMatchObject({ ok: true, identity: '@mercury_bot' });
    expect(await checkTelegram(TG, reply([401, { ok: false }]))).toMatchObject({ ok: false, field: 'botToken' });
  });

  it('Discord: a valid bot that is not in the server points at the server ID', async () => {
    const r = await checkDiscord(DC, '111', undefined, reply([200, { username: 'Mercury' }], [404, {}]));
    expect(r).toMatchObject({ ok: false, field: 'guildId' });
    expect(await checkDiscord(DC, '111', '222', reply([200, { username: 'Mercury' }], [200, { name: 'Cosmic' }], [200, {}]))).toMatchObject({ ok: true, message: 'Connected as Mercury in Cosmic.' });
    expect(await checkDiscord(DC, undefined, undefined, reply([401, {}]))).toMatchObject({ field: 'botToken' });
  });

  it('Slack: checks the bot token and the app-level token separately', async () => {
    const bot = 'xoxb' + '-1234567890-abcdefghijklmnopqrst';
    const app = 'xapp' + '-1-A123-4567890-abcdefghijklmnop';
    expect((await checkSlack('xoxp' + '-wrong-kind', app)).field).toBe('botToken');
    expect(await checkSlack(bot, app, reply([200, { ok: true, user: 'mercury', team: 'Cosmic Stack' }], [200, { ok: false, error: 'missing_scope' }]))).toMatchObject({ ok: false, field: 'appToken', message: expect.stringMatching(/connections:write/) });
    expect(await checkSlack(bot, app, reply([200, { ok: true, user: 'mercury', team: 'Cosmic Stack' }], [200, { ok: true, url: 'wss://x' }]))).toMatchObject({ ok: true, identity: '@mercury in Cosmic Stack' });
  });

  it('Signal: local checks, in the order a person can fix them', () => {
    expect(checkSignal('0300', { binary: '/x', javaOk: true, accounts: [] }).field).toBe('phoneNumber');
    expect(checkSignal('+923001234567', { binary: null, javaOk: false, accounts: [] }).message).toMatch(/isn't installed/);
    expect(checkSignal('+923001234567', { binary: '/x', javaOk: false, accounts: [] }).message).toMatch(/Java 17/);
    expect(checkSignal('+923001234567', { binary: '/x', javaOk: true, accounts: [] }).message).toMatch(/Link a device/);
    expect(checkSignal('+923001234567', { binary: '/x', javaOk: true, accounts: ['+923001234567'] }).ok).toBe(true);
  });
});
