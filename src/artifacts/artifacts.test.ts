import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyArtifact, type ClassifyContext } from './classify.js';
import { ArtifactCollector, pathsIn } from './collector.js';
import { ArtifactStore } from './store.js';

const HOME = '/Users/me/.mercury';
const chat = (over: Partial<ClassifyContext> = {}): ClassifyContext => ({ surface: 'chat', cwd: '/Users/me', mercuryHome: HOME, how: 'written', isNew: true, size: 5000, ...over });
const code = (over: Partial<ClassifyContext> = {}): ClassifyContext => chat({ surface: 'code', cwd: '/Users/me/proj', ...over });

describe('what counts as an artifact', () => {
  it('chat: new media, PDFs, documents and real notes count', () => {
    expect(classifyArtifact('/Users/me/Desktop/chart.png', chat())).toBe('image');
    expect(classifyArtifact('/Users/me/Movies/teaser.mp4', chat())).toBe('video');
    expect(classifyArtifact('/Users/me/Documents/report.pdf', chat())).toBe('pdf');
    expect(classifyArtifact('/Users/me/Documents/deck.pptx', chat())).toBe('document');
    expect(classifyArtifact('/Users/me/notes/research.md', chat())).toBe('text');
  });

  it('never: code, config, edits of old files, tiny notes, hidden files, build or dependency folders, Mercury\'s own state', () => {
    expect(classifyArtifact('/Users/me/script.py', chat())).toBeNull();
    expect(classifyArtifact('/Users/me/config.json', chat())).toBeNull();
    expect(classifyArtifact('/Users/me/Documents/report.pdf', chat({ isNew: false }))).toBeNull();
    expect(classifyArtifact('/Users/me/todo.txt', chat({ size: 40 }))).toBeNull();
    expect(classifyArtifact('/Users/me/.hidden.png', chat())).toBeNull();
    expect(classifyArtifact('/Users/me/app/node_modules/x/logo.png', chat())).toBeNull();
    expect(classifyArtifact('/Users/me/app/dist/out.pdf', chat())).toBeNull();
    expect(classifyArtifact(`${HOME}/plugins/optimus/data/shot.png`, chat())).toBeNull();
    expect(classifyArtifact(`${HOME}/workspace/chart.png`, chat())).toBe('image');
    expect(classifyArtifact('/Users/me/icon.svg', chat({ size: 900 }))).toBeNull();
  });

  it('the system temp folder: generated media counts, scratch text and a project tmp/ don\'t', () => {
    expect(classifyArtifact('/tmp/generated-cat.png', chat())).toBe('image');
    expect(classifyArtifact(join(tmpdir(), 'mercury-gen', 'clip.mp4'), chat())).toBe('video');
    expect(classifyArtifact('/private/tmp/x/tea-research.md', chat())).toBe('text');
    expect(classifyArtifact('/tmp/page-dump.txt', chat())).toBeNull();
    expect(classifyArtifact('/tmp/build/out.png', chat())).toBeNull();
    expect(classifyArtifact('/Users/me/app/tmp/render.png', chat())).toBeNull();
  });

  it('code: project files never count, written-for-you reports do', () => {
    expect(classifyArtifact('/Users/me/proj/src/index.ts', code())).toBeNull();
    expect(classifyArtifact('/Users/me/proj/public/logo.png', code())).toBeNull();
    expect(classifyArtifact('/Users/me/proj/README.md', code())).toBeNull();
    expect(classifyArtifact('/Users/me/proj/docs/api.md', code())).toBeNull();
    expect(classifyArtifact('/Users/me/proj/notes.md', code())).toBe('text');
    expect(classifyArtifact('/Users/me/proj/CHANGELOG.md', code())).toBeNull();
    expect(classifyArtifact('/Users/me/proj/research/perf-analysis.md', code())).toBe('text');
    expect(classifyArtifact('/Users/me/proj/security-report.pdf', code())).toBe('pdf');
    expect(classifyArtifact('/Users/me/proj/screenshot.png', code())).toBeNull();
    expect(classifyArtifact('/Users/me/Desktop/benchmark-chart.png', code())).toBe('image');
  });

  it('sent to the owner always counts; seen in output, loose text doesn\'t', () => {
    expect(classifyArtifact('/Users/me/proj/src/index.ts', code({ how: 'sent', isNew: false }))).toBe('file');
    expect(classifyArtifact('/Users/me/Documents/old.pdf', chat({ how: 'sent', isNew: false }))).toBe('pdf');
    expect(classifyArtifact('/Users/me/out/log.txt', chat({ how: 'mentioned' }))).toBeNull();
    expect(classifyArtifact('/Users/me/Movies/clip.mp4', chat({ how: 'mentioned' }))).toBe('video');
    expect(classifyArtifact('/Users/me/app/out/clip.mp4', chat({ how: 'mentioned' }))).toBeNull(); // build output
  });

  it('finds paths in commands and output, quoted, escaped or relative', () => {
    const found = pathsIn('ffmpeg -i in.mov -vf scale=1280:-1 "/Users/me/Movies/My Clip.mp4" && echo saved ./out/chart.png; cat x.ts', '/Users/me', { relative: true });
    // resolve(): on Windows these come back with the current drive in front.
    expect(found).toContain(resolve('/Users/me/Movies/My Clip.mp4'));
    expect(found).toContain(resolve('/Users/me/out/chart.png'));
    expect(found.some((p) => p.endsWith('x.ts'))).toBe(false);
    expect(found).not.toContain(resolve('/out/chart.png'));
  });

  it.runIf(process.platform === 'win32')('finds Windows paths in command output', () => {
    const found = pathsIn('Saved chart to C:\\Users\\me\\Desktop\\chart.png and "D:\\Videos\\My Clip.mp4"', 'C:\\Users\\me', { relative: false });
    expect(found).toContain('C:\\Users\\me\\Desktop\\chart.png');
    expect(found).toContain('D:\\Videos\\My Clip.mp4');
  });
});

