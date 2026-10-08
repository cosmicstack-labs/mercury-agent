import { beforeAll, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import type { ChatMessage } from './types.js';
import {
  buildMercuryBrandLines,
  buildMercuryMessageLines,
  parseChunkIndex,
  settledChunkEnds,
  splitFinalMessage,
  splitStreamingMessage,
  stripTerminalAnsi,
  wrapMercuryText,
  wrapStyledLine,
} from './mercury-transcript.js';

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
  // Test runs have no TTY, so chalk would emit no styling at all.
  beforeAll(() => { chalk.level = 1; });

  it('wraps long text without dropping any words', () => {
    const source = 'Every part of this response remains visible even on a narrow terminal';
    const wrapped = wrapMercuryText(source, 20);

    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join(' ').replace(/\s+/g, ' ')).toBe(source);
    expect(wrapped.every((line) => line.length <= 20)).toBe(true);
  });

  it('marks the first row of user and agent messages with the role', () => {
    const user = buildMercuryMessageLines(message({ role: 'user', content: 'Please update the parser.' }), 60);
    const agent = buildMercuryMessageLines(message({ id: 'msg-2', content: 'I updated the parser.' }), 60);

    expect(user[0]).toMatchObject({ kind: 'text', text: 'Please update the parser.', lead: 'user' });
    expect(agent[0]).toMatchObject({ kind: 'text', text: 'I updated the parser.', lead: 'agent' });
    expect([...user, ...agent].filter((l) => l.lead)).toHaveLength(2);
  });

  it('keeps markdown styling on agent rows and leaves user input as typed', () => {
    const agent = buildMercuryMessageLines(message({ content: 'This is **bold** and `code`.' }), 60);
    expect(agent[0].text).toMatch(/\x1b\[/);
    expect(stripTerminalAnsi(agent[0].text)).toBe('This is bold and code.');

    const user = buildMercuryMessageLines(message({ role: 'user', content: 'keep **stars**' }), 60);
    expect(user[0].text).toBe('keep **stars**');
  });

  it('strips escape sequences that arrive in model output', () => {
    const lines = buildMercuryMessageLines(message({ content: 'safe\x1b]0;pwned\x07 \x1b[2Jtext' }), 60);
    expect(lines.map((l) => stripTerminalAnsi(l.text)).join('')).not.toMatch(/pwned|\x07/);
    expect(lines.some((l) => l.text.includes('\x1b[2J'))).toBe(false);
  });

  it('wraps styled rows by visible width with a hanging indent', () => {
    const rows = wrapStyledLine(`  \x1b[2m•\x1b[22m ${'\x1b[1mword\x1b[22m '.repeat(12)}`, 30);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(stripTerminalAnsi(row).length).toBeLessThanOrEqual(30);
    for (const row of rows.slice(1)) expect(stripTerminalAnsi(row).startsWith('    ')).toBe(true);
  });

  it('reopens styles on every row when a styled span crosses a wrap', () => {
    const bold = `\x1b[1m${'alpha beta gamma delta epsilon zeta eta theta'}\x1b[22m tail`;
    const rows = wrapStyledLine(bold, 20);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, -1)) {
      expect(row.startsWith('\x1b[1m')).toBe(true);
      expect(row.endsWith('\x1b[0m')).toBe(true);
    }
    expect(rows.map(stripTerminalAnsi).join(' ')).toBe('alpha beta gamma delta epsilon zeta eta theta tail');
  });

  it('measures wide characters by terminal columns', () => {
    const rows = wrapStyledLine('漢字'.repeat(20), 20);
    for (const row of rows) expect(row.length * 2).toBeLessThanOrEqual(20);
    expect(rows.join('')).toBe('漢字'.repeat(20));
  });

  it('repeats the blockquote rule on continuation rows', () => {
    const rows = wrapStyledLine(`\x1b[2m│ \x1b[22m${'quoted words here '.repeat(4).trim()}`, 24);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(stripTerminalAnsi(row).startsWith('│ ')).toBe(true);
  });

  it('starts a message at its first visible row even when it opens with a heading', () => {
    const lines = buildMercuryMessageLines(message({ content: '# Title\n\nbody' }), 60);
    expect(stripTerminalAnsi(lines[0].text)).toBe('Title');
    expect(lines[0].lead).toBe('agent');
  });

  it('keeps fenced code structured for syntax highlighting', () => {
    const lines = buildMercuryMessageLines(message({ content: 'Use this:\n```ts\nconst answer = 42;\n```' }), 60);

    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'code-label', text: 'ts', lang: 'ts' }),
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

const FULL = [
  '# Refactor Plan',
  '',
  '## Overview',
  'We will split the auth module into three layers.',
  '',
  '- **Step one:** extract token verification',
  '- **Step two:** move session storage to redis',
  '',
  '## Details',
  '',
  '```ts',
  "import { verifyToken } from './auth';",
  'export function guard(req) {',
  '  return verifyToken(req.headers.authorization);',
  '}',
  '```',
  '',
  '## Rollout',
  'Ship behind a flag.',
].join('\n');

const chunkMessage = (content: string, streaming = false): ChatMessage => ({
  id: 'm1',
  role: 'agent',
  content,
  timestamp: 1,
  streaming,
});

