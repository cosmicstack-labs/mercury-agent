/**
 * `mercury skills ...` CLI command handlers.
 *
 * Wired in src/index.ts via registerSkillsCommand(program). All handlers
 * print human-readable, chalk-colored output by default and structured JSON
 * when `--json` is passed.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { Command } from 'commander';
import chalk from 'chalk';
import { RegistryClient, RegistryError, searchFeed, type RegistrySkillSummary, type ScoredSkill } from './registry.js';
import { SkillStore, isValidSkillId } from './store.js';
import { renderMarkdown } from '../utils/markdown.js';
import { getMercuryHome } from '../utils/config.js';

interface GlobalSkillFlags {
  json?: boolean;
  registry?: string;
  quiet?: boolean;
  yes?: boolean;
}

function inheritedFlags(cmd: Command): GlobalSkillFlags {
  // Walk up to gather shared flags from the `skills` parent.
  const opts: Record<string, unknown> = {};
  let c: Command | null = cmd;
  while (c) {
    Object.assign(opts, c.opts());
    c = c.parent;
  }
  return opts as GlobalSkillFlags;
}

function makeRegistry(flags: GlobalSkillFlags): RegistryClient {
  const url =
    flags.registry ||
    process.env.MERCURY_SKILLS_REGISTRY ||
    'https://skills.mercuryagent.sh';
  return new RegistryClient({ registry: url });
}

function makeStore(): SkillStore {
  const installRoot =
    process.env.MERCURY_SKILLS_INSTALL_ROOT ||
    `${getMercuryHome()}/skills`;
  return new SkillStore({ installRoot });
}

function out(flags: GlobalSkillFlags, ...args: unknown[]): void {
  if (flags.quiet) return;
  console.log(...args);
}

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(flags: GlobalSkillFlags, message: string, extra: Record<string, unknown> = {}): never {
  if (flags.json) {
    process.stderr.write(JSON.stringify({ ok: false, error: message, ...extra }) + '\n');
  } else {
    console.error(chalk.red(`error: ${message}`));
  }
  process.exit(1);
}

function categoryLabel(skill: Pick<RegistrySkillSummary, 'category' | 'categorySlug'>): string {
  return skill.category || skill.categorySlug || '';
}

// ---------- subcommands ----------

async function cmdInfo(_args: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const registry = makeRegistry(flags);
  const store = makeStore();
  const installed = store.list();
  if (flags.json) {
    emitJson({
      registry: registry.registryUrl,
      installRoot: store.installRoot,
      cacheDir: registry.cacheDir,
      cacheTtlSeconds: registry.cacheTtlMs / 1000,
      installed: installed.length,
    });
    return;
  }
  out(flags, chalk.bold('Mercury skills'));
  out(flags, `  Registry:     ${chalk.cyan(registry.registryUrl)}`);
  out(flags, `  Install root: ${chalk.cyan(store.installRoot)}`);
  out(flags, `  Cache dir:    ${chalk.cyan(registry.cacheDir)}`);
  out(flags, `  Cache TTL:    ${registry.cacheTtlMs / 1000}s`);
  out(flags, `  Installed:    ${chalk.bold(String(installed.length))} skill${installed.length === 1 ? '' : 's'}`);
}

async function cmdList(_args: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const store = makeStore();
  const installed = store.list();
  if (flags.json) {
    emitJson({ skills: installed });
    return;
  }
  if (installed.length === 0) {
    out(flags, chalk.dim('No skills installed. Try:'));
    out(flags, chalk.dim('  mercury skills search <query>'));
    out(flags, chalk.dim('  mercury skills browse'));
    return;
  }
  out(flags, chalk.bold(`Installed skills (${installed.length}):`));
  for (const s of installed) {
    out(
      flags,
      `  ${chalk.cyan(s.id)} ${chalk.dim('·')} v${s.version} ${chalk.dim('·')} ${chalk.dim(new Date(s.installedAt).toISOString().slice(0, 10))}`,
    );
    if (s.description) out(flags, `    ${chalk.dim(s.description)}`);
  }
}

async function cmdCategories(_args: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const registry = makeRegistry(flags);
  try {
    const feed = await registry.getFeed();
    if (flags.json) { emitJson({ categories: feed.categories }); return; }
    out(flags, chalk.bold(`Categories (${feed.categories.length}):`));
    for (const c of [...feed.categories].sort((a, b) => b.count - a.count)) {
      out(flags, `  ${chalk.cyan(c.slug.padEnd(24))} ${String(c.count).padStart(4)}  ${chalk.dim(c.name)}`);
    }
  } catch (err: any) {
    fail(flags, err?.message || String(err));
  }
}

async function cmdBrowse(category: string | undefined, _opts: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const opts = cmd.opts<{ page?: string; limit?: string }>();
  const registry = makeRegistry(flags);
  try {
    const feed = await registry.getFeed();
    let skills = feed.skills;
    if (category) {
      const want = category.toLowerCase();
      skills = skills.filter((s) => s.categorySlug?.toLowerCase() === want || s.category?.toLowerCase() === want);
    }
    const page = Math.max(1, parseInt(opts.page || '1', 10));
    const limit = Math.max(1, parseInt(opts.limit || '20', 10));
    const start = (page - 1) * limit;
    const slice = skills.slice(start, start + limit);

    if (flags.json) {
      emitJson({ total: skills.length, page, limit, skills: slice });
      return;
    }
    if (skills.length === 0) {
      out(flags, chalk.dim(`No skills${category ? ` in category "${category}"` : ''}.`));
      return;
    }
    out(flags, chalk.bold(`${skills.length} skill${skills.length === 1 ? '' : 's'}${category ? ` in ${category}` : ''} — page ${page}/${Math.ceil(skills.length / limit)}`));
    for (const s of slice) printSkillRow(s);
    out(flags, chalk.dim(`\nInstall with: mercury skills install <id>`));
    if (start + limit < skills.length) {
      out(flags, chalk.dim(`Next page:    mercury skills browse${category ? ` ${category}` : ''} --page ${page + 1}`));
    }
  } catch (err: any) {
    fail(flags, err?.message || String(err));
  }
}

async function cmdSearch(query: string, _opts: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const opts = cmd.opts<{ limit?: string }>();
  const registry = makeRegistry(flags);
  const limit = Math.max(1, parseInt(opts.limit || '10', 10));
  try {
    const feed = await registry.getFeed();
    const results = searchFeed(feed, query, limit);
    if (flags.json) {
      emitJson({ query, results: results.map((r) => ({ score: r.score, ...r.skill })) });
      return;
    }
    if (results.length === 0) {
      out(flags, chalk.dim(`No matches for "${query}".`));
      return;
    }
    for (const r of results) printSkillRow(r.skill);
    out(flags, chalk.dim(`\nInstall with: mercury skills install <id>`));
  } catch (err: any) {
    fail(flags, err?.message || String(err));
  }
}

function printSkillRow(s: RegistrySkillSummary): void {
  console.log(
    `${chalk.cyan(s.id)} ${chalk.dim('·')} v${s.version} ${chalk.dim('·')} ${chalk.dim(categoryLabel(s))}`,
  );
  if (s.description) console.log(`  ${s.description}`);
}

async function cmdView(id: string, _opts: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const opts = cmd.opts<{ web?: boolean; raw?: boolean }>();
  const registry = makeRegistry(flags);

  if (opts.web) {
    await openInBrowser(registry.webUrl(id));
    out(flags, chalk.dim(`Opened ${registry.webUrl(id)}`));
    return;
  }

  // Prefer the installed copy if present.
  const store = makeStore();
  let body: string | null = null;
  if (isValidSkillId(id)) {
    try {
      const local = store.pathFor(id);
      if (existsSync(local)) body = readFileSync(local, 'utf-8');
    } catch { /* ignore */ }
  }
  if (!body) {
    try {
      const fetched = await registry.fetchSkillMarkdown(id);
      body = fetched.body;
    } catch (err: any) {
      if (err instanceof RegistryError) fail(flags, err.message, { id, status: err.status });
      fail(flags, err?.message || String(err), { id });
    }
  }
  if (flags.json) {
    emitJson({ id, body });
    return;
  }
  if (opts.raw) {
    process.stdout.write(body!);
    return;
  }
  process.stdout.write(renderMarkdown(body!));
  if (!body!.endsWith('\n')) process.stdout.write('\n');
}

