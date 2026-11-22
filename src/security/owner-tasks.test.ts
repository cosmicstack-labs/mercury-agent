import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerTasks, _setOwnerTasks, ownerTaskText, ownerTasks, parseOwnerTaskReply } from './owner-tasks.js';
import { createAskOwnerTool } from '../capabilities/interaction/ask-owner.js';
import { ownerTaskRoutes } from '../web/api/owner-tasks.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
let dir = '';
let clock = 1_000_000;
const make = () => new OwnerTasks(() => clock, () => join(dir, 'tasks'));

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owner-tasks-')); clock = 1_000_000; });
afterEach(() => { _setOwnerTasks(null); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

describe('owner tasks (ADR-048)', () => {
  it('hands the owner a task with its image, and returns their answer', async () => {
    const tasks = make();
    const seen: string[] = [];
    tasks.onChange((t, change) => seen.push(`${change}:${t.status}`));
    const t = tasks.request({ title: 'Solve this CAPTCHA', prompt: 'Type the letters for example.com', who: 'Mercury', link: 'https://example.com/login', media: { kind: 'image', mimeType: 'image/png', data: PNG } }, 60_000);
    expect(t.code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(readFileSync(t.media!.path)).toEqual(PNG);
    const waiting = tasks.wait(t.id);
    expect(tasks.answer(t.code.toLowerCase(), '  4fz9q ', 'telegram')).toMatchObject({ status: 'answered', answer: '4fz9q' });
    await expect(waiting).resolves.toEqual({ status: 'answered', answer: '4fz9q', by: 'telegram' });
    expect(seen).toEqual(['new:pending', 'settled:answered']);
    // Answered once: a second answer is refused.
    expect(tasks.answer(t.id, 'other', 'app')).toBeNull();
  });

  it('nobody answering in time is a timeout, never a guess', async () => {
    vi.useFakeTimers();
    const tasks = make();
    const t = tasks.request({ title: 'Code', prompt: 'Send the code', who: 'Mercury' }, 60_000);
    const waiting = tasks.wait(t.id);
    vi.advanceTimersByTime(60_001);
    await expect(waiting).resolves.toEqual({ status: 'expired' });
  });

  it('decline, and cancel when the asker stops', async () => {
    const tasks = make();
    const a = tasks.request({ title: 'A', prompt: 'do a', who: 'x' }, 60_000);
    const wa = tasks.wait(a.id);
    tasks.decline(a.code, 'whatsapp');
    await expect(wa).resolves.toEqual({ status: 'declined' });
    const b = tasks.request({ title: 'B', prompt: 'do b', who: 'x' }, 60_000);
    const stop = new AbortController();
    const wb = tasks.wait(b.id, stop.signal);
    stop.abort();
    await expect(wb).resolves.toEqual({ status: 'cancelled' });
    expect(tasks.pending()).toEqual([]);
  });

  it('refuses bad media: unknown type, too large, kind mismatch', () => {
    const tasks = make();
    expect(() => tasks.request({ title: 't', prompt: 'p', who: 'x', media: { kind: 'image', mimeType: 'application/pdf', data: PNG } }, 1000)).toThrow(/Unsupported/);
    expect(() => tasks.request({ title: 't', prompt: 'p', who: 'x', media: { kind: 'image', mimeType: 'image/png', data: Buffer.alloc(6 * 1024 * 1024) } }, 1000)).toThrow(/MB/);
    expect(() => tasks.request({ title: 't', prompt: 'p', who: 'x', media: { kind: 'audio', mimeType: 'image/png', data: PNG } }, 1000)).toThrow(/disagree/);
  });

  it('settled tasks are forgotten later, with their media', () => {
    const tasks = make();
    const t = tasks.request({ title: 't', prompt: 'p', who: 'x', media: { kind: 'image', mimeType: 'image/png', data: PNG } }, 1000);
    tasks.answer(t.id, 'ok', 'cli');
    clock += 20 * 60_000;
    tasks.request({ title: 'next', prompt: 'p', who: 'x' }, 1000);
    expect(tasks.get(t.id)).toBeNull();
    expect(existsSync(t.media!.path)).toBe(false);
  });

  it('parses replies from a chat; ordinary words are not codes', () => {
    expect(parseOwnerTaskReply('K7Q2M 4fz9q')).toEqual({ code: 'K7Q2M', answer: '4fz9q' });
    expect(parseOwnerTaskReply('answer k7q2m: hello world')).toEqual({ code: 'K7Q2M', answer: 'hello world' });
    expect(parseOwnerTaskReply('decline K7Q2M')).toEqual({ code: 'K7Q2M', decline: true });
    expect(parseOwnerTaskReply('HELLO there')).toBeNull(); // O is not in the code alphabet
    expect(parseOwnerTaskReply('K7Q2M')).toBeNull();
  });

  it('the message names who asks, the page, how to answer, and warns about passwords', () => {
    const t = make().request({ title: 'Solve this CAPTCHA', prompt: 'Type the letters', who: 'Captcha Solver (plugin)', link: 'https://example.com', media: { kind: 'image', mimeType: 'image/png', data: PNG } }, 5 * 60_000);
    const text = ownerTaskText(t, clock);
    expect(text).toContain('Captcha Solver (plugin) needs you: Solve this CAPTCHA');
    expect(text).toContain('Page: https://example.com');
    expect(text).toContain(`Reply “${t.code} <your answer>”`);
    expect(text).toContain('Expires in 5 min');
    expect(text).toContain('Never send a password');
  });
});

describe('ask_owner tool', () => {
  const tool = () => createAskOwnerTool({
    permissions: { checkFsAccess: async (p: string) => (p.startsWith(dir) ? { allowed: true } : { allowed: false, reason: 'outside scope' }) } as never,
    cwd: () => dir,
  }) as unknown as { execute: (a: Record<string, unknown>, o?: unknown) => Promise<string> };

  it('sends the image and returns the owner\'s answer', async () => {
    _setOwnerTasks(make());
    writeFileSync(join(dir, 'captcha.png'), PNG);
    const run = tool().execute({ title: 'Solve this CAPTCHA', request: 'Type the letters for example.com', file: 'captcha.png' });
    await vi.waitFor(() => expect(ownerTasks().pending()).toHaveLength(1));
    const [t] = ownerTasks().pending();
    expect(t.media?.mimeType).toBe('image/png');
    ownerTasks().answer(t.code, 'xk2p9', 'telegram');
    await expect(run).resolves.toBe('The owner answered: xk2p9');
  });

  it('refuses files outside its read access, and unsupported types', async () => {
    _setOwnerTasks(make());
    await expect(tool().execute({ title: 'Solve it', request: 'Type it', file: '/etc/secret.png' })).resolves.toContain('outside scope');
    await expect(tool().execute({ title: 'Solve it', request: 'Type it', file: 'doc.pdf' })).resolves.toContain('attach an image');
    expect(ownerTasks().pending()).toEqual([]);
  });

  it('a timeout tells the model not to guess', async () => {
    vi.useFakeTimers();
    _setOwnerTasks(make());
    const run = tool().execute({ title: 'Code please', request: 'Send the bank code', timeout_minutes: 1 });
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(run).resolves.toMatch(/No answer from the owner within 1 minute. Do not guess/);
  });
});

describe('owner task API', () => {
  it('lists, serves the media, and takes one answer', async () => {
    process.env.MERCURY_HOME = dir;
    _setOwnerTasks(make());
    const t = ownerTasks().request({ title: 'Solve', prompt: 'Type it', who: 'Mercury', media: { kind: 'image', mimeType: 'image/png', data: PNG } }, 60_000);
    const list = await (await ownerTaskRoutes.request('/api/owner/tasks')).json() as { pending: Array<{ id: string; media: { url: string } }> };
    expect(list.pending[0]).toMatchObject({ id: t.id, media: { url: `/api/owner/tasks/${t.id}/media` } });
    const media = await ownerTaskRoutes.request(`/api/owner/tasks/${t.id}/media`);
    expect(media.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await media.arrayBuffer())).toEqual(PNG);
    expect((await ownerTaskRoutes.request(`/api/owner/tasks/${t.id}`, { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } })).status).toBe(400);
    const ok = await ownerTaskRoutes.request(`/api/owner/tasks/${t.id}`, { method: 'POST', body: JSON.stringify({ answer: 'ab12' }), headers: { 'content-type': 'application/json' } });
    expect(ok.status).toBe(200);
    const again = await ownerTaskRoutes.request(`/api/owner/tasks/${t.id}`, { method: 'POST', body: JSON.stringify({ answer: 'zz' }), headers: { 'content-type': 'application/json' } });
    expect(again.status).toBe(409);
    delete process.env.MERCURY_HOME;
  });
});

describe('ownerTaskSettledText', () => {
  it('tells every chat how the task ended, and where', async () => {
    const { ownerTaskSettledText } = await import('./owner-tasks.js');
    const base = { id: 'x', code: 'K7Q2M', title: 'Solve this CAPTCHA', prompt: 'p', who: 'Mercury', answerKind: 'text' as const, at: 0, expiresAt: 1 };
    expect(ownerTaskSettledText({ ...base, status: 'answered', answeredBy: 'telegram' })).toBe('✅ K7Q2M answered on Telegram: Solve this CAPTCHA. Nothing more to do.');
    expect(ownerTaskSettledText({ ...base, status: 'answered', answeredBy: "Salman's iPhone" })).toContain("on Salman's iPhone");
    expect(ownerTaskSettledText({ ...base, status: 'declined', answeredBy: 'whatsapp' })).toBe('Skipped K7Q2M on WhatsApp: Solve this CAPTCHA.');
    expect(ownerTaskSettledText({ ...base, status: 'expired', answeredBy: 'timeout' })).toContain('nobody answered in time');
    expect(ownerTaskSettledText({ ...base, status: 'cancelled', answeredBy: 'asker' })).toContain('no longer needed');
  });
});