/**
 * Progressive-flush splitter guards. <Static> prints each item exactly once,
 * so the chunk keys produced while a message streams must be a strict prefix
 * of the keys produced by the finalized content — otherwise finalization
 * re-prints blocks the user already saw (or drops them).
 */
describe('settled-chunk splitter (progressive streaming flush)', () => {
  it('reassembles into the original content exactly', () => {
    const chunks = splitFinalMessage(chunkMessage(FULL));
    expect(chunks.map((c) => c.content).join('')).toBe(FULL);
  });

  it('settled boundaries of every partial stream are a subset of the final boundaries', () => {
    const fullEnds = settledChunkEnds(FULL);
    for (let cut = 1; cut < FULL.length; cut++) {
      for (const end of settledChunkEnds(FULL.slice(0, cut))) {
        expect(fullEnds).toContain(end);
      }
    }
  });

  it('never settles a boundary inside an open code fence', () => {
    const unclosed = '```ts\nconst x = 1;\nstill inside the fence';
    expect(settledChunkEnds(unclosed)).toEqual([]);
    // A closed fence settles at the closer even without a trailing blank line.
    expect(settledChunkEnds('```ts\nconst x = 1;\n```\nnext')).toEqual([
      '```ts\nconst x = 1;\n```\n'.length,
    ]);
  });

  it('settles blank-line-terminated blocks only when content resumes after the blank', () => {
    // Trailing blank line(s) at the stream's current end are NOT a boundary —
    // more content could still continue the block.
    expect(settledChunkEnds('para one\n\n')).toEqual([]);
    expect(settledChunkEnds('para one\n\npara two')).toEqual(['para one\n\n'.length]);
  });

  it('streaming chunks exclude the unsettled remainder; finalize adds exactly one tail chunk', () => {
    let streamedIds: string[] = [];
    for (const cut of [20, 60, 120, FULL.length]) {
      const content = FULL.slice(0, cut);
      const { chunks, remainderStart } = splitStreamingMessage(chunkMessage(content, true));
      streamedIds = chunks.map((c) => c.id); // the last cut's chunk list is the streamed state
      // Settled chunks + remainder reassemble the streamed content.
      expect(chunks.map((c) => c.content).join('') + content.slice(remainderStart)).toBe(content);
    }
    const finalIds = splitFinalMessage(chunkMessage(FULL)).map((c) => c.id);
    // Every streamed chunk key must survive into the final list, in order.
    expect(finalIds.join(',').startsWith(streamedIds.join(','))).toBe(true);
    // Finalization adds exactly one NEW item (the tail chunk).
    expect(finalIds.length).toBe(streamedIds.length + 1);
  });

  it('carries fileChanges only on the last chunk', () => {
    const fileChanges = [{ path: 'src/a.ts', added: 3, removed: 1 }];
    const chunks = splitFinalMessage({ ...chunkMessage(FULL), fileChanges });
    expect(chunks.slice(0, -1).every((c) => c.fileChanges === undefined)).toBe(true);
    expect(chunks[chunks.length - 1].fileChanges).toEqual(fileChanges);
  });

  it('renders the role marker only on chunk 0', () => {
    const chunks = splitFinalMessage(chunkMessage(FULL));
    expect(chunks.length).toBeGreaterThan(1);
    expect(buildMercuryMessageLines(chunks[0], 76).some((l) => l.lead === 'agent')).toBe(true);
    for (const chunk of chunks.slice(1)) {
      expect(buildMercuryMessageLines(chunk, 76, { showHeader: false }).some((l) => l.lead)).toBe(false);
    }
    // Whole messages (no #c id) keep the marker.
    expect(parseChunkIndex('m1')).toBeNull();
    expect(buildMercuryMessageLines(chunkMessage('hello'), 76).some((l) => l.lead === 'agent')).toBe(true);
  });

  it('degenerate inputs: short and empty messages produce exactly one chunk', () => {
    expect(splitFinalMessage(chunkMessage('short answer')).map((c) => c.id)).toEqual(['m1#c0']);
    expect(splitFinalMessage(chunkMessage('')).map((c) => c.id)).toEqual(['m1#c0']);
  });
});

describe('dev-build badge on the TUI wordmark', () => {
  const devVersion = '1.2.7-dev.20260929.790d20a';

  it('badges the version row two-tone on dev builds', () => {
    const rows = buildMercuryBrandLines(devVersion, 120);
    const versionRow = rows.find((r) => r.key === 'brand:version');
    expect(versionRow).toBeDefined();
    expect(versionRow!.text).toContain(`v${devVersion}`);
    // Two-tone: the dev marker rides the accent segment, so it renders in the
    // wordmark's secondary color — not buried in the version string.
    expect(versionRow!.accent).toContain('dev build 20260929.790d20a');
  });

  it('leaves the version row clean on stable builds', () => {
    const rows = buildMercuryBrandLines('1.2.7', 120);
    const versionRow = rows.find((r) => r.key === 'brand:version');
    expect(versionRow).toBeDefined();
    expect(versionRow!.accent).toBe('');
    expect(versionRow!.text).toContain('v1.2.7');
  });
});
