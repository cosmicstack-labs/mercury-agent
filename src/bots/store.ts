import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type {
  BotManifest,
  BotPermissionsFile,
} from './types.js';

export const BOT_MANIFEST_FILENAME = 'bot.yaml';
export const BOT_PERSONA_FILENAME = 'persona.md';
export const BOT_PERMISSIONS_FILENAME = 'permissions.yaml';
/** Fleet-shared sandbox folder (every bot gets read/write/execute). The
 * underscore prefix keeps store.list() from ever treating it as a bot. */
export const BOT_SHARED_SANDBOX_DIRNAME = '_shared';
/** Per-bot private workspace inside the profile dir (auto-purged on delete). */
export const BOT_SANDBOX_DIRNAME = 'sandbox';
export const BOT_ENV_FILENAME = '.env';
export const BOT_JOURNAL_FILENAME = 'journal.jsonl';
/** Per-run compact transcripts (tool trace + reply), pruned by retention.transcriptRuns. */
export const BOT_TRANSCRIPTS_DIRNAME = 'transcripts';
/** The bot's own working-state note (bot_state) — ADR-021. */
export const BOT_STATE_FILENAME = 'state.md';
/** Routine state (paused routines, no-outcome streaks) — ADR-020. */
export const BOT_ROUTINE_STATE_FILENAME = 'routine-state.json';
/**
 * Data directories that live INSIDE a bot's profile dir but are never bot
 * profiles themselves. The roster scan does not descend into them: bots
 * used to copy their own profile folders into sandbox/ and outputs/ as
 * "mirrors", which the scan then reported as duplicate bots on every boot.
 */
export const BOT_DATA_DIRNAMES: ReadonlySet<string> = new Set([BOT_SANDBOX_DIRNAME, 'outputs', 'skills', BOT_TRANSCRIPTS_DIRNAME]);

export interface BotRoutineState {
  /**
   * Routine key → why/when it was paused and when it resumes BY ITSELF
   * (`until`). A bot is never left dead: /bots start resumes early, the
   * cooldown resumes otherwise (ADR-020, liveness contract §2.14).
   */
  paused: Record<string, { since: string; until?: string; reason: string }>;
  /** Routine key → consecutive runs that produced no outcome. */
  noOutcomeStreak: Record<string, number>;
  /** Routine key → how many times it has been paused (cooldown backoff); reset by a productive run. */
  pauseCount?: Record<string, number>;
}

/**
 * Where finished results go — a folder the OWNER can find without knowing
 * about ~/.mercury (ADR-020). Overridable (bots.deliverablesDir); the
 * default is the platform's Documents folder. A custom MERCURY_HOME (eval
 * harness, tests) keeps deliverables inside that home.
 */
export function defaultDeliverablesRoot(): string {
  if (process.env.MERCURY_HOME) return join(getMercuryHome(), 'deliverables');
  const home = homedir();
  const isTermux = Boolean(process.env.TERMUX_VERSION) || (process.env.PREFIX ?? '').includes('com.termux');
  if (isTermux) {
    const shared = join(home, 'storage', 'shared');
    return existsSync(shared) ? join(shared, 'Documents', 'Mercury') : join(home, 'Mercury');
  }
  const documents = join(home, 'Documents');
  return existsSync(documents) ? join(documents, 'Mercury') : join(home, 'Mercury');
}

/** A folder name a person recognises: the bot's display name, filesystem-safe. */
/** Drop filesystem-hostile characters: the reserved set plus ASCII control codes. */
function stripUnsafeChars(text: string): string {
  return [...text].filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(ch)).join('');
}

export function deliverablesFolderName(name: string, id: string): string {
  const clean = stripUnsafeChars(name).replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean || id;
}

/** "2026-10-10 Oxide Series D.md" — date first so a folder sorts by time, then a human title. */
export function deliverableFileName(stemOrTitle: string, ext: string, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  const title = stripUnsafeChars(stemOrTitle.replace(/^\d{4}-\d{2}-\d{2}[ _-]*/, ''))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';
  return `${day} ${title}${ext}`;
}

