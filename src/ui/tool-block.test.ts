import { describe, expect, it } from 'vitest';
import {
  buildToolBlock,
  buildToolBlockDetail,
  displayPath,
  editDiffLines,
  isTranscriptTool,
  TOOL_DIFF_MAX_LINES,
  TOOL_OUTPUT_MAX_LINES,
  TOOL_WRITE_MAX_LINES,
} from './tool-block.js';
import { buildMercuryMessageLines } from './mercury-transcript.js';

const cwd = '/work/proj';

describe('tool blocks', () => {
  it('summarizes a read by line count, path relative to the project', () => {
    const block = buildToolBlock({ toolName: 'read_file', args: { path: '/work/proj/src/a.ts' }, result: 'one\ntwo\nthree\n', isError: false, cwd });
    expect(block).toMatchObject({ title: 'Read', target: 'src/a.ts', status: 'done', summary: 'Read 3 lines' });
    expect(block.body).toBeUndefined();
  });

  it('does not treat file content mentioning errors as a failed read', () => {
    const block = buildToolBlock({ toolName: 'read_file', args: { path: 'a.ts' }, result: '// throws error: when empty\nfoo()', isError: false });
    expect(block.status).toBe('done');
  });

  it('shows an edit as a trimmed line diff with one line of context', () => {
    const oldStr = ['function f() {', '  const ttl = 3600;', '  return ttl;', '}'].join('\n');
    const newStr = ['function f() {', '  const ttl = config.ttl ?? 3600;', '  return ttl;', '}'].join('\n');
    const block = buildToolBlock({ toolName: 'edit_file', args: { path: 'src/s.ts', old_string: oldStr, new_string: newStr }, result: 'Edited src/s.ts', isError: false });
    expect(block.title).toBe('Update');
    expect(block.summary).toBe('1 addition, 1 removal');
    expect(block.body).toEqual({
      lang: 'diff',
      lines: [' function f() {', '-  const ttl = 3600;', '+  const ttl = config.ttl ?? 3600;', '   return ttl;'],
    });
  });

  it('caps long diffs', () => {
    const diff = editDiffLines('', Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
    expect(diff.added).toBe(50);
    const block = buildToolBlock({ toolName: 'edit_file', args: { path: 'x', old_string: '', new_string: diff.lines.map((l) => l.slice(1)).join('\n') }, result: 'ok', isError: false });
    expect(block.body!.lines).toHaveLength(TOOL_DIFF_MAX_LINES + 1);
    expect(block.body!.lines.at(-1)).toBe(`… +${50 - TOOL_DIFF_MAX_LINES} lines (ctrl+o to expand)`);
  });

  it('shows the head of a created file in its language', () => {
    const content = Array.from({ length: 30 }, (_, i) => `print(${i})`).join('\n');
    const block = buildToolBlock({ toolName: 'create_file', args: { path: 'app.py', content }, result: 'Created app.py', isError: false });
    expect(block.summary).toBe('Created 30 lines');
    expect(block.body!.lang).toBe('python');
    expect(block.body!.lines).toHaveLength(TOOL_WRITE_MAX_LINES + 1);
  });

  it('shows the tail of command output; non-zero exit is an error', () => {
    const output = Array.from({ length: 20 }, (_, i) => `out ${i}`).join('\n');
    const ok = buildToolBlock({ toolName: 'run_command', args: { command: 'npm test' }, result: output, isError: false });
    expect(ok).toMatchObject({ title: 'Bash', target: 'npm test', status: 'done', summary: '20 lines' });
    expect(ok.body!.lines[0]).toBe(`… ${20 - TOOL_OUTPUT_MAX_LINES} earlier lines (ctrl+o to expand)`);
    expect(ok.body!.lines.at(-1)).toBe('out 19');

    const failed = buildToolBlock({ toolName: 'run_command', args: { command: 'npm test' }, result: 'Command exited with code 1\nOutput: 2 failed\nError: boom', isError: false });
    expect(failed).toMatchObject({ status: 'error', summary: 'Exit code 1' });
    expect(failed.body!.lines).toEqual(['2 failed', 'boom']);

    const quiet = buildToolBlock({ toolName: 'run_command', args: { command: 'true' }, result: '(no output)', isError: false });
    expect(quiet.summary).toBe('(no output)');
    expect(quiet.body).toBeUndefined();
  });

  it('reports failures by the first line of the error', () => {
    const block = buildToolBlock({ toolName: 'edit_file', args: { path: 'a.ts', old_string: 'x', new_string: 'y' }, result: 'Error: old_string not found in a.ts. Make sure…\nmore', isError: false });
    expect(block).toMatchObject({ status: 'error', summary: 'Error: old_string not found in a.ts. Make sure…' });
    expect(block.body).toBeUndefined();
    const thrown = buildToolBlock({ toolName: 'fetch_url', args: { url: 'https://x.dev' }, result: new Error('timeout'), isError: true });
    expect(thrown).toMatchObject({ status: 'error', summary: 'Error: timeout' });
  });

  it('skips tools that already have their own UI', () => {
    expect(isTranscriptTool('ask_user')).toBe(false);
    expect(isTranscriptTool('update_plan')).toBe(true);
    expect(isTranscriptTool('read_file')).toBe(true);
  });

  it('shows paths relative to the project root only when inside it', () => {
    expect(displayPath('/work/proj/a/b.ts', cwd)).toBe('a/b.ts');
    expect(displayPath('/work/proj', cwd)).toBe('.');
    expect(displayPath('/work/project2/x', cwd)).toBe('/work/project2/x');
  });

  it('renders as head, elbow summary, then excerpt rows', () => {
    const tool = buildToolBlock({ toolName: 'edit_file', args: { path: 'a.ts', old_string: 'a', new_string: 'b' }, result: 'ok', isError: false });
    const lines = buildMercuryMessageLines({ id: 't1', role: 'system', content: '', timestamp: 1, tool }, 80);
    expect(lines.map((l) => [l.kind, l.text, l.elbow ?? false])).toEqual([
      ['tool-head', 'Update', false],
      ['tool-out', '1 addition, 1 removal', true],
      ['tool-out', '-a', false],
      ['tool-out', '+b', false],
      ['spacer', '', false],
    ]);
    expect(lines[0].accent).toBe('a.ts');
    expect(lines[2].lang).toBe('diff');
  });

  it('truncates long output rows instead of wrapping and strips escapes', () => {
    const tool = buildToolBlock({ toolName: 'run_command', args: { command: 'cat x' }, result: `\x1b]0;title\x07${'y'.repeat(300)}`, isError: false });
    const lines = buildMercuryMessageLines({ id: 't2', role: 'system', content: '', timestamp: 1, tool }, 60);
    const out = lines.filter((l) => l.kind === 'tool-out' && !l.elbow);
    expect(out).toHaveLength(1);
    expect(out[0].text.endsWith('…')).toBe(true);
    expect(out[0].text).not.toContain('title');
    expect(out[0].text.length).toBeLessThanOrEqual(60);
  });

  it('shows plan updates as a checklist', () => {
    const block = buildToolBlock({ toolName: 'update_plan', args: { steps: [
      { label: 'Read auth module', status: 'done' },
      { label: 'Fix TTL', status: 'active' },
      { label: 'Run tests', status: 'pending' },
    ] }, result: 'Plan updated', isError: false });
    expect(block).toMatchObject({ title: 'Plan', target: '', summary: '1/3 done' });
    expect(block.body).toEqual({ lang: 'plan', lines: ['☒ Read auth module', '▶ Fix TTL', '☐ Run tests'] });
  });

  it('keeps the full excerpt only for collapsed blocks, on the side the excerpt shows', () => {
    const output = Array.from({ length: 20 }, (_, i) => `out ${i}`).join('\n');
    const cmd = buildToolBlockDetail({ toolName: 'run_command', args: { command: 'x' }, result: output, isError: false });
    expect(cmd.full).toEqual({ lang: '', lines: output.split('\n') });

    const small = buildToolBlockDetail({ toolName: 'run_command', args: { command: 'x' }, result: 'one', isError: false });
    expect(small.full).toBeUndefined();

    const huge = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n');
    const write = buildToolBlockDetail({ toolName: 'write_file', args: { path: 'a.txt', content: huge }, result: 'ok', isError: false });
    expect(write.full!.lines[0]).toBe('l0');
    const tail = buildToolBlockDetail({ toolName: 'run_command', args: { command: 'x' }, result: huge, isError: false });
    expect(tail.full!.lines.at(-1)).toBe('l2999');
  });
});
