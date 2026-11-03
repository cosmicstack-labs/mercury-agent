import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-tidy-'));
  process.env.MERCURY_HOME = path.join(dir, '.mercury');
  process.env.HOME = dir;
  process.env.USERPROFILE = dir; // os.homedir() on Windows
  return dir;
});

import artifacts, { setArtifactOutputDir } from './artifacts.js';
import { artifactStore } from '../../artifacts/store.js';

const local = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

describe('tidying loose files into the output folder', () => {
  it('lists only what Mercury made in the home folder, and moves each into its chat folder', async () => {
    setArtifactOutputDir(() => undefined);
    const loose = join(home, 'how-to-programming-research.md');
    writeFileSync(loose, '# Report');
    mkdirSync(join(home, 'Projects'), { recursive: true });
    const nested = join(home, 'Projects', 'kept.md');
    writeFileSync(nested, 'x');
    writeFileSync(join(home, 'factorial.ts'), 'not Mercury’s'); // not an artifact: never touched
    const a = artifactStore().add({ threadId: 't1', path: loose, kind: 'text' });
    artifactStore().add({ threadId: 't2', path: nested, kind: 'text' });

    const info = (await (await artifacts.request('http://127.0.0.1/api/artifacts/folder')).json()) as { path: string; strays: Array<{ id: string; name: string }> };
    expect(info.path).toBe(join(home, 'mercury-artifacts'));
    expect(info.strays.map((s) => s.name)).toEqual(['how-to-programming-research.md']);

    const remote = await artifacts.request('http://127.0.0.1/api/artifacts/folder/tidy', { method: 'POST' }, { incoming: { socket: { remoteAddress: '10.0.0.9' } } });
    expect(remote.status).toBe(403);

    const res = (await (await artifacts.request('http://127.0.0.1/api/artifacts/folder/tidy', { method: 'POST' }, local)).json()) as { moved: Array<{ to: string }>; failed: unknown[] };
    expect(res.failed).toEqual([]);
    expect(res.moved).toHaveLength(1);
    const to = res.moved[0].to;
    expect(to.startsWith(join(home, 'mercury-artifacts', 'Chats'))).toBe(true);
    expect(to.endsWith('how-to-programming-research.md')).toBe(true);
    expect(readFileSync(to, 'utf-8')).toBe('# Report');
    expect(existsSync(loose)).toBe(false);
    expect(existsSync(join(home, 'factorial.ts'))).toBe(true);
    expect(existsSync(nested)).toBe(true);
    // Show in Finder still finds it.
    expect(artifactStore().get(a.id)?.originalPath).toBe(to);
    const again = (await (await artifacts.request('http://127.0.0.1/api/artifacts/folder')).json()) as { strays: unknown[] };
    expect(again.strays).toEqual([]);
  });
});