async function cmdInstall(ids: string[], _opts: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const opts = cmd.opts<{ from?: string; force?: boolean }>();
  const registry = makeRegistry(flags);
  const store = makeStore();
  store.ensureRoot();

  // --from <url|path>: install a SKILL.md from a URL or local file (no registry lookup)
  if (opts.from) {
    if (ids.length > 0) fail(flags, 'Cannot combine --from with positional ids.');
    try {
      const body = await loadBodyFromSource(opts.from);
      const result = store.installFromBody(body, { source: opts.from });
      if (flags.json) { emitJson({ ok: true, ...result }); return; }
      out(flags, chalk.green(`✓ ${result.id} (v${result.version}) — installed from ${opts.from}`));
    } catch (err: any) {
      fail(flags, err?.message || String(err));
    }
    return;
  }

  if (ids.length === 0) fail(flags, 'No skill id provided. Usage: mercury skills install <id> [<id>...]');

  const results: Array<{ id: string; ok: boolean; status?: string; version?: string; error?: string }> = [];
  let hadError = false;
  for (const id of ids) {
    if (!isValidSkillId(id)) {
      hadError = true;
      results.push({ id, ok: false, error: 'invalid id (expected <category-slug>/<skill-slug>)' });
      if (!flags.json) console.error(chalk.red(`✗ ${id} — invalid id`));
      continue;
    }
    try {
      const r = await store.install(id, { force: opts.force, registry });
      results.push({ id: r.id, ok: true, status: r.status, version: r.version });
      if (!flags.json) {
        if (r.status === 'already-installed') {
          out(flags, chalk.yellow(`• ${r.id} already installed (v${r.version}); use --force to re-download`));
        } else {
          out(flags, chalk.green(`✓ ${r.id} (v${r.version})`));
        }
      }
    } catch (err: any) {
      hadError = true;
      const status = err instanceof RegistryError ? err.status : undefined;
      results.push({ id, ok: false, error: err?.message || String(err) });
      if (!flags.json) console.error(chalk.red(`✗ ${id} — ${err?.message || err}${status ? ` (HTTP ${status})` : ''}`));
    }
  }
  if (flags.json) emitJson({ ok: !hadError, results });
  if (hadError) process.exit(1);
}