describe('collecting a turn\'s artifacts', () => {
  it('keeps what the turn made, skips old files and code, and deletes with the thread', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercury-art-'));
    const work = join(root, 'work');
    mkdirSync(work);
    const old = join(work, 'old-report.pdf');
    writeFileSync(old, 'x'.repeat(2000));
    const past = (Date.now() - 3_600_000) / 1000;
    utimesSync(old, past, past);
    const store = new ArtifactStore(join(root, 'mercury', 'artifacts'));
    const c = new ArtifactCollector({ startedAt: Date.now() - 1000, cwd: work, surface: 'chat', mercuryHome: join(root, 'mercury') });
    writeFileSync(join(work, 'chart.png'), Buffer.alloc(4000, 1));
    writeFileSync(join(work, 'research-notes.md'), '# Notes\n' + 'finding '.repeat(80));
    writeFileSync(join(work, 'helper.py'), 'print(1)\n'.repeat(50));
    c.observe('create_file', { path: 'research-notes.md' }, 'Created research-notes.md');
    c.observe('write_file', { path: 'helper.py' }, 'ok');
    c.observe('run_command', { command: 'python helper.py' }, `Saved chart to ${join(work, 'chart.png')}\nAlso see ${old}`);
    const kept = c.finalize('thread-1', store);
    expect(kept.map((a) => a.name).sort()).toEqual(['chart.png', 'research-notes.md']);
    const list = store.list({ threadId: 'thread-1' });
    expect(list.counts).toMatchObject({ all: 2, image: 1, text: 1 });
    expect(store.list({ kind: 'image' }).items[0].name).toBe('chart.png');
    expect(store.removeThread('thread-1')).toBe(2);
    expect(store.list().items).toHaveLength(0);
  });

  it('pages newest first and sweeps threads that no longer exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercury-art-'));
    const store = new ArtifactStore(join(root, 'artifacts'));
    for (let i = 0; i < 5; i++) {
      const f = join(root, `img-${i}.png`);
      writeFileSync(f, Buffer.alloc(100 + i, 1));
      store.add({ threadId: i < 3 ? 'keep' : 'gone', path: f, kind: 'image' }, 1000 + i);
    }
    const p1 = store.list({ limit: 2 });
    expect(p1.items.map((a) => a.name)).toEqual(['img-4.png', 'img-3.png']);
    const p2 = store.list({ limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((a) => a.name)).toEqual(['img-2.png', 'img-1.png']);
    expect(store.reconcile((id) => id === 'keep')).toBe(2);
    expect(store.list().counts.all).toBe(3);
  });
});
