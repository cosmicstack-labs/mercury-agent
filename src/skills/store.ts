/**
 * Local skill store. Owns the on-disk layout under <install-root>/<category>/<slug>/SKILL.md
 * and the JSON index that tracks installed versions.
 *
 * Contract:
 *   - All writes are atomic (tmp file + rename).
 *   - All paths are constrained under install-root; ids are validated against the
 *     "<category-slug>/<skill-slug>" regex; we NEVER trust a remote-supplied path.
 *   - The index file (.index.json) is the source of truth for `list` and `update`.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { logger } from '../utils/logger.js';
import {
  RegistryClient,
  RegistryError,
  assertValidSkillId,
  isValidSkillId,
  type RegistrySkillDetail,
} from './registry.js';

export const SKILL_FILENAME = 'SKILL.md';
export const INDEX_FILENAME = '.index.json';
export const INDEX_VERSION = 1;

export interface InstalledSkillEntry {
  version: string;
  installedAt: string;        // ISO-8601
  source: string;             // registry URL or "file:..." / "url:..."
  etag?: string;
  title?: string;
  description?: string;
  category?: string;
}

export interface SkillsIndex {
  version: number;
  skills: Record<string, InstalledSkillEntry>;
}

export interface InstallResult {
  id: string;
  version: string;
  path: string;
  status: 'installed' | 'updated' | 'already-installed' | 'reinstalled';
  previousVersion?: string;
}

export interface SkillStoreOptions {
  installRoot?: string;
  registry?: RegistryClient;
}

function emptyIndex(): SkillsIndex {
  return { version: INDEX_VERSION, skills: {} };
}

export class SkillStore {
  readonly installRoot: string;
  private readonly indexPath: string;
  private readonly registry: RegistryClient | undefined;

  constructor(opts: SkillStoreOptions = {}) {
    this.installRoot = opts.installRoot || join(homedir(), '.mercury', 'skills');
    this.indexPath = join(this.installRoot, INDEX_FILENAME);
    this.registry = opts.registry;
  }

  // ---------- Index ----------

  readIndex(): SkillsIndex {
    if (!existsSync(this.indexPath)) return emptyIndex();
    try {
      const raw = readFileSync(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as SkillsIndex;
      if (!parsed || typeof parsed !== 'object' || !parsed.skills) return emptyIndex();
      if (parsed.version !== INDEX_VERSION) {
        logger.warn({ have: parsed.version, want: INDEX_VERSION }, 'skills index version mismatch; treating as empty');
        return emptyIndex();
      }
      return parsed;
    } catch (err) {
      logger.warn({ err }, 'failed to parse skills index; starting fresh');
      return emptyIndex();
    }
  }

  private writeIndex(index: SkillsIndex): void {
    this.ensureRoot();
    atomicWriteFile(this.indexPath, JSON.stringify(index, null, 2));
  }

  list(): Array<{ id: string } & InstalledSkillEntry> {
    const index = this.readIndex();
    return Object.entries(index.skills)
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  isInstalled(id: string): boolean {
    return !!this.readIndex().skills[id];
  }

  // ---------- Paths (with traversal guard) ----------

  pathFor(id: string): string {
    assertValidSkillId(id);
    const full = resolve(this.installRoot, id, SKILL_FILENAME);
    const root = resolve(this.installRoot);
    const rel = relative(root, full);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      throw new RegistryError(`Refusing to write outside install root: ${id}`, undefined, id);
    }
    return full;
  }

  // ---------- Install / Remove ----------

  /**
   * Install a single skill from the registry.
   *
   *   - force=false + same version: returns { status: "already-installed" }
   *   - force=true: always re-download
   */
  async install(
    id: string,
    opts: { force?: boolean; registry?: RegistryClient } = {},
  ): Promise<InstallResult> {
    assertValidSkillId(id);
    const registry = opts.registry || this.registry;
    if (!registry) throw new Error('SkillStore.install requires a RegistryClient');

    const detail = await registry.getSkill(id);
    const desired = detail.version || '0.0.0';
    const index = this.readIndex();
    const existing = index.skills[id];

    if (existing && existing.version === desired && !opts.force) {
      return {
        id,
        version: desired,
        path: this.pathFor(id),
        status: 'already-installed',
        previousVersion: existing.version,
      };
    }

    const { body, etag } = await registry.fetchSkillMarkdown(id);
    // Verify frontmatter parses and contains required fields
    this.verifyBody(body, id);

    const target = this.pathFor(id);
    const previousBody = existing && existsSync(target) ? readFileSync(target, 'utf-8') : null;

    mkdirSync(dirname(target), { recursive: true });
    atomicWriteFile(target, body);

    // Verification read — defend against disk-full / TOCTOU
    const verify = readFileSync(target, 'utf-8');
    if (verify !== body) {
      // Roll back
      if (previousBody != null) {
        atomicWriteFile(target, previousBody);
      } else {
        try { unlinkSync(target); } catch { /* ignore */ }
      }
      throw new Error(`Post-install verification failed for ${id} (disk write mismatch)`);
    }

    const entry: InstalledSkillEntry = {
      version: desired,
      installedAt: new Date().toISOString(),
      source: registry.registryUrl,
      etag,
      title: detail.title,
      description: detail.description,
      category: detail.category,
    };

    try {
      index.skills[id] = entry;
      this.writeIndex(index);
    } catch (err) {
      // Roll back the file write — index is the source of truth, we must keep them consistent
      if (previousBody != null) {
        try { atomicWriteFile(target, previousBody); } catch { /* ignore */ }
      } else {
        try { unlinkSync(target); } catch { /* ignore */ }
      }
      throw err;
    }

    return {
      id,
      version: desired,
      path: target,
      status: existing ? (opts.force ? 'reinstalled' : 'updated') : 'installed',
      previousVersion: existing?.version,
    };
  }

  /** Install from a raw SKILL.md body fetched out-of-band (e.g. --from). */
  installFromBody(
    body: string,
    opts: { id?: string; source: string },
  ): InstallResult {
    this.verifyBody(body, opts.id || '<from>');
    const meta = parseFrontmatter(body);
    const id = opts.id || meta.id;
    if (!id) {
      throw new RegistryError(
        'Cannot determine skill id from SKILL.md frontmatter. Add `id: <category>/<slug>` or pass an explicit id.',
      );
    }
    assertValidSkillId(id);
    const target = this.pathFor(id);
    const index = this.readIndex();
    const existing = index.skills[id];
    const previousBody = existing && existsSync(target) ? readFileSync(target, 'utf-8') : null;

    mkdirSync(dirname(target), { recursive: true });
    atomicWriteFile(target, body);
    const verify = readFileSync(target, 'utf-8');
    if (verify !== body) {
      if (previousBody != null) atomicWriteFile(target, previousBody);
      throw new Error(`Post-install verification failed for ${id}`);
    }

    const entry: InstalledSkillEntry = {
      version: meta.version || '0.0.0',
      installedAt: new Date().toISOString(),
      source: opts.source,
      title: meta.title,
      description: meta.description,
      category: meta.category,
    };
    try {
      index.skills[id] = entry;
      this.writeIndex(index);
    } catch (err) {
      if (previousBody != null) atomicWriteFile(target, previousBody);
      else try { unlinkSync(target); } catch { /* ignore */ }
      throw err;
    }

    return {
      id,
      version: entry.version,
      path: target,
      status: existing ? 'reinstalled' : 'installed',
      previousVersion: existing?.version,
    };
  }

  remove(id: string): boolean {
    assertValidSkillId(id);
    const index = this.readIndex();
    const had = !!index.skills[id];
    const skillFile = this.pathFor(id);
    const skillDir = dirname(skillFile);
    const root = resolve(this.installRoot);

    // Remove the file and the skill dir (only if non-empty paths are clearly under root)
    if (existsSync(skillFile)) {
      try { unlinkSync(skillFile); } catch (err) { logger.warn({ err, id }, 'remove: unlink failed'); }
    }
    // Try removing the skill dir, then the (possibly empty) category dir.
    if (existsSync(skillDir) && resolve(skillDir).startsWith(root + sep)) {
      try { rmSync(skillDir, { recursive: true, force: true }); } catch { /* ignore */ }
      const categoryDir = dirname(skillDir);
      if (categoryDir !== root && existsSync(categoryDir) && resolve(categoryDir).startsWith(root + sep)) {
        try {
          if (readdirSync(categoryDir).length === 0) rmSync(categoryDir, { recursive: false });
        } catch { /* ignore */ }
      }
    }

    if (had) {
      delete index.skills[id];
      this.writeIndex(index);
    }
    return had;
  }

  // ---------- Helpers ----------

  ensureRoot(): void {
    if (!existsSync(this.installRoot)) mkdirSync(this.installRoot, { recursive: true });
  }

  private verifyBody(body: string, id: string): void {
    if (!body.startsWith('---\n') && !body.startsWith('---\r\n')) {
      throw new RegistryError(
        `Refusing to install ${id}: SKILL.md is missing YAML frontmatter.`,
        undefined,
        id,
      );
    }
    const meta = parseFrontmatter(body);
    if (!meta.name && !meta.title) {
      throw new RegistryError(
        `Refusing to install ${id}: SKILL.md frontmatter missing "name" / "title".`,
        undefined,
        id,
      );
    }
  }

  /** Health check: returns details for `skills doctor`. */
  health(): {
    installRoot: string;
    rootExists: boolean;
    indexExists: boolean;
    indexValid: boolean;
    installed: number;
    orphaned: string[];
  } {
    const rootExists = existsSync(this.installRoot);
    const indexExists = existsSync(this.indexPath);
    let indexValid = true;
    let index: SkillsIndex = emptyIndex();
    try {
      if (indexExists) index = this.readIndex();
    } catch {
      indexValid = false;
    }
    const orphaned: string[] = [];
    for (const id of Object.keys(index.skills)) {
      try {
        if (!existsSync(this.pathFor(id))) orphaned.push(id);
      } catch {
        orphaned.push(id);
      }
    }
    return {
      installRoot: this.installRoot,
      rootExists,
      indexExists,
      indexValid,
      installed: Object.keys(index.skills).length,
      orphaned,
    };
  }
}

// ---------- Module-level helpers ----------

interface ParsedFrontmatter {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  category?: string;
}

function parseFrontmatter(body: string): ParsedFrontmatter {
  const m = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return {};
  try {
    const obj = parseYaml(m[1]) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return {};
    return {
      id: typeof obj.id === 'string' ? obj.id : undefined,
      name: typeof obj.name === 'string' ? obj.name : undefined,
      title: typeof obj.title === 'string' ? obj.title : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      version: typeof obj.version === 'string' ? obj.version : undefined,
      category: typeof obj.category === 'string' ? obj.category : undefined,
    };
  } catch {
    return {};
  }
}

function atomicWriteFile(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf-8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export { isValidSkillId, assertValidSkillId, parseFrontmatter };
