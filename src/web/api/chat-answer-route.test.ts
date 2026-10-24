import { describe, expect, it, vi } from 'vitest';

// Fixed config path: point MERCURY_HOME at a temp dir before importing routes.
await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-answer-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import chat, { setWebChannel } from './chat.js';
import { WebChannel } from '../../channels/web.js';

function answer(id: string, action: string) {
  return chat.request(`http://127.0.0.1/api/chat/permission/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

function channelWithScreen(): { channel: WebChannel; promptIds: string[] } {
  const channel = new WebChannel('Mercury');
  const promptIds: string[] = [];
  channel.addSSEClient({
    enqueue(value: Uint8Array) {
      const text = new TextDecoder().decode(value);
      const id = /"id":"(choice_[^"]+|perm[^"]*)"/.exec(text)?.[1];
      if (id) promptIds.push(id);
    },
    close() {},
  } as unknown as ReadableStreamDefaultController, 'sess-1');
  setWebChannel(channel);
  return { channel, promptIds };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * The attached terminal answers every prompt through this one endpoint. It
 * used to resolve permission approvals only, so a choice picker (/model,
 * /permissions, ask_user) answered there never reached the runtime and the
 * screen sat on "Thinking" until the 2-minute timeout.
 */
describe('POST /api/chat/permission/:id', () => {
  it('answers a choice picker raised for an attached screen', async () => {
    const { channel, promptIds } = channelWithScreen();
    const picked = channel.presentChoicePrompt('Permission mode?', [
      { value: 'ask-me', label: 'Ask Me' },
      { value: 'allow-all', label: 'Allow All' },
    ], 'sess-1');
    await tick();
    expect(promptIds).toHaveLength(1);
    const res = await answer(promptIds[0], 'allow-all');
    expect(res.status).toBe(200);
    await expect(picked).resolves.toBe('allow-all');
  });

  it('an empty answer is Esc: the picker is cancelled, not left hanging', async () => {
    const { channel, promptIds } = channelWithScreen();
    const picked = channel.presentChoicePrompt('Switch model?', [{ value: '0', label: 'a' }, { value: '1', label: 'b' }], 'sess-1');
    await tick();
    const res = await answer(promptIds[0], '');
    expect(res.status).toBe(200);
    await expect(picked).resolves.toBe('');
  });

  it('still answers a permission approval, and refuses an unknown id', async () => {
    const { channel } = channelWithScreen();
    const events: string[] = [];
    channel.addSSEClient({ enqueue(v: Uint8Array) { events.push(new TextDecoder().decode(v)); }, close() {} } as unknown as ReadableStreamDefaultController, 'sess-1');
    const approved = channel.askPermission('Write file?', 'sess-1');
    await tick();
    const id = /"id":"([^"]+)"/.exec(events.find((e) => e.includes('permission_request')) ?? '')?.[1];
    expect(id).toBeTruthy();
    expect((await answer(id!, 'yes')).status).toBe(200);
    await expect(approved).resolves.toBe('yes');
    expect((await answer('nope', 'yes')).status).toBe(404);
  });
});