async function cmdRemove(id: string, _opts: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const store = makeStore();
  try {
    if (!isValidSkillId(id)) fail(flags, `Invalid skill id "${id}".`, { id });
    const ok = store.remove(id);
    if (flags.json) { emitJson({ ok, id }); return; }
    if (ok) out(flags, chalk.green(`✓ removed ${id}`));
    else out(flags, chalk.yellow(`• ${id} was not installed`));
    if (!ok) process.exit(1);
  } catch (err: any) {
    fail(flags, err?.message || String(err), { id });
  }
}

async function cmdUpdate(id: string | undefined, _opts: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const registry = makeRegistry(flags);
  const store = makeStore();
  const targets = id ? [id] : store.list().map((s) => s.id);
  if (targets.length === 0) {
    if (flags.json) { emitJson({ ok: true, updated: [] }); return; }
    out(flags, chalk.dim('No installed skills to update.'));
    return;
  }
  const results: Array<{ id: string; ok: boolean; status?: string; version?: string; error?: string }> = [];
  let hadError = false;
  for (const t of targets) {
    try {
      const r = await store.install(t, { force: true, registry });
      results.push({ id: r.id, ok: true, status: r.status, version: r.version });
      if (!flags.json) out(flags, chalk.green(`✓ ${r.id} (v${r.version})`));
    } catch (err: any) {
      hadError = true;
      results.push({ id: t, ok: false, error: err?.message || String(err) });
      if (!flags.json) console.error(chalk.red(`✗ ${t} — ${err?.message || err}`));
    }
  }
  if (flags.json) emitJson({ ok: !hadError, updated: results });
  if (hadError) process.exit(1);
}

