import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatFolders, folderLabel, freeName, outputRoot } from './output-dir.js';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'outdir-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const NOV2 = new Date(2026, 10, 2, 22, 0).getTime();

describe('the output folder', () => {
  it('is ~/mercury-artifacts unless set to an absolute or ~ path', () => {
    expect(outputRoot()).toBe(join(homedir(), 'mercury-artifacts'));
    expect(outputRoot('~/Work/Mercury')).toBe(join(homedir(), 'Work', 'Mercury'));
    expect(outputRoot('/Volumes/data/out/')).toBe(resolve('/Volumes/data/out'));
    expect(outputRoot('relative/dir')).toBe(join(homedir(), 'mercury-artifacts'));
  });

  it('names folders like a person would, safely', () => {
    expect(folderLabel('How to become rich?')).toBe('How to become rich');
    expect(folderLabel('/research solar storms: a/b <c>')).toBe('solar storms a b c');
    expect(folderLabel('...')).toBe('Chat');
    expect(folderLabel('word '.repeat(30)).length).toBeLessThanOrEqual(48);
    expect(folderLabel('a\u0000b\nc')).toBe('a b c');
  });

  it('gives each chat one folder, named once, never reused by another chat', () => {
    const root = tmp();
    const index = join(tmp(), 'index.json');
    const f = new ChatFolders(root, index);
    const a = f.pathFor('s1', 'How to become rich', NOV2);
    expect(a).toBe(join(root, 'Chats', '2026-11-02 How to become rich'));
    // A new title later doesn't move it.
    expect(f.pathFor('s1', 'Wealth building guide', NOV2 + 3600_000)).toBe(a);
    // Another chat with the same words gets its own.
    expect(f.pathFor('s2', 'How to become rich', NOV2)).toBe(`${a} (2)`);
    // The names survive a restart.
    expect(new ChatFolders(root, index).pathFor('s1', 'x', 0)).toBe(a);
  });

  it('exists only while it holds something', () => {
    const root = tmp();
    const f = new ChatFolders(root, join(tmp(), 'index.json'));
    const empty = f.open('s1', 'nothing made', NOV2);
    expect(existsSync(empty)).toBe(true);
    f.close(empty);
    expect(existsSync(empty)).toBe(false);
    expect(existsSync(join(root, 'Chats'))).toBe(false);
    const used = f.open('s2', 'made a file', NOV2);
    writeFileSync(join(used, 'notes.md'), '# hi');
    f.close(used);
    expect(readdirSync(used)).toEqual(['notes.md']);
    // Finder's .DS_Store alone is still empty.
    const finder = f.open('s3', 'finder looked', NOV2);
    writeFileSync(join(finder, '.DS_Store'), '');
    f.close(finder);
    expect(existsSync(finder)).toBe(false);
    // Never anything outside the output folder.
    const outside = tmp();
    mkdirSync(join(outside, 'x'));
    f.close(join(outside, 'x'));
    expect(existsSync(join(outside, 'x'))).toBe(true);
  });

  it('finds a free file name', () => {
    const d = tmp();
    writeFileSync(join(d, 'r.md'), '');
    writeFileSync(join(d, 'r (2).md'), '');
    expect(freeName(d, 'r.md')).toBe('r (3).md');
    expect(freeName(d, 'new.md')).toBe('new.md');
  });
});
