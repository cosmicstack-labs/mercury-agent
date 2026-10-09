import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../sessions/types.js';
import {
  HISTORY_MIN_ENTRIES,
  TOOL_TRACE_KIND,
  formatToolTrace,
  formatToolTraceLine,
  selectHistoryWindow,
  summarizeToolArgs,
  summarizeToolResult,
  toModelMessage,
  withReasoningParts,
} from './context-window.js';

let seq = 0;
const entry = (role: SessionMessage['role'], content: string, extra: Partial<SessionMessage> = {}): SessionMessage => ({
  id: `m${++seq}`,
  sessionId: 's',
  role,
  kind: 'message',
  content,
  timestamp: seq,
  sequence: seq,
  ...extra,
});

describe('selectHistoryWindow', () => {
  it('keeps the newest entries under the token budget, oldest first', () => {
    const msgs = [
      entry('user', 'a'.repeat(400)),
      entry('assistant', 'b'.repeat(400)),
      entry('user', 'c'.repeat(400)),
      entry('assistant', 'd'.repeat(400)),
    ];
    const picked = selectHistoryWindow(msgs, 250);
    expect(picked.map((m) => m.content[0])).toEqual(['c', 'd']);
  });

  it('always keeps the last exchange even over budget', () => {
    const msgs = [entry('user', 'x'.repeat(4000)), entry('assistant', 'y'.repeat(4000))];
    expect(selectHistoryWindow(msgs, 10)).toHaveLength(HISTORY_MIN_ENTRIES);
  });

  it('includes tool-trace entries and excludes other kinds', () => {
    const msgs = [
      entry('user', 'read the config'),
      entry('assistant', '[Tool activity]\n- read_file path=x → ok', { kind: TOOL_TRACE_KIND }),
      entry('assistant', 'progress…', { kind: 'progress' }),
      entry('tool', 'raw tool output', { kind: 'tool-result' }),
      entry('assistant', 'Here is the config.'),
    ];
    const picked = selectHistoryWindow(msgs, 10_000);
    expect(picked.map((m) => m.kind)).toEqual(['message', TOOL_TRACE_KIND, 'message']);
  });

  it('respects the entry cap', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => entry(i % 2 ? 'assistant' : 'user', `m${i}`));
    expect(selectHistoryWindow(msgs, 1_000_000, 10)).toHaveLength(10);
  });
});

describe('reasoning parts', () => {
  it('attaches stored reasoning as parts only for assistant messages that have it', () => {
    const msgs = [
      toModelMessage(entry('user', 'hi')),
      toModelMessage(entry('assistant', 'hello', { reasoning: 'the user greeted me' })),
      toModelMessage(entry('assistant', 'plain')),
    ];
    expect(msgs.map((m) => ({ ...m }))).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'assistant', content: 'plain' },
    ]);
    const withParts = withReasoningParts(msgs) as any[];
    expect(withParts[0]).toEqual({ role: 'user', content: 'hi' });
    expect(withParts[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'the user greeted me' },
        { type: 'text', text: 'hello' },
      ],
    });
    expect(withParts[2]).toEqual({ role: 'assistant', content: 'plain' });
  });
});

describe('tool trace formatting', () => {
  it('summarises args by the most useful field and results by outcome', () => {
    expect(summarizeToolArgs({ path: 'src/app.ts', encoding: 'utf8' })).toBe('path=src/app.ts');
    expect(summarizeToolArgs({ command: 'npm   test' })).toBe('command=npm test');
    expect(summarizeToolArgs({ foo: 'bar' })).toBe('foo=bar');
    expect(summarizeToolArgs(null)).toBe('');
    expect(summarizeToolResult('line1\nline2\nline3\nline4', true)).toBe('ok (4 lines)');
    expect(summarizeToolResult('done', true)).toBe('ok done');
    expect(summarizeToolResult('Error: Permission denied for read access', false)).toMatch(/^✗ Error: Permission denied/);
  });

  it('builds bounded trace lines and caps the trace length', () => {
    const line = formatToolTraceLine({ tool: 'read_file', args: 'path=' + 'x'.repeat(300), outcome: 'ok' });
    expect(line.length).toBeLessThanOrEqual(160);
    const lines = Array.from({ length: 60 }, (_, i) => `- call ${i}`);
    const trace = formatToolTrace(lines);
    expect(trace.startsWith('[Tool activity in my previous turn]')).toBe(true);
    expect(trace.split('\n')).toHaveLength(41);
    expect(trace).toContain('21 more tool calls');
  });
});
