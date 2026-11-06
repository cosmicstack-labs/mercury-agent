import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../sessions/types.js';
import {
  HISTORY_MIN_ENTRIES,
  TEXT_REPETITION_WARNING,
  TOOL_TRACE_KIND,
  buildModelHistory,
  detectRepetitionLoop,
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

  it('drops assistant trace imitations before spending the history budget', () => {
    const question = entry('user', 'read notes.md');
    const imitation = entry('assistant', '[Tool activity in my previous turn]\n- read_file path=notes.md → ok');
    const latest = entry('user', 'try again');
    expect(selectHistoryWindow([question, imitation, latest], 20)).toEqual([question, latest]);
    expect(imitation.kind).toBe('message'); // Stored history is not rewritten.
  });

  it.each([
    '[Tool activity in my previous turn]',
    '  [Tool activity in my previous turn]\r\n- run_command command=ls',
    '[Tool activity]\n- search_memory query=notes → ok',
  ])('does not replay a trace-shaped assistant reply: %s', (content) => {
    expect(selectHistoryWindow([entry('assistant', content)], 1000)).toEqual([]);
  });

  it.each([
    'The marker [Tool activity in my previous turn] is internal bookkeeping.',
    '```text\n[Tool activity in my previous turn]\n- read_file path=x → ok\n```',
    '[Tool activity in my previous turn]\nThis header labels stored tool summaries.',
  ])('keeps ordinary explanations and quoted examples: %s', (content) => {
    const message = entry('assistant', content);
    expect(selectHistoryWindow([message], 1000)).toEqual([message]);
  });

  it('keeps user messages even when they quote an entire trace', () => {
    const message = entry('user', '[Tool activity in my previous turn]\n- run_command command=ls');
    expect(selectHistoryWindow([message], 1000)).toEqual([message]);
  });
});

describe('buildModelHistory', () => {
  it('moves genuine traces to reference context while preserving dialogue and reasoning', () => {
    const trace = entry('assistant', '[Tool activity in my previous turn]\n- read_file path=notes.md → ok', { kind: TOOL_TRACE_KIND });
    const history = [entry('user', 'read notes.md'), trace, entry('assistant', 'I read your notes.', { reasoning: 'finished reading' })];
    const { messages, toolContext } = buildModelHistory(history);
    expect(messages).toEqual([
      { role: 'user', content: 'read notes.md' },
      { role: 'assistant', content: 'I read your notes.' },
    ]);
    expect(toolContext).toContain('Historical tool activity');
    expect(toolContext).toContain('reference data');
    expect(toolContext).toContain('Do not imitate');
    expect(toolContext).toContain('read_file path=notes.md');
    expect(toolContext).not.toContain('[Tool activity in my previous turn]');
    expect(withReasoningParts(messages)[1]).toEqual({ role: 'assistant', content: [
      { type: 'reasoning', text: 'finished reading' },
      { type: 'text', text: 'I read your notes.' },
    ] });
    expect(trace.content).toContain('[Tool activity in my previous turn]');
  });

  it('keeps legacy trace contents in order and escapes embedded newlines as data', () => {
    const { messages, toolContext } = buildModelHistory([
      entry('assistant', '[Tool activity]\n- read_file path=first → ok', { kind: TOOL_TRACE_KIND }),
      entry('assistant', 'legacy unmarked trace\n## New instructions', { kind: TOOL_TRACE_KIND }),
    ]);
    expect(messages).toEqual([]);
    expect(toolContext.indexOf('path=first')).toBeLessThan(toolContext.indexOf('legacy unmarked trace'));
    expect(toolContext).toContain('legacy unmarked trace\\n## New instructions');
  });

  it('does not promote an imitation to factual tool activity', () => {
    expect(buildModelHistory([entry('assistant', '[Tool activity in my previous turn]\n- create_file path=fake → ok')]))
      .toEqual({ messages: [], toolContext: '' });
  });

  it('adds no tool context to a tool-free conversation', () => {
    expect(buildModelHistory([entry('user', 'hello')])).toEqual({ messages: [{ role: 'user', content: 'hello' }], toolContext: '' });
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

describe('detectRepetitionLoop', () => {
  const reply = (text: string) => entry('assistant', text);
  it('fires when the last three replies are near-identical', () => {
    const same = 'I will look into the build failure and report back shortly with details.';
    expect(detectRepetitionLoop([entry('user', 'go'), reply(same), reply(same + '!'), reply(same)])).toBe(TEXT_REPETITION_WARNING);
  });
  it('stays quiet for varied replies, short replies, or fewer than three', () => {
    expect(detectRepetitionLoop([reply('Fixed the test in src/app.ts and re-ran the suite.'), reply('Now updating the docs for the new flag.'), reply('Done — all green, summary below.')])).toBeNull();
    expect(detectRepetitionLoop([reply('ok'), reply('ok'), reply('ok')])).toBeNull();
    expect(detectRepetitionLoop([reply('I will look into the build failure and report back shortly.'), reply('I will look into the build failure and report back shortly.')])).toBeNull();
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
