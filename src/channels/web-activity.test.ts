import { describe, expect, it } from 'vitest';
import { WebChannel } from './web.js';

function sink() {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const controller = {
    enqueue(value: Uint8Array) {
      const text = new TextDecoder().decode(value);
      const m = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(text);
      if (m) events.push({ event: m[1], data: JSON.parse(m[2]) });
    },
    close() {},
  } as unknown as ReadableStreamDefaultController;
  return { events, controller };
}

describe('activity feed for notifications', () => {
  it('reports a turn starting once and finishing, with its title and duration', async () => {
    const channel = new WebChannel('Mercury');
    const feed = sink();
    channel.addActivityClient(feed.controller);
    channel.setSessionTitleLookup((id) => (id === 's1' ? 'Research report' : undefined));

    await channel.typing('s1');
    await channel.typing('s1');
    await channel.send('Here is the report.', 's1', 42_000);

    const kinds = feed.events.filter((e) => e.event === 'activity').map((e) => e.data.kind);
    expect(kinds).toEqual(['started', 'done']);
    const done = feed.events.at(-1)!.data;
    expect(done).toMatchObject({ sessionId: 's1', title: 'Research report', ms: 42_000, preview: 'Here is the report.' });
  });

  it('marks a stopped turn and a failed one apart from a finished one', async () => {
    const channel = new WebChannel('Mercury');
    const feed = sink();
    channel.addActivityClient(feed.controller);
    await channel.typing('s2');
    await channel.send('⏹ Task stopped.', 's2');
    await channel.typing('s3');
    channel.sendError('Provider unreachable', 's3');
    expect(feed.events.map((e) => e.data.kind)).toEqual(['started', 'stopped', 'started', 'failed']);
  });

  it('keeps a prompt in a session nobody has open, replays it, and reports the answer', async () => {
    const channel = new WebChannel('Mercury');
    const feed = sink();
    channel.addActivityClient(feed.controller);

    const answer = channel.askPermission('Run npm run deploy?', 's4');
    const needs = feed.events.find((e) => e.data.kind === 'needs_you')!;
    expect(needs.data).toMatchObject({ sessionId: 's4', prompt: 'Run npm run deploy?' });

    // Opening the session shows the waiting prompt.
    const pending = channel.pendingFor('s4');
    expect(pending).toHaveLength(1);
    expect(pending[0].data).toMatchObject({ prompt: 'Run npm run deploy?' });

    expect(channel.resolveApproval(String(needs.data.id), 'yes')).toBe(true);
    await expect(answer).resolves.toBe('yes');
    expect(feed.events.at(-1)!.data).toMatchObject({ kind: 'resolved', id: needs.data.id });
    expect(channel.pendingFor('s4')).toHaveLength(0);
  });

  it('still declines at once when no screen at all is listening', async () => {
    const channel = new WebChannel('Mercury');
    await expect(channel.askPermission('Delete files?', 's5')).resolves.toBe('no');
  });
});