async function cmdDoctor(_args: unknown, cmd: Command): Promise<void> {
  const flags = inheritedFlags(cmd);
  const registry = makeRegistry(flags);
  const store = makeStore();
  const h = store.health();
  const ping = await registry.ping();

  const ok = h.indexValid && h.orphaned.length === 0 && ping.ok;

  if (flags.json) {
    emitJson({ ok, store: h, registry: { url: registry.registryUrl, ...ping } });
    process.exit(ok ? 0 : 1);
  }

  out(flags, chalk.bold('Skills doctor'));
  out(flags, `  Install root:   ${h.installRoot} ${h.rootExists ? chalk.green('[ok]') : chalk.yellow('[will be created on install]')}`);
  out(flags, `  Index:          ${h.indexExists ? (h.indexValid ? chalk.green('[ok]') : chalk.red('[invalid]')) : chalk.dim('[empty]')}`);
  out(flags, `  Installed:      ${h.installed}`);
  if (h.orphaned.length > 0) out(flags, `  Orphaned:       ${chalk.red(h.orphaned.join(', '))}`);
  out(flags, `  Registry:       ${registry.registryUrl} ${ping.ok ? chalk.green(`[ok ${ping.status}]`) : chalk.red(`[unreachable${ping.error ? ': ' + ping.error : ''}]`)}`);
  process.exit(ok ? 0 : 1);
}

// ---------- helpers ----------

async function loadBodyFromSource(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    return await res.text();
  }
  const abs = resolve(source.replace(/^~/, homedir()));
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return readFileSync(abs, 'utf-8');
}

async function openInBrowser(url: string): Promise<void> {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  const args = platform() === 'win32' ? ['', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

// ---------- public registration ----------

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command('skills')
    .description('Discover, install, and manage Mercury skills from skills.mercuryagent.sh')
    .option('--json', 'Emit machine-readable JSON (no colors, no spinners)')
    .option('--registry <url>', 'Override registry URL (default: https://skills.mercuryagent.sh)')
    .option('-q, --quiet', 'Suppress non-error output')
    .option('-y, --yes', 'Skip confirmation prompts');

  skills
    .command('info')
    .description('Print registry URL, install root, cache location, and installed count')
    .action(cmdInfo);

  skills
    .command('list')
    .description('Show locally installed skills')
    .action(cmdList);

  skills
    .command('categories')
    .description('List registry categories with skill counts')
    .action(cmdCategories);

  skills
    .command('browse [category]')
    .description('Browse all available skills in the registry, optionally filtered by category slug')
    .option('--page <n>', 'Page number (default: 1)', '1')
    .option('--limit <n>', 'Skills per page (default: 20)', '20')
    .action(cmdBrowse);

  skills
    .command('search <query>')
    .description('Search the registry by title, tags, description, and category')
    .option('--limit <n>', 'Max results (default: 10)', '10')
    .action(cmdSearch);

  skills
    .command('view <id>')
    .description('Render a skill\'s SKILL.md to the terminal (prefers local copy if installed)')
    .option('--web', 'Open the skill\'s page on skills.mercuryagent.sh in your default browser')
    .option('--raw', 'Print raw SKILL.md without terminal formatting')
    .action(cmdView);

  skills
    .command('install [ids...]')
    .description('Install one or more skills by id (e.g. ai-ml/prompt-engineering)')
    .option('--from <urlOrPath>', 'Install a SKILL.md from a URL or local path (advanced)')
    .option('-f, --force', 'Re-download even if already installed at the same version')
    .action(cmdInstall);

  skills
    .command('remove <id>')
    .description('Delete an installed skill')
    .action(cmdRemove);

  skills
    .command('update [id]')
    .description('Re-fetch one or all installed skills from the registry')
    .action(cmdUpdate);

  skills
    .command('doctor')
    .description('Check install root, index, and registry reachability')
    .action(cmdDoctor);
}
