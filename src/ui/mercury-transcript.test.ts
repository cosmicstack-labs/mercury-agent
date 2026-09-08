import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './types.js';
import { buildMercuryMessageLines, wrapMercuryText } from './mercury-transcript.js';

function message(partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'agent',
    content: 'Hello',
    timestamp: 1,
    ...partial,
  };
}

describe('Mercury Code transcript formatting', () => {
  it('wraps long text without dropping any words', () => {
    const source = 'Every part of this response remains visible even on a narrow terminal';
    const wrapped = wrapMercuryText(source, 20);

    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join(' ').replace(/\s+/g, ' ')).toBe(source);
    expect(wrapped.every((line) => line.length <= 20)).toBe(true);
  });

  it('categorizes user and agent messages with explicit headers', () => {
    const user = buildMercuryMessageLines(message({ role: 'user', content: 'Please update the parser.' }), 60);
    const agent = buildMercuryMessageLines(message({ id: 'msg-2', content: 'I updated the parser.' }), 60);

    expect(user[0]).toMatchObject({ kind: 'header', text: 'YOU', role: 'user' });
    expect(agent[0]).toMatchObject({ kind: 'header', text: 'MERCURY', role: 'agent' });
  });

  it('keeps fenced code structured for syntax highlighting', () => {
    const lines = buildMercuryMessageLines(message({ content: 'Use this:\n```ts\nconst answer = 42;\n```' }), 60);

    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'code-label', text: 'TS', lang: 'ts' }),
      expect.objectContaining({ kind: 'code', text: 'const answer = 42;', lang: 'ts' }),
    ]));
  });

  it('hides heartbeats and renders one summary row per changed file', () => {
    expect(buildMercuryMessageLines(message({ id: 'heartbeat-1' }), 60)).toEqual([]);

    const lines = buildMercuryMessageLines(message({
      role: 'system',
      content: 'Task complete · 3 steps · 12s',
      fileChanges: [
        { path: 'src/app.ts', added: 8, removed: 2 },
        { path: 'public/logo.png', added: null, removed: null },
      ],
    }), 60);

    expect(lines.filter((line) => line.kind === 'file').map((line) => line.text)).toEqual([
      'src/app.ts  +8 -2',
      'public/logo.png  binary',
    ]);
  });
});