/** Fleet nesting cap — mirrors addCrew's 3-level guard (CEO → Lead → Crew). */
export const MAX_FLEET_DEPTH = 3;

/** Lowercase alphanumeric ids — same discipline as skill ids (traversal guard). */
const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Tools that are deny-by-default for every bot unless explicitly allowed. */
export const BOT_DANGEROUS_TOOLS = [
  'run_command',
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'git_commit',
  'git_push',
] as const;

export function assertValidBotId(id: string): void {
  if (!BOT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid bot id "${id}": must match ${BOT_ID_PATTERN.source} (lowercase letters, digits, dashes; max 48 chars)`);
  }
}

/**
 * Structural validation of a bot manifest. Returns error strings; an empty
 * array means the manifest is usable. Never throws on user input.
 */
export function validateBotManifest(manifest: Partial<BotManifest>): string[] {
  const errors: string[] = [];
  try {
    assertValidBotId(manifest.id ?? '');
  } catch (err: any) {
    errors.push(err.message);
  }
  if (!manifest.name || typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    errors.push('name is required');
  }
  const schedules = manifest.schedules ?? [];
  for (const s of schedules) {
    if (!s.name || !s.prompt) errors.push(`schedule ${s.name || '(unnamed)'}: name and prompt are required`);
    if (!isValidCronExpression(s.cron ?? '')) {
      errors.push(`schedule ${s.name || '(unnamed)'}: "${s.cron}" is not a 5-field cron expression`);
    }
  }
  const crossRecall = manifest.memory?.allowCrossBotRecall ?? [];
  for (const other of crossRecall) {
    if (other === manifest.id) errors.push('allowCrossBotRecall cannot include the bot itself');
  }
  const canMessage = manifest.comms?.canMessage ?? [];
  for (const other of canMessage) {
    if (other === manifest.id) errors.push('canMessage cannot include the bot itself');
  }
  // Fleet hierarchy: `parent` = has a lead; `fleetRole: lead` = leads a crew.
  // Both may be set (mid-level lead, e.g. an Engineering Lead under a CEO).
  // A bare `fleetRole: crew` with no parent is invalid; self-parent invalid.
  if (manifest.parent) {
    if (manifest.parent === manifest.id) {
      errors.push('parent cannot be the bot itself');
    }
  }
  if (manifest.fleetRole === 'crew' && !manifest.parent) {
    errors.push('fleetRole "crew" requires a parent (the lead bot id)');
  }
  return errors;
}

export function isValidCronExpression(expr: string): boolean {
  if (typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every(f => f.length > 0);
}

export interface CreateBotInput {
  id: string;
  name: string;
  description?: string;
  /** Persona markdown; omit to write the template. */
  persona?: string;
  manifest?: Partial<Omit<BotManifest, 'id' | 'name' | 'createdAt' | 'updatedAt'>>;
}

const DEFAULT_PERSONA_TEMPLATE = (name: string, description?: string) =>
`# ${name}

${description || 'A Mercury bot — a focused specialist.'}

## Character

You are ${name}. Stay in character at all times. You are a specialist:
stay inside your domain of expertise, and say so plainly when a request
falls outside it.

## Standing instructions

- Be concise and concrete; prefer decisions over deliberation.
- You never ask the user questions mid-run: if a required input is missing,
  state the assumption you are proceeding with.
- If you lack permission for an action, stop and report it in your summary
  instead of attempting a workaround. Permissions are NOT declared here —
  they live exclusively in your permissions.yaml file (the single source of
  truth); your private \`sandbox/\`, the fleet \`_shared/\` folder and your
  own profile directory are always yours.

## Output

- Lead with the outcome, then the details.
- Include the evidence (links, file paths, numbers) behind each claim.
`;

function atomicWrite(filePath: string, content: string, mode: number = 0o600): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { encoding: 'utf-8', mode });
  renameSync(tmp, filePath);
}

