import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

/**
 * Where the files Mercury makes go: one visible folder in your home folder,
 * `~/mercury-artifacts` (or `artifacts.outputDir`), instead of loose files
 * in `~` (the daemon's working folder).
 *
 *   ~/mercury-artifacts/
 *     Research/                               research reports
 *     Chats/2026-11-02 How to become rich/    what that chat made
 *
 * A chat's folder is named once (its date and title, or its first words) and
 * keeps that name, so a renamed chat never moves files you already opened.
 * It exists only while it holds something: made at the start of a turn,
 * removed again if the turn left it empty.
 */

export const DEFAULT_OUTPUT_DIR = '~/mercury-artifacts';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** The output folder, absolute. A relative or unusable setting falls back to the default. */
export function outputRoot(setting?: string | null): string {
  const raw = (setting ?? '').trim();
  const p = raw ? expandHome(raw) : expandHome(DEFAULT_OUTPUT_DIR);
  return isAbsolute(p) ? resolve(p) : expandHome(DEFAULT_OUTPUT_DIR);
}

export function researchDir(root: string): string {
  return join(root, 'Research');
}

/** A chat's label as a folder name: no path or reserved characters, short, never empty. */
export function folderLabel(text: string, max = 48): string {
  const clean = text
    .replace(/^\/\S+\s*/, '') // "/research …" is about the rest
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, ' ')
    .replace(/[^\P{C}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let label = clean;
  if (label.length > max) {
    label = label.slice(0, max);
    const space = label.lastIndexOf(' ');
    if (space > max * 0.6) label = label.slice(0, space);
  }
  label = label.replace(/^[.\s]+|[.\s]+$/g, '');
  return label || 'Chat';
}

const day = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export class ChatFolders {
  private map: Record<string, string> | null = null;

  /** `index` is Mercury's own record of which chat has which folder (kept in ~/.mercury, not in the output folder). */
  constructor(readonly root: string, private readonly index: string) {}

  private load(): Record<string, string> {
    if (this.map) return this.map;
    try { this.map = existsSync(this.index) ? JSON.parse(readFileSync(this.index, 'utf-8')) as Record<string, string> : {}; } catch { this.map = {}; }
    return this.map!;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.index), { recursive: true });
      const tmp = `${this.index}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.map ?? {}), 'utf-8');
      renameSync(tmp, this.index);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Chat folders: saving the index failed');
    }
  }

  /** The folder for a chat (not created). `label` names it the first time; later calls keep that name. */
  pathFor(sessionId: string, label: string, createdAt: number): string {
    const map = this.load();
    const known = map[sessionId];
    if (known) return join(this.root, 'Chats', known);
    const taken = new Set(Object.values(map));
    const base = `${day(createdAt)} ${folderLabel(label)}`;
    let name = base;
    for (let n = 2; taken.has(name) || existsSync(join(this.root, 'Chats', name)); n++) name = `${base} (${n})`;
    map[sessionId] = name;
    this.save();
    return join(this.root, 'Chats', name);
  }

  /** Make it for a turn. */
  open(sessionId: string, label: string, createdAt: number): string {
    const dir = this.pathFor(sessionId, label, createdAt);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The turn ended: an empty folder goes (and Chats/ too, if that leaves it empty). */
  close(dir: string): void {
    for (const d of [dir, dirname(dir)]) {
      try {
        if (!d.startsWith(this.root) || d === this.root) return;
        // Only Finder's .DS_Store left counts as empty.
        if (readdirSync(d).some((f) => f !== '.DS_Store')) return;
        try { rmSync(d, { recursive: true }); } catch { /* a race: leave it */ }
      } catch { return; }
    }
  }

  /** The folder name a chat has (for tests and the apps). */
  nameOf(sessionId: string): string | undefined {
    const known = this.load()[sessionId];
    return known ? basename(known) : undefined;
  }
}

let shared: ChatFolders | null = null;
/** The one ChatFolders for an output folder (the agent and the API share its index). */
export function chatFoldersFor(root: string): ChatFolders {
  if (shared?.root !== root) shared = new ChatFolders(root, join(getMercuryHome(), 'artifacts', 'chat-folders.json'));
  return shared;
}

/** A free name for `name` in `dir`: "report.md", then "report (2).md"… */
export function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) if (!existsSync(join(dir, `${stem} (${n})${ext}`))) return `${stem} (${n})${ext}`;
}
