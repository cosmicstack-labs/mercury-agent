import { describe, expect, it, vi } from 'vitest';

// Fixed home: attachments land under MERCURY_HOME/uploads.
await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-chat-attachments-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import chat, { setSessionRepository, setWebChannel } from './chat.js';
import { WebChannel } from '../../channels/web.js';
import type { ChannelMessage } from '../../types/channel.js';
import { sep } from 'node:path';

/** Windows joins with \\; assertions stay portable by comparing posix-style. */
const posix = (value: string) => value.split(sep).join('/');

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A web channel that records what the route hands the runtime. */
function recordingChannel(): { channel: WebChannel; seen: ChannelMessage[] } {
  const channel = new WebChannel('Mercury');
  const seen: ChannelMessage[] = [];
  channel.onMessage(msg => seen.push(msg));
  setWebChannel(channel);
  setSessionRepository({
    getByBinding: () => null,
    get: () => {
      throw new Error('not found');
    },
    getOrCreateBound: () => ({ id: 'sess-1' }),
  } as never);
  return { channel, seen };
}

function send(body: unknown) {
  return chat.request('http://127.0.0.1/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/chat/send with attachments', () => {
  it('forwards a photo to the runtime as a real attachment', async () => {
    const { seen } = recordingChannel();

    const res = await send({ content: 'What is this?', attachments: [{ name: 'dot.png', data: PNG_BASE64 }] });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sent: true,
      sessionId: 'sess-1',
      attachments: [{ name: 'dot.png', kind: 'image' }],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].content).toBe('What is this?');
    const attachments = seen[0].metadata?.attachments as Array<{ kind: string; path: string; mime: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(posix(attachments[0].path)).toMatch(/\/uploads\/\d{4}-\d{2}\/.+\.png$/);
  });

  it('accepts a photo with no text at all', async () => {
    const { seen } = recordingChannel();

    const res = await send({ content: '   ', attachments: [{ name: 'dot.png', data: PNG_BASE64 }] });

    expect(res.status).toBe(200);
    // An empty text block is rejected by models: the files are named instead.
    expect(seen[0].content).toBe('(Attached: dot.png)');
    expect((seen[0].metadata?.attachments as unknown[]).length).toBe(1);
  });

  it('still requires text when there is nothing attached', async () => {
    recordingChannel();
    const res = await send({ content: '   ' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Message content required' });
  });

  it('rejects an unsupported file instead of silently dropping it', async () => {
    recordingChannel();
    const res = await send({
      content: 'read this',
      attachments: [{ name: 'notes.txt', data: Buffer.from('hello').toString('base64') }],
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'attachment 1 is not a supported image (png, jpeg, webp, gif) or PDF',
    });
  });

  it('leaves a text-only message exactly as before', async () => {
    const { seen } = recordingChannel();

    const res = await send({ content: '  hello  ' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ sent: true, sessionId: 'sess-1' });
    expect(seen[0].content).toBe('hello');
    expect(seen[0].metadata?.attachments).toBeUndefined();
  });

  it('removes the stored files when the message cannot be sent', async () => {
    const { channel } = recordingChannel();
    channel.setRestrictUser(true);
    const { readdirSync, existsSync } = await import('node:fs');
    const { uploadsDir } = await import('./uploads.js');
    const before = existsSync(uploadsDir()) ? readdirSync(uploadsDir()).length : 0;

    const res = await send({ content: 'look', attachments: [{ data: PNG_BASE64 }] });

    expect(res.status).toBe(500);
    expect(readdirSync(uploadsDir()).length).toBe(before);
  });
});