/**
 * Filesystem store for bot profiles. Fleet structure is PHYSICAL: a crew
 * bot's whole profile lives inside its lead's directory —
 * `~/.mercury/bots/<lead>/[<mid-lead>/...]/<crew-id>/` — so removing a lead
 * removes its crew tree with it, and the layout mirrors the hierarchy the
 * manifests already describe. Solos and leads live at the root.
 * Mirrors SkillStore's dependency-injected-root testability and traversal
 * guards, and SessionRepository's atomic tmp+rename writes.
 */
export class BotStore {
  readonly botsRoot: string;
  /** mtime-validated manifest cache (see get()) — write paths keep it fresh. */
  private manifestCache = new Map<string, { mtimeMs: number; manifest: BotManifest }>();
  /** id → absolute profile dir; populated on first resolution (scan), kept
   * fresh by every write path. Cleared on delete/relocate. */
  private locationCache = new Map<string, string>();
  /** Wired by BotManager: a bot's profile dir moved (re-parent or migration) —
   * open journal handles and registry caches for that id are stale. */
  onRelocate: ((id: string, oldDir: string, newDir: string) => void) | null = null;

  private readonly deliverablesRootDir: string;

  constructor(botsRoot?: string, deliverablesRoot?: string) {
    this.botsRoot = resolve(botsRoot ?? join(getMercuryHome(), 'bots'));
    // A custom bots root (tests) keeps deliverables beside it, never in the
    // developer's real Documents folder.
    this.deliverablesRootDir = resolve(deliverablesRoot ?? (botsRoot ? join(this.botsRoot, '..', 'Mercury') : defaultDeliverablesRoot()));
  }

  /** The owner-visible deliverables root (e.g. ~/Documents/Mercury). */
  deliverablesRoot(): string {
    return this.deliverablesRootDir;
  }

  /**
   * The folder the owner opens to find a bot's results. Leads and solos get
   * `<root>/<Bot name>/`; a crew bot's work lives under its lead's folder,
   * `<lead folder>/work/<crew id>/`, so one fleet = one folder with the
   * finals on top and the stages underneath.
   */
  deliverablesDir(id: string): string {
    const manifest = this.get(id);
    if (!manifest) return join(this.deliverablesRootDir, id);
    if (manifest.parent && manifest.parent !== id) {
      return join(this.deliverablesDir(manifest.parent), 'work', id);
    }
    return join(this.deliverablesRootDir, deliverablesFolderName(manifest.name, manifest.id));
  }

