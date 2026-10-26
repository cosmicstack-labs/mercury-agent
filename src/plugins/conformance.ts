/**
 * Conformance kit: `mercury plugins validate <folder>`.
 *
 * Runs a plugin package through everything Mercury will do to it (install
 * checks, start, the tools it publishes, stop, start again) and reports each
 * step, so an author finds out before users do. The same checks gate the
 * official catalog.
 */
import { builtinModules } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree, loadManifest, verifyPackage } from './installer.js';
import { MAX_RENDERER_BYTES } from './renderers.js';
import { mercuryVersion, resolvedSettings } from './store.js';
import { listLiveTools, listPluginCommands, unpublishPlugin } from './tool-bridge.js';
import { InProcessRuntime } from './runtime/in-process.js';
import { OutOfProcessRuntime } from './runtime/out-of-process.js';
import type { PluginRuntime, RuntimeDeps } from './runtime/types.js';
import type { PluginManifest } from './types.js';

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceReport {
  ok: boolean;
  id?: string;
  version?: string;
  checks: ConformanceCheck[];
}

const BUILTINS = new Set(builtinModules);
const IMPORT_RE = /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*[\w*{}\s,$]+\s*from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;

/**
 * Imports an in-process entry makes that a compiled Mercury can't satisfy.
 * Plugins must be bundled into one file; only `node:` builtins and files
 * inside the package resolve.
 */
export function unresolvableImports(source: string): string[] {
  const bad = new Set<string>();
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue;
    if (BUILTINS.has(spec)) continue;
    bad.add(spec);
  }
  return [...bad];
}

function quietDeps(manifest: PluginManifest, dataDir: string, errors: string[]): RuntimeDeps {
  const note = (level: string) => (message: string) => { if (level === 'error') errors.push(message); };
  return {
    mercuryVersion: mercuryVersion(),
    dataDir,
    settings: resolvedSettings(manifest),
    secrets: Object.fromEntries(manifest.permissions.secrets.map((k) => [k, process.env[k]])),
    log: { debug: note('debug'), info: note('info'), warn: note('warn'), error: note('error') },
    onError: (message) => errors.push(message),
    onFatal: (_code, message) => errors.push(message),
  };
}

