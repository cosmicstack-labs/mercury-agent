import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { classifyArtifact, extOf } from './classify.js';
import type { Artifact, ArtifactStore } from './store.js';

/**
 * Watches one turn for files that might be artifacts, then keeps the ones
 * that are. Candidates come from:
 *   send_file                  sent to the owner: always a deliverable
 *   write_file / create_file   written by Mercury
 *   run_command, other tools   paths in the command or its output that were
 *                              made during this turn (ffmpeg, a chart script,
 *                              an image plugin)
 * Nothing is decided until the turn ends: a file written then deleted, or
 * overwritten by a later step, is judged by what's on disk at the end.
 */

const ARTIFACT_EXT = 'png|jpe?g|gif|webp|heic|avif|bmp|tiff|svg|mp4|mov|webm|mkv|m4v|avi|mp3|wav|m4a|ogg|flac|aac|opus|pdf|docx?|pptx?|xlsx?|odt|ods|odp|key|pages|numbers|epub|csv|md|markdown|txt';
// An absolute path (/…, ~/…, or C:\… on Windows) starts a token (after a space, quote, = or bracket), never mid-word ("./out/x.png" isn't "/out/x.png").
const ABS_PATH = new RegExp(`(?<=^|[\\s'"=(:\\[])(?:~|/|[A-Za-z]:[\\\\/])(?:[^\\s'"\`<>|;,()\\[\\]{}]|\\\\ )+\\.(?:${ARTIFACT_EXT})(?=$|[\\s'"\`<>|;,()\\]\\[.:!?])`, 'gi');
/** Quoted paths may contain spaces: "/Users/me/Movies/My Clip.mp4". Windows drive paths (C:\…) count too. */
const QUOTED_PATH = new RegExp(`(["'])((?:~|/|[A-Za-z]:[\\\\/])[^"'\\n]+?\\.(?:${ARTIFACT_EXT}))\\1`, 'gi');
const REL_PATH = new RegExp(`(?:^|[\\s'"=])((?:\\./)?[\\w@][\\w.@/-]*\\.(?:${ARTIFACT_EXT}))(?=$|[\\s'"\`;,)])`, 'gi');

type How = 'sent' | 'written' | 'mentioned';
const RANK: Record<How, number> = { sent: 3, written: 2, mentioned: 1 };

export interface TurnContext {
  startedAt: number;
  cwd: string;
  surface: 'chat' | 'code';
  mercuryHome: string;
}

function expand(p: string, cwd: string): string {
  const unescaped = p.replace(/\\ /g, ' ');
  if (unescaped.startsWith('~/')) return join(homedir(), unescaped.slice(2));
  return isAbsolute(unescaped) ? resolve(unescaped) : resolve(cwd, unescaped);
}

/** Paths with artifact extensions in free text (a command line or a tool's output). */
export function pathsIn(text: string, cwd: string, opts: { relative: boolean }): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(QUOTED_PATH)) out.add(expand(m[2], cwd));
  for (const m of text.matchAll(ABS_PATH)) out.add(expand(m[0], cwd));
  if (opts.relative) for (const m of text.matchAll(REL_PATH)) out.add(expand(m[1], cwd));
  return [...out].slice(0, 40);
}

export class ArtifactCollector {
  private candidates = new Map<string, { how: How; tool: string }>();
  constructor(private readonly ctx: TurnContext) {}

  private add(path: string, how: How, tool: string): void {
    if (!path || !extOf(path) && how !== 'sent') return;
    const prev = this.candidates.get(path);
    if (!prev || RANK[how] > RANK[prev.how]) this.candidates.set(path, { how, tool });
  }

  observe(tool: string, input: unknown, result: unknown, cwd = this.ctx.cwd): void {
    try {
      const args = (input ?? {}) as Record<string, unknown>;
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
      if (tool === 'send_file' && typeof args.path === 'string') this.add(expand(args.path, cwd), 'sent', tool);
      else if ((tool === 'write_file' || tool === 'create_file') && typeof args.path === 'string') {
        if (!/^(Error|⚠)/.test(text.trim())) this.add(expand(args.path, cwd), 'written', tool);
      } else if (tool === 'run_command') {
        const cmd = typeof args.command === 'string' ? args.command : '';
        for (const p of pathsIn(`${cmd}\n${text.slice(0, 20_000)}`, cwd, { relative: true })) this.add(p, 'mentioned', tool);
      } else if (!/^(read_file|list_dir|edit_file|delete_file|git_|web_search|fetch_url|search_memory|save_memory)/.test(tool)) {
        // Plugins and MCP servers (an image generator, a screen recorder): absolute paths in what they return.
        for (const p of pathsIn(text.slice(0, 20_000), cwd, { relative: false })) this.add(p, 'mentioned', tool);
      }
    } catch { /* watching must never break a turn */ }
  }

  get size(): number {
    return this.candidates.size;
  }

  /** Judge every candidate as it is now, keep the artifacts in the store, and return them. */
  finalize(threadId: string, store: ArtifactStore): Artifact[] {
    const kept: Artifact[] = [];
    const seen = new Set<string>();
    const since = this.ctx.startedAt - 2000;
    for (const [path, { how, tool }] of this.candidates) {
      try {
        if (!existsSync(path)) continue;
        const real = realpathSync(path);
        if (seen.has(real)) continue;
        seen.add(real);
        const st = statSync(real);
        if (!st.isFile()) continue;
        // "New in this turn": created now (birth time where the disk keeps it), else changed now.
        const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
        const isNew = born >= since;
        if (how === 'mentioned' && st.mtimeMs < since) continue;
        const kind = classifyArtifact(real, { surface: this.ctx.surface, cwd: this.ctx.cwd, mercuryHome: this.ctx.mercuryHome, how, isNew, size: st.size });
        if (!kind) continue;
        kept.push(store.add({ threadId, path: real, kind, tool, surface: this.ctx.surface }));
      } catch { /* one bad candidate never loses the others */ }
    }
    return kept;
  }
}