  /** Rewrite the README index of a deliverables folder (finals on top, stages under work/). */
  writeDeliverablesIndex(dir: string): void {
    try {
      if (!existsSync(dir)) return;
      const files = readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name !== 'README.md' && !e.name.startsWith('.'))
        .map(e => { const st = statSync(join(dir, e.name)); return { name: e.name, bytes: st.size, mtimeMs: st.mtimeMs }; })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const lines = [
        `# ${basename(dir)} — deliverables`,
        '',
        'Finished results from this Mercury bot land here, newest first. Work in progress from the crew (research, drafts, checks) is under `work/`.',
        '',
      ];
      if (files.length === 0) lines.push('_Nothing delivered yet._');
      else {
        lines.push('| Delivered | File | Size |', '|---|---|---|');
        for (const f of files) lines.push(`| ${new Date(f.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')} | ${f.name} | ${f.bytes < 1024 ? f.bytes + ' B' : Math.round(f.bytes / 1024) + ' KB'} |`);
      }
      lines.push('', '_Maintained by Mercury. Delete files freely; this index is rewritten on the next delivery._');
      writeFileSync(join(dir, 'README.md'), lines.join('\n') + '\n', 'utf-8');
    } catch { /* an index is a convenience, never a failure */ }
  }

  /** The bot's working-state note; '' when none. */
  readState(id: string): string {
    try {
      return readFileSync(join(this.botDir(id), BOT_STATE_FILENAME), 'utf-8').trim();
    } catch {
      return '';
    }
  }

  writeState(id: string, state: string): void {
    const file = join(this.botDir(id), BOT_STATE_FILENAME);
    if (!state) {
      try { rmSync(file, { force: true }); } catch { /* nothing to clear */ }
      return;
    }
    atomicWrite(file, state + '\n');
  }

  readRoutineState(id: string): BotRoutineState {
    try {
      const raw = JSON.parse(readFileSync(join(this.botDir(id), BOT_ROUTINE_STATE_FILENAME), 'utf-8'));
      return { paused: raw.paused ?? {}, noOutcomeStreak: raw.noOutcomeStreak ?? {}, pauseCount: raw.pauseCount ?? {} };
    } catch {
      return { paused: {}, noOutcomeStreak: {}, pauseCount: {} };
    }
  }

  writeRoutineState(id: string, state: BotRoutineState): void {
    try {
      atomicWrite(join(this.botDir(id), BOT_ROUTINE_STATE_FILENAME), JSON.stringify(state, null, 2) + '\n');
    } catch (err) {
      logger.warn({ botId: id, err: (err as Error)?.message }, 'Could not persist routine state');
    }
  }

  /** Bot directory for an id, with traversal guard. Throws on invalid ids. */
  botDir(id: string): string {
    assertValidBotId(id);
    const cached = this.locationCache.get(id);
    if (cached) return cached;
    const dir = this.resolveBotDir(id);
    this.locationCache.set(id, dir);
    return dir;
  }

  /**
   * Resolve a bot's profile dir. Flat-first (solos/leads + any legacy crew
   * dirs), then a depth-bounded scan for the nested crew profile — the
   * parent id lives INSIDE the crew's manifest, so the directory is the
   * only place the location can be discovered from.
   */
  private resolveBotDir(id: string): string {
    const root = resolve(this.botsRoot);
    const flat = resolve(root, id);
    if (existsSync(join(flat, BOT_MANIFEST_FILENAME))) return flat;
    const nested = this.scanForBotDir(root, id, 0);
    return nested ?? flat;
  }

  private scanForBotDir(dir: string, id: string, depth: number): string | undefined {
    if (depth >= MAX_FLEET_DEPTH) return undefined;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const root = resolve(this.botsRoot);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_') || BOT_DATA_DIRNAMES.has(entry.name)) continue;
      const sub = join(dir, entry.name);
      if (!resolve(sub).startsWith(root + sep)) continue;
      if (!existsSync(join(sub, BOT_MANIFEST_FILENAME))) continue;
      if (entry.name === id) return sub;
      const deeper = this.scanForBotDir(sub, id, depth + 1);
      if (deeper) return deeper;
    }
    return undefined;
  }

  /** The bot's private sandbox workspace (inside its profile dir — purged on delete). */
  sandboxDir(id: string): string {
    return join(this.botDir(id), BOT_SANDBOX_DIRNAME);
  }

  /** The bot's own skill library (auto-synthesized + hand-authored; bot-private). */
  skillsDir(id: string): string {
    return join(this.botDir(id), 'skills');
  }

  // ---- fleet hierarchy (derived — the child's `parent` is the only state) --

  /** Crew of a lead, derived from manifests. Lead/solo → empty. */
  crewOf(leadId: string): BotManifest[] {
    return this.list().filter(m => m.parent === leadId);
  }

  /** The lead of a crew bot; solo/lead → null. */
  leadOf(botId: string): BotManifest | null {
    const m = this.get(botId);
    if (!m?.parent) return null;
    return this.get(m.parent);
  }

  isLead(id: string): boolean {
    return this.get(id)?.fleetRole === 'lead';
  }

  /** The fleet-shared sandbox folder (one physical dir; every bot gets rw+x). */
  sharedSandboxDir(): string {
    return resolve(this.botsRoot, BOT_SHARED_SANDBOX_DIRNAME);
  }

  /**
   * Owner-curated final deliverables (`bot_deliver`). Sits OUTSIDE the
   * fleet-shared folder and is exempt from the retention janitor — the
   * owner deletes these when done with them.
   */
  outputsDir(): string {
    return resolve(this.botsRoot, 'outputs');
  }

  /** Create both sandbox areas if missing (cheap + idempotent). */
  ensureSandboxes(id: string): void {
    mkdirSync(this.sandboxDir(id), { recursive: true });
    mkdirSync(this.sharedSandboxDir(), { recursive: true });
  }

  list(): BotManifest[] {
    if (!existsSync(this.botsRoot)) return [];
    const manifests: BotManifest[] = [];
    // Bot identity is the manifest id, and it must stay 1:1 with the roster:
    // a profile dir that somehow exists in MORE than one place in the tree
    // (a forked/stale copy — historically possible when a relocate races a
    // concurrent runtime or a rename fails on Windows) must not let the same
    // bot appear twice. First occurrence wins; extra copies are flagged.
    const seenIds = new Set<string>();
    const reportedForks = new Set<string>();
    // Fleet layout is physical: crew profiles nest inside their lead's dir,
    // so walk the tree (bounded by the fleet depth cap). Data dirs without a
    // bot.yaml (sandbox/, skills/, rotations) are descended harmlessly but
    // never counted as bots.
    const visit = (dir: string, depth: number): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_') || BOT_DATA_DIRNAMES.has(entry.name)) continue;
        const sub = join(dir, entry.name);
        // Only a profile dir can contain crew profiles. A root-level data
        // dir (outputs/) or a bot's own sandbox is never descended.
        const isProfile = existsSync(join(sub, BOT_MANIFEST_FILENAME));
        if (!isProfile) continue;
        try {
          const m = this.get(entry.name);
          if (m) {
            if (!seenIds.has(m.id)) {
              seenIds.add(m.id);
              manifests.push(m);
            } else if (!reportedForks.has(m.id)) {
              reportedForks.add(m.id);
              logger.warn({ botId: m.id, dir: sub }, 'Duplicate physical bot profile — roster keeps only the first occurrence; run `mercury` and remove the stale copy');
            }
          }
        } catch (err: any) {
          logger.warn({ dir: sub, err: err?.message }, 'Skipping unreadable bot profile');
        }
        if (depth < MAX_FLEET_DEPTH) visit(sub, depth + 1);
      }
    };
    visit(this.botsRoot, 1);
    this.reconcileFleetPlacement(manifests);
    return manifests.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Strict fleet layout reconciliation: the folder tree and the manifests
   * must agree, and BOTH hand-authoring paths converge (this is what makes
   * manually created fleet folders first-class):
   *  - A bot.yaml dropped manually inside a lead's directory is ADOPTED as
   *    that lead's crew (manifest gains parent, fleetRole, comms back).
   *  - A manifest that names a parent (hand-edited or manager-written)
   *    has its profile dir MOVED under that lead.
   * When both disagree (folder under A, manifest says B), the manifest is
   * the newer intent and wins — same rule as every other live hand-edit.
   * Deleting crews whose lead vanished stays a startup-migration rule: a
   * transient hand-edit must not cascade-delete bots mid-session.
   */
  private reconcileFleetPlacement(manifests: BotManifest[]): void {
    for (const m of manifests) {
      try {
        const physical = this.physicalFleetParent(m.id);
        if (m.parent && m.parent !== physical) {
          if (this.exists(m.parent)) {
            this.relocateToParent(m);
          }
          // Missing lead: migrateFleetLayout cascade-deletes at startup.
        } else if (!m.parent && physical && physical !== m.id) {
          const lead = this.get(physical);
          if (lead) {
            this.update(m.id, mm => {
              mm.parent = physical;
              mm.fleetRole = 'crew';
              mm.comms = { ...mm.comms, canMessage: [...new Set([...(mm.comms?.canMessage ?? []), physical])] };
            });
            logger.info({ botId: m.id, leadId: physical }, 'Manually created fleet folder adopted into the lead\'s crew');
          }
        }
      } catch (err: any) {
        logger.warn({ botId: m.id, err: err?.message }, 'Fleet placement reconciliation failed — leaving profile as-is');
      }
    }
  }

  /** The bot id owning the directory this profile lives in (undefined at the bots root). */
  private physicalFleetParent(id: string): string | undefined {
    const parentDir = resolve(this.botDir(id), '..');
    if (parentDir === resolve(this.botsRoot)) return undefined;
    if (!existsSync(join(parentDir, BOT_MANIFEST_FILENAME))) return undefined;
    const owner = parentDir.split(sep).pop()!;
    assertValidBotId(owner);
    return owner;
  }

  get(id: string): BotManifest | null {
    const file = join(this.botDir(id), BOT_MANIFEST_FILENAME);
    if (!existsSync(file)) {
      this.manifestCache.delete(id);
      // A cached location whose manifest has vanished is a dead entry (the
      // id may have been deleted, or never existed) — force a fresh scan.
      this.locationCache.delete(id);
      return null;
    }
    // mtime-validated cache: getStatusSummaries() runs on the TUI's 2s status
    // poller, per chat message (system-prompt section), and per web API hit —
    // re-reading + re-parsing every bot.yaml each time is pure event-loop
    // tax. statSync per call keeps externally-edited manifests fresh; write
    // paths also refresh the entry directly (same-millisecond writes would
    // otherwise alias to the stale mtime).
    const mtimeMs = statSync(file).mtimeMs;
    const cached = this.manifestCache.get(id);
    if (cached && cached.mtimeMs === mtimeMs) return cached.manifest;
    const raw = parseYaml(readFileSync(file, 'utf-8')) as Partial<BotManifest>;
    if (!raw || raw.id !== id) {
      throw new Error(`Bot manifest for "${id}" is missing or has a mismatched id`);
    }
    const manifest = normalizeBotManifest(raw);
    this.manifestCache.set(id, { mtimeMs, manifest });
    return manifest;
  }

  exists(id: string): boolean {
    try {
      return existsSync(join(this.botDir(id), BOT_MANIFEST_FILENAME));
    } catch {
      return false;
    }
  }

  create(input: CreateBotInput): BotManifest {
    const id = input.id.toLowerCase();
    if (this.exists(id)) {
      throw new Error(`Bot "${id}" already exists`);
    }
    const now = new Date().toISOString();
    const manifest = normalizeBotManifest({
      ...input.manifest,
      id,
      name: input.name,
      description: input.description,
      enabled: input.manifest?.enabled ?? true,
      persona: input.manifest?.persona ?? BOT_PERSONA_FILENAME,
      createdAt: now,
      updatedAt: now,
    } as Partial<BotManifest>);
    const errors = validateBotManifest(manifest);
    if (errors.length > 0) {
      throw new Error(`Invalid bot manifest: ${errors.join('; ')}`);
    }
    // Fleet layout: a crew bot's profile is created INSIDE its lead's
    // directory. The lead must exist — fail closed rather than placing a
    // profile the hierarchy cannot account for.
    const dir = manifest.parent ? this.resolveNestedDir(manifest.parent, id) : this.botDir(id);
    this.locationCache.set(id, dir);
    mkdirSync(dir, { recursive: true });
    this.ensureSandboxes(id);
    this.save(manifest);
    const personaFile = join(dir, manifest.persona ?? BOT_PERSONA_FILENAME);
    if (!existsSync(personaFile)) {
      writeFileSync(personaFile, input.persona ?? DEFAULT_PERSONA_TEMPLATE(input.name, input.description), 'utf-8');
    }
    // NO default permissions.yaml here: an ABSENT file is meaningful — a
    // crew bot inherits its lead's file verbatim (ensurePermissions), and a
    // solo falls back to the fail-closed default. A tier choice, fleet
    // inheritance, or the startup migration materializes the file.
    return manifest;
  }

  save(manifest: BotManifest): void {
    assertValidBotId(manifest.id);
    this.assertFleetParentValid(manifest);
    const dir = this.botDir(manifest.id);
    if (!existsSync(dir)) {
      throw new Error(`Bot "${manifest.id}" does not exist`);
    }
    const errors = validateBotManifest(manifest);
    if (errors.length > 0) {
      throw new Error(`Invalid bot manifest: ${errors.join('; ')}`);
    }
    manifest.updatedAt = new Date().toISOString();
    atomicWrite(join(dir, BOT_MANIFEST_FILENAME), stringifyYaml(manifest));
    // Same-millisecond writes would make the mtime check in get() alias to
    // the stale entry — refresh it directly instead of relying on mtime.
    this.manifestCache.set(manifest.id, { mtimeMs: statSync(join(dir, BOT_MANIFEST_FILENAME)).mtimeMs, manifest });
  }

  update(id: string, mutator: (m: BotManifest) => void): BotManifest {
    const manifest = this.get(id);
    if (!manifest) throw new Error(`Bot "${id}" does not exist`);
    mutator(manifest);
    manifest.updatedAt = new Date().toISOString();
    // Re-parent moves the profile dir to keep the physical layout in sync
    // (crew nested under its lead; promote/detach moves back to the root).
    this.relocateToParent(manifest);
    this.save(manifest);
    return manifest;
  }

  setEnabled(id: string, enabled: boolean): BotManifest {
    return this.update(id, m => { m.enabled = enabled; });
  }

  delete(id: string): void {
    const dir = this.botDir(id);
    if (existsSync(dir)) {
      // Fleet layout is physical: crew profiles live INSIDE their lead's
      // dir, so this removes the whole crew tree with the lead.
      rmSync(dir, { recursive: true, force: true });
      this.manifestCache.delete(id);
      this.locationCache.delete(id);
      logger.info({ botId: id }, 'Bot profile deleted');
    }
  }

  // ---- fleet placement ------------------------------------------------------

  /**
   * The profile dir a bot with this manifest should occupy: nested under its
   * lead's dir, or at the root for solos/leads. Fails closed if the lead is
   * unknown. Pure computation — no filesystem writes.
   */
  private resolveNestedDir(parentId: string, id: string): string {
    assertValidBotId(parentId);
    if (!this.exists(parentId)) {
      throw new Error(`Parent bot "${parentId}" does not exist`);
    }
    return join(this.botDir(parentId), id);
  }

  /** Fail closed on dangling parents and hierarchy cycles before any write. */
  private assertFleetParentValid(manifest: BotManifest): void {
    if (!manifest.parent) return;
    assertValidBotId(manifest.parent);
    if (!this.exists(manifest.parent)) {
      throw new Error(`Parent bot "${manifest.parent}" does not exist`);
    }
    let ancestor: string | undefined = manifest.parent;
    const seen = new Set([manifest.id]);
    let depth = 0;
    while (ancestor) {
      if (seen.has(ancestor)) {
        throw new Error(`Fleet cycle detected at "${ancestor}"`);
      }
      seen.add(ancestor);
      if (++depth > MAX_FLEET_DEPTH) {
        throw new Error(`Fleet nesting exceeds ${MAX_FLEET_DEPTH} levels`);
      }
      const next: string | undefined = this.get(ancestor)?.parent;
      ancestor = next ?? undefined;
    }
  }

  /**
   * Move a bot's profile to where its manifest's parent says it belongs
   * (idempotent no-op when it is already there). Used by re-parenting
   * updates and the startup migration. Fires onRelocate so open journal
   * handles and runtime caches for the id are refreshed.
   */
  relocateToParent(manifest: BotManifest): boolean {
    const current = this.botDir(manifest.id);
    const target = manifest.parent ? this.resolveNestedDir(manifest.parent, manifest.id) : resolve(this.botsRoot, manifest.id);
    if (resolve(current) === resolve(target)) return false;
    if (!existsSync(current)) return false;
    mkdirSync(resolve(target, '..'), { recursive: true });
    renameSync(current, target);
    this.locationCache.set(manifest.id, resolve(target));
    this.onRelocate?.(manifest.id, current, resolve(target));
    logger.info({ botId: manifest.id, from: current, to: resolve(target) }, 'Bot profile relocated to its fleet parent');
    return true;
  }

  readPersona(id: string): string {
    const manifest = this.get(id);
    const personaName = manifest?.persona ?? BOT_PERSONA_FILENAME;
    const file = join(this.botDir(id), personaName);
    return existsSync(file) ? readFileSync(file, 'utf-8') : '';
  }

  writePersona(id: string, content: string): void {
    const manifest = this.get(id);
    const personaName = manifest?.persona ?? BOT_PERSONA_FILENAME;
    atomicWrite(join(this.botDir(id), personaName), content, 0o644);
  }

  readPermissions(id: string): BotPermissionsFile {
    const file = join(this.botDir(id), BOT_PERMISSIONS_FILENAME);
    if (!existsSync(file)) return {};
    return (parseYaml(readFileSync(file, 'utf-8')) ?? {}) as BotPermissionsFile;
  }

  /**
   * Fleet permission inheritance — the crew rule: a crew bot runs on its
   * LEAD's permissions verbatim unless it has an explicitly edited file of
   * its own. Resolution:
   *  - permissions.yaml exists → that file (explicit; edits stick).
   *  - absent + the bot has a lead → the lead's file is COPIED into the
   *    crew's dir (copy-paste semantics: from then on the crew owns it and
   *    later lead changes do not propagate — exactly "inherit unless the
   *    user edits"). `self` scopes resolve per-bot at registry build, so a
   *    verbatim copy is safe.
   *  - absent + no lead (solo) → the fail-closed default is materialized
   *    (own profile dir, read+write).
   */
  ensurePermissions(id: string): BotPermissionsFile {
    const file = join(this.botDir(id), BOT_PERMISSIONS_FILENAME);
    if (existsSync(file)) return this.readPermissions(id);
    const manifest = this.get(id);
    const leadId = manifest?.parent;
    if (leadId && this.exists(leadId)) {
      const leadPerms = this.readPermissions(leadId);
      const inherited = Object.keys(leadPerms).length > 0 ? leadPerms : DEFAULT_BOT_PERMISSIONS;
      this.writePermissions(id, inherited);
      logger.info({ botId: id, leadId }, 'Crew permissions inherited from its lead (copied verbatim)');
      return inherited;
    }
    this.writePermissions(id, DEFAULT_BOT_PERMISSIONS);
    return DEFAULT_BOT_PERMISSIONS;
  }

  writePermissions(id: string, permissions: BotPermissionsFile): void {
    atomicWrite(join(this.botDir(id), BOT_PERMISSIONS_FILENAME), stringifyYaml(permissions));
  }

  /** Directory sizes for the /bots storage view. */
  usage(): Array<{ id: string; bytes: number; journalBytes: number }> {
    if (!existsSync(this.botsRoot)) return [];
    const out: Array<{ id: string; bytes: number; journalBytes: number }> = [];
    for (const m of this.list()) {
      const dir = this.botDir(m.id);
      out.push({ id: m.id, bytes: treeSize(dir), journalBytes: journalTreeSize(dir) });
    }
    return out;
  }
}