export async function runConformance(dir: string): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const pass = (name: string, detail?: string) => checks.push({ name, ok: true, detail });
  const fail = (name: string, detail: string) => checks.push({ name, ok: false, detail });
  const done = (manifest?: PluginManifest): ConformanceReport => ({
    ok: checks.every((c) => c.ok), id: manifest?.id, version: manifest?.version, checks,
  });

  let manifest: PluginManifest;
  try {
    manifest = loadManifest(dir);
    pass('manifest', `${manifest.id}@${manifest.version} (${manifest.kind}, manifest v${manifest.manifestVersion})`);
  } catch (err) {
    fail('manifest', (err as Error).message);
    return done();
  }

  try {
    const { files, bytes } = checkTree(dir);
    pass('package files', `${files} files, ${(bytes / 1024).toFixed(0)} KB, no links or files outside the folder`);
  } catch (err) {
    fail('package files', (err as Error).message);
  }

  try {
    await verifyPackage(dir, manifest);
    pass('compatibility and integrity', `Mercury ${mercuryVersion()}, plugin API ${manifest.engines.pluginApi}`);
  } catch (err) {
    fail('compatibility and integrity', (err as Error).message);
    return done(manifest);
  }

  // Plugin API 1.3: every declared renderer must be a real HTML file inside the package,
  // small enough to serve, and no two may claim the same language.
  if ((manifest.contributes.renderers ?? []).length > 0) {
    const claims = new Set<string>();
    try {
      const details = manifest.contributes.renderers.map((renderer) => {
        if (claims.has(renderer.language)) throw new Error(`two renderers claim "${renderer.language}"`);
        claims.add(renderer.language);
        if (!/\.html?$/.test(renderer.asset)) throw new Error(`renderer "${renderer.language}" must point at an .html asset, not "${renderer.asset}"`);
        const file = join(dir, renderer.asset);
        if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`renderer asset "${renderer.asset}" is missing from the package`);
        const size = statSync(file).size;
        if (size > MAX_RENDERER_BYTES) {
          throw new Error(`renderer "${renderer.language}" is ${(size / 1024).toFixed(0)} KB; the limit is ${MAX_RENDERER_BYTES / 1024} KB`);
        }
        return `${renderer.language} (${(size / 1024).toFixed(0)} KB, sandboxed)`;
      });
      pass('renderers', details.join(', '));
    } catch (err) {
      fail('renderers', (err as Error).message);
    }
  }

  if (manifest.kind === 'in-process' && manifest.entry) {
    try {
      const bad = unresolvableImports(readFileSync(join(dir, manifest.entry), 'utf8'));
      if (bad.length) fail('self-contained bundle', `imports packages Mercury can't provide: ${bad.join(', ')}. Bundle them into ${manifest.entry} (e.g. esbuild --bundle --format=esm --platform=node).`);
      else pass('self-contained bundle', 'only node: builtins and files in the package');
    } catch (err) {
      fail('self-contained bundle', (err as Error).message);
    }
  }

  for (const t of manifest.contributes.tools) {
    if (!/[.!?)]$/.test(t.description.trim()) || t.description.trim().length < 20) {
      checks.push({ name: `tool ${t.name}: description`, ok: true, detail: 'tip: one or two full sentences help the model pick the tool' });
    }
  }

  // Start, inspect, stop, start again: hot plug must be repeatable.
  const dataDir = mkdtempSync(join(tmpdir(), `mercury-plugin-check-${manifest.id}-`));
  const errors: string[] = [];
  const make = (): PluginRuntime => manifest.kind === 'in-process'
    ? new InProcessRuntime(manifest, dir, quietDeps(manifest, dataDir, errors))
    : new OutOfProcessRuntime(manifest, dir, quietDeps(manifest, dataDir, errors));
  try {
    for (const round of [1, 2]) {
      const label = round === 1 ? 'start' : 'restart (hot plug)';
      const runtime = make();
      const t0 = Date.now();
      try {
        await runtime.start();
        pass(label, `running in ${Date.now() - t0} ms`);
      } catch (err) {
        fail(label, (err as Error).message);
        break;
      }

      if (round === 1) {
        const live = listLiveTools().filter((t) => t.pluginId === manifest.id);
        const missing = manifest.contributes.tools.filter((d) => !live.some((t) => t.name === d.name)).map((d) => d.name);
        if (missing.length) fail('tools', `declared but not provided: ${missing.join(', ')}`);
        else pass('tools', manifest.contributes.tools.length ? live.map((t) => t.name).join(', ') : 'none declared');
        for (const t of live) {
          const s = t.inputSchema as { type?: unknown };
          if (s && s.type !== 'object') fail(`tool ${t.name}: input schema`, 'inputSchema must be a JSON Schema with "type": "object"');
        }
        const cmds = listPluginCommands().filter((c) => c.pluginId === manifest.id);
        const missingCmds = manifest.contributes.commands.filter((d) => !cmds.some((c) => c.name === d.name)).map((d) => d.name);
        if (missingCmds.length) fail('commands', `declared but not registered: ${missingCmds.map((n) => `/${n}`).join(', ')}`);
        else if (manifest.contributes.commands.length) pass('commands', cmds.map((c) => `/${c.name}`).join(', '));
      }

      const t1 = Date.now();
      try {
        await runtime.stop();
        const leftover = listLiveTools().some((t) => t.pluginId === manifest.id) || listPluginCommands().some((c) => c.pluginId === manifest.id);
        if (leftover || runtime.isRunning()) fail(`${label}: stop`, 'tools or commands were still registered after stop');
        else pass(`${label}: stop`, `clean in ${Date.now() - t1} ms`);
      } catch (err) {
        fail(`${label}: stop`, (err as Error).message);
      }
    }
    if (errors.length) fail('errors while running', errors.slice(0, 3).join(' | '));
  } finally {
    unpublishPlugin(manifest.id);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp */ }
  }
  return done(manifest);
}
