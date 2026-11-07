import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, relative, sep } from 'node:path';

/**
 * What counts as an artifact: a deliverable Mercury made for the owner,
 * worth keeping and showing (an image, a video, a PDF, a report), never a
 * by-product (code, config, caches, build output, a project's own assets).
 * Strict on purpose: a false artifact is noise in every chat.
 */

export type ArtifactKind = 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'text' | 'file';

const EXT: Record<string, Exclude<ArtifactKind, 'file'>> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', heic: 'image', avif: 'image', bmp: 'image', tiff: 'image', svg: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', m4v: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio', opus: 'audio',
  pdf: 'pdf',
  docx: 'document', doc: 'document', pptx: 'document', ppt: 'document', xlsx: 'document', xls: 'document', odt: 'document', ods: 'document', odp: 'document', key: 'document', pages: 'document', numbers: 'document', epub: 'document', csv: 'document',
  md: 'text', markdown: 'text', txt: 'text',
};

export const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', avif: 'image/avif', bmp: 'image/bmp', tiff: 'image/tiff', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', m4v: 'video/mp4', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip', csv: 'text/csv', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain',
};

export function extOf(path: string): string {
  return extname(path).slice(1).toLowerCase();
}

export function mimeOf(path: string): string {
  return MIME[extOf(path)] ?? 'application/octet-stream';
}

/** Folders whose contents are never artifacts: dependencies, build output, caches, VCS, Mercury's own state. */
const NEVER_UNDER = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache', 'cache', '__pycache__', '.venv', 'venv', 'coverage', '.idea', '.vscode', 'tmp', '.tmp', 'Library', 'DerivedData', 'Pods', '.gradle', 'vendor']);
/** Inside a project, these hold the project's own assets (a favicon, a logo), not deliverables. */
const PROJECT_ASSET_DIRS = new Set(['public', 'assets', 'static', 'src', 'app', 'lib', 'components', 'images', 'img', 'icons', 'fonts', 'res', 'resources', 'test', 'tests', '__tests__', 'fixtures', 'docs', 'packages', 'apps', 'examples', 'scripts', 'bin']);
/** Project files that are never deliverables even when written. */
const PROJECT_DOCS = /^(readme|changelog|changes|license|licence|contributing|code_of_conduct|security|authors|notice|todo|agents|claude|gemini|copilot-instructions|history|roadmap|decisions|architecture)(\.[a-z]+)?$/i;
/** Names that read like a deliverable written for the owner. */
const DELIVERABLE_NAME = /(report|research|summary|summar|notes|analysis|findings|brief|overview|comparison|compare|review|study|digest|proposal|outline|memo|article|guide|plan)/i;

export interface ClassifyContext {
  /** 'code' when the turn ran in Mercury Code (a project), else 'chat'. */
  surface: 'chat' | 'code';
  /** The project folder for Code turns (and the working folder otherwise). */
  cwd: string;
  /** Mercury's home (~/.mercury): its own files are never artifacts, except its artifact store. */
  mercuryHome: string;
  /** How the file reached the owner: 'sent' (send_file: always a deliverable), 'written' (a file tool), 'mentioned' (seen in a command's output). */
  how: 'sent' | 'written' | 'mentioned';
  /** The file is new in this turn (created, not an edit of an older file). */
  isNew: boolean;
  size: number;
}

/** A path's folders and name, whichever separator it was written with (Windows takes both). */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/** System temp folders: where generated media often lands before it's sent. */
const TEMP_ROOTS = [...new Set([tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'])];

function tempRoot(path: string): string | null {
  return TEMP_ROOTS.find((root) => inside(path, root)) ?? null;
}

/** The kind of artifact this file is, or null when it isn't one. */
export function classifyArtifact(path: string, ctx: ClassifyContext): ArtifactKind | null {
  const name = basename(path);
  const ext = extOf(path);
  const kind = EXT[ext];
  if (ctx.size <= 0 || ctx.size > 2 * 1024 ** 3) return null;
  if (name.startsWith('.') || name.startsWith('~$')) return null;
  // Folder rules apply below the system temp folder, not to it ("tmp" means a project's tmp/).
  const temp = tempRoot(path);
  const parts = segments(temp ? relative(temp, path) : path);
  if (parts.some((p) => NEVER_UNDER.has(p))) return null;
  if (inside(path, ctx.mercuryHome) && !inside(path, `${ctx.mercuryHome}${sep}artifacts`) && !inside(path, `${ctx.mercuryHome}${sep}workspace`) && !inside(path, `${ctx.mercuryHome}${sep}outputs`)) return null;

  // Sent to the owner on purpose: a deliverable, whatever its type (code files sent stay plain files).
  if (ctx.how === 'sent') return kind ?? 'file';
  if (!kind) return null;
  // An old file Mercury touched isn't something it made.
  if (!ctx.isNew) return null;
  if (kind === 'text') {
    if (ctx.size < 300) return null;
    if (PROJECT_DOCS.test(name)) return null;
  }
  // Seen only in a command's output: media and documents count, loose text doesn't.
  if (ctx.how === 'mentioned' && kind === 'text') return null;
  // Text in a temp folder is usually scratch (a scrape, a draft) unless it's named like a deliverable.
  if (temp && kind === 'text' && !DELIVERABLE_NAME.test(name)) return null;

  if (ctx.surface === 'code' && inside(path, ctx.cwd)) {
    // In a project, only a written-for-you report counts: a PDF, Markdown or text
    // deliverable at the root or in a reports/research folder, named like one.
    const rel = segments(relative(ctx.cwd, path));
    const top = rel.length > 1 ? rel[0].toLowerCase() : '';
    if (rel.some((p, i) => i < rel.length - 1 && PROJECT_ASSET_DIRS.has(p.toLowerCase()))) return null;
    const deliverableDir = top === '' || /^(reports?|research|notes|output|outputs|artifacts|deliverables)$/.test(top);
    if (!deliverableDir) return null;
    if (kind === 'pdf' || kind === 'text' || kind === 'document') return DELIVERABLE_NAME.test(name) ? kind : null;
    // Media at a project's root or reports folder is a project file unless it's clearly output.
    return top === '' ? null : kind;
  }
  if (kind === 'image' && ext === 'svg' && ctx.size < 2048) return null; // icons
  return kind;
}