/** Fail-closed baseline for a bot with no permissions.yaml and no lead. */
const DEFAULT_BOT_PERMISSIONS: BotPermissionsFile = {
  paths: [{ scope: 'self', read: true, write: true }],
};

function treeSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) total += treeSize(p);
      else total += statSync(p).size;
    }
  } catch { /* unreadable entries count as 0 */ }
  return total;
}

function journalTreeSize(dir: string): number {
  return readdirSync(dir)
    .filter(f => f === 'journal.jsonl' || /^journal\.jsonl\.\d+$/.test(f))
    .reduce((acc, f) => {
      try { return acc + statSync(join(dir, f)).size; } catch { return acc; }
    }, 0);
}

function normalizeBotManifest(raw: Partial<BotManifest>): BotManifest {
  // Tool defaults: an unconfigured bot (no tools key) gets the fail-closed
  // dangerous-tool deny list. A bot with an EXPLICITLY configured tools block
  // is respected exactly as written — this is what the onboarding permission
  // tiers write, so hand-editing the deny list is a first-class way to grant
  // or revoke (previously the materialized defaults made hand-edits sticky).
  const allow = raw.tools?.allow ?? [];
  const explicitDeny = raw.tools?.deny ?? [];
  const deny = new Set<string>(explicitDeny);
  if (!raw.tools && allow.length === 0) {
    for (const t of BOT_DANGEROUS_TOOLS) deny.add(t);
  }
  return {
    ...raw,
    enabled: raw.enabled ?? false,
    persona: raw.persona ?? BOT_PERSONA_FILENAME,
    memory: { scope: raw.memory?.scope ?? 'own', allowCrossBotRecall: raw.memory?.allowCrossBotRecall },
    tools: { allow, deny: [...deny] },
  } as BotManifest;
}