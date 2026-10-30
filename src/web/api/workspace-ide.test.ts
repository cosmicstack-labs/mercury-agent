import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInsideWorkspace, isSafeRefName } from './workspace-ide.js';

/**
 * The IDE's git routes take file names, branch names and commit messages
 * from the request. They must never reach a shell, and paths must stay in
 * the workspace.
 */
describe('workspace and git hardening', () => {
  let home: string;
  let repo: string;
  const previous = process.env.MERCURY_HOME;

  // One home for the file: the module reads its settings path once at import.
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-ide-'));
    repo = join(home, 'project');
    mkdirSync(repo);
    process.env.MERCURY_HOME = home;
    writeFileSync(join(home, 'web-chat-settings.json'), JSON.stringify({ workspace: repo }));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.MERCURY_HOME;
    else process.env.MERCURY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it('containment is real, not a prefix match', () => {
    expect(isInsideWorkspace('src/a.ts', '/w/project')).toBe(true);
    expect(isInsideWorkspace('/w/project', '/w/project')).toBe(true);
    expect(isInsideWorkspace('../project-evil/x', '/w/project')).toBe(false);
    expect(isInsideWorkspace('/w/project-evil/x', '/w/project')).toBe(false);
    expect(isInsideWorkspace('../../etc/passwd', '/w/project')).toBe(false);
  });

  it('branch and remote names cannot be options or shell syntax', () => {
    expect(isSafeRefName('feat/desktop-app')).toBe(true);
    expect(isSafeRefName('origin')).toBe(true);
    for (const bad of ['-b', '--upload-pack=touch /tmp/x', 'a;rm -rf /', '$(id)', '`id`', 'a b', 'x..y', 'x@{1}', 'x.lock', '']) {
      expect(isSafeRefName(bad)).toBe(false);
    }
  });

  it('a file name with shell syntax is passed to git as a name, never run', async () => {
    const { default: ide } = await import('./workspace-ide.js');
    const marker = join(home, 'pwned');
    const evil = `a.txt$(touch ${marker})`;
    await ide.request(`http://127.0.0.1/api/git/diff?file=${encodeURIComponent(evil)}`);
    await ide.request('http://127.0.0.1/api/git/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: [evil] }) });
    expect(existsSync(marker)).toBe(false);
  });

  it('commit messages with quotes and $() are stored literally', async () => {
    const { default: ide } = await import('./workspace-ide.js');
    const marker = join(home, 'pwned-commit');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    const message = `say "hi" $(touch ${marker}) \`id\``;
    const res = await ide.request('http://127.0.0.1/api/git/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
    expect(res.status).toBe(200);
    expect(existsSync(marker)).toBe(false);
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(subject).toBe(message);
  });

  it('rejects an option-shaped branch and a path outside the workspace', async () => {
    const { default: ide } = await import('./workspace-ide.js');
    const checkout = await ide.request('http://127.0.0.1/api/git/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: '--orphan=x' }) });
    expect(checkout.status).toBe(400);
    const diff = await ide.request(`http://127.0.0.1/api/git/diff?file=${encodeURIComponent('../outside.txt')}`);
    expect(diff.status).toBe(403);
  });
});
