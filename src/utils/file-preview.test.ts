import { describe, expect, it } from 'vitest';
import {
  buildFileChangePreview,
  fenceLangForPath,
  FILE_CHANGE_TOOLS,
} from './file-preview.js';
import { buildMercuryMessageLines } from '../ui/mercury-transcript.js';

describe('file-change preview builder', () => {
  it('previews a created file with its fence language and line count', () => {
    const preview = buildFileChangePreview({
      toolName: 'create_file',
      args: { path: 'src/components/App.tsx', content: 'const a = 1;\nconst b = 2;' },
      resultText: 'Success: file created',
      ok: true,
    })!;
    expect(preview).toContain('Created `components/App.tsx`');
    expect(preview).toContain('2 lines');
    expect(preview).toContain('```tsx');
    expect(preview).toContain('const a = 1;');
  });

  it('bounds large files to a head excerpt with an omission note', () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const preview = buildFileChangePreview({
      toolName: 'write_file',
      args: { path: 'big.py', content },
      resultText: 'Success',
      ok: true,
    })!;
    expect(preview).toContain('200 lines');
    expect(preview).toContain('line 47');
    expect(preview).not.toContain('line 48\n');
    expect(preview).toContain('more lines (full content on disk)');
  });

  it('previews edits as a bounded diff with +/− stats', () => {
    const preview = buildFileChangePreview({
      toolName: 'edit_file',
      args: { path: 'src/app.ts', old_string: 'const x = 1;', new_string: 'const x = 2;\nconst y = 3;' },
      resultText: 'Success',
      ok: true,
    })!;
    expect(preview).toContain('Edited `src/app.ts` · +2 −1');
    expect(preview).toContain('```diff');
    expect(preview).toContain('-const x = 1;');
    expect(preview).toContain('+const x = 2;');
  });

  it('skips failures, non-file tools, and contentless calls', () => {
    const base = { args: { path: 'a.ts', content: 'x' }, resultText: 'Success' };
    expect(buildFileChangePreview({ ...base, toolName: 'write_file', ok: false })).toBeNull();
    expect(buildFileChangePreview({ toolName: 'write_file', args: { path: 'a.ts', content: 'x' }, resultText: 'Error: permission denied', ok: true })).toBeNull();
    expect(buildFileChangePreview({ toolName: 'run_command', args: { path: 'a.ts', content: 'x' }, resultText: 'ok', ok: true })).toBeNull();
    expect(buildFileChangePreview({ toolName: 'write_file', args: { path: 'a.ts', content: '' }, resultText: 'ok', ok: true })).toBeNull();
    expect(buildFileChangePreview({ toolName: 'write_file', args: { content: 'x' }, resultText: 'ok', ok: true })).toBeNull();
  });

  it('delete gets a one-liner, not a code block', () => {
    const preview = buildFileChangePreview({
      toolName: 'delete_file',
      args: { path: 'old/thing.js' },
      resultText: 'Success',
      ok: true,
    })!;
    expect(preview).toContain('Deleted');
    expect(preview).not.toContain('```');
  });

  it('maps fence languages from extensions', () => {
    expect(fenceLangForPath('a.ts')).toBe('ts');
    expect(fenceLangForPath('b.py')).toBe('python');
    expect(fenceLangForPath('Dockerfile')).toBe('');
  });

  it('covers exactly the mutating file tools', () => {
    expect([...FILE_CHANGE_TOOLS].sort()).toEqual(['create_file', 'delete_file', 'edit_file', 'write_file']);
  });
});

describe('transcript renders previews with highlighting metadata', () => {
  it('system messages with fenced diffs produce highlighted code rows', () => {
    const msg = {
      id: 'f1',
      role: 'system' as const,
      content: ['✎ Edited `app.ts` · +1 −1', '', '```diff', '-const x = 1;', '+const x = 2;', '```'].join('\n'),
      timestamp: 1,
    };
    const lines = buildMercuryMessageLines(msg as any, 80);
    // No header row for system messages, but the fence IS parsed: a
    // code-label row for DIFF followed by code rows carrying the lang.
    expect(lines.some((l) => l.kind === 'code-label' && l.text === 'DIFF')).toBe(true);
    const codeRows = lines.filter((l) => l.kind === 'code' && l.lang === 'diff');
    expect(codeRows.map((r) => r.text)).toEqual(['-const x = 1;', '+const x = 2;']);
    expect(lines.some((l) => l.kind === 'header')).toBe(false);
  });

  it('system prose still renders without fences', () => {
    const msg = { id: 'f2', role: 'system' as const, content: 'plain system note', timestamp: 1 };
    const lines = buildMercuryMessageLines(msg as any, 80);
    expect(lines.some((l) => l.kind === 'system' && l.text === 'plain system note')).toBe(true);
  });
});