import { describe, expect, it } from 'vitest';
import { summarizeSilentTurn } from './silent-turn.js';

/** A turn that ends on tool calls says what it did — never "(no text response)". */
describe('summarizeSilentTurn', () => {
  it('lists files written and edited and commands with their result', () => {
    const text = summarizeSilentTurn([
      { tool: 'list_dir', input: { path: '.' }, ok: true },
      { tool: 'create_file', input: { path: 'src/index.html' }, ok: true },
      { tool: 'write_file', input: { path: '/abs/styles.css' }, ok: true },
      { tool: 'edit_file', input: { path: 'src/app.ts' }, ok: true },
      { tool: 'edit_file', input: { path: 'src/index.html' }, ok: true },
      { tool: 'run_command', input: { command: 'npm test' }, ok: true },
    ]);
    expect(text).toBe([
      "Done. Here's what I did:",
      '- Wrote `index.html`, `styles.css`',
      '- Edited `app.ts`',
      '- Ran `npm test` — succeeded',
    ].join('\n'));
  });

  it('says honestly when something failed, and a later success clears an earlier failure', () => {
    const text = summarizeSilentTurn([
      { tool: 'run_command', input: { command: 'npm test' }, ok: false },
      { tool: 'edit_file', input: { path: 'a.ts' }, ok: false },
      { tool: 'edit_file', input: { path: 'a.ts' }, ok: true },
      { tool: 'write_file', input: { path: 'b.ts' }, ok: false },
    ]);
    expect(text).toMatch(/^Here's what I did — not everything succeeded:/);
    expect(text).toContain('- Edited `a.ts`');
    expect(text).toContain("- Couldn't change `b.ts`");
    expect(text).toContain('- Ran `npm test` — failed');
  });

  it('a command that failed and then passed counts as passed', () => {
    const text = summarizeSilentTurn([
      { tool: 'run_command', input: { command: 'npm   test' }, ok: false },
      { tool: 'run_command', input: { command: 'npm test' }, ok: true },
    ]);
    expect(text).toBe("Done. Here's what I did:\n- Ran `npm test` — succeeded");
  });

  it('caps long lists', () => {
    const files = Array.from({ length: 9 }, (_, i) => ({ tool: 'create_file', input: { path: `f${i}.ts` }, ok: true }));
    expect(summarizeSilentTurn(files)).toContain('and 3 more');
  });

  it('only looked around, or did other things, or nothing at all: still a real sentence', () => {
    expect(summarizeSilentTurn([{ tool: 'read_file', input: { path: 'a' }, ok: true }])).toContain('Looked through 1 file');
    expect(summarizeSilentTurn([{ tool: 'fetch_url', input: { url: 'x' }, ok: true }])).toMatch(/^I finished 1 step/);
    expect(summarizeSilentTurn([])).toMatch(/^I didn't get a written answer/);
    for (const t of [summarizeSilentTurn([]), summarizeSilentTurn([{ tool: 'x', input: {}, ok: true }])]) {
      expect(t).not.toContain('(no text response)');
    }
  });
});
