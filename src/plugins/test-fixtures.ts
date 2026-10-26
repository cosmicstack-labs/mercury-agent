/**
 * Test fixtures for the plugin system: throwaway MERCURY_HOME, and plugin
 * packages that behave well or badly on purpose. Used only by *.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function tempHome(): { home: string; restore: () => void } {
  // Inside the repo: Vitest's module runner can only import files under the
  // project root, and in-process plugins are loaded with import().
  const base = join(process.cwd(), '.vitest-tmp');
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, 'mercury-plugins-'));
  const prev = process.env.MERCURY_HOME;
  const prevCatalog = process.env.MERCURY_PLUGIN_CATALOG_URL;
  process.env.MERCURY_HOME = home;
  process.env.MERCURY_PLUGIN_CATALOG_URL = 'off';
  return {
    home,
    restore: () => {
      if (prev === undefined) delete process.env.MERCURY_HOME;
      else process.env.MERCURY_HOME = prev;
      if (prevCatalog === undefined) delete process.env.MERCURY_PLUGIN_CATALOG_URL;
      else process.env.MERCURY_PLUGIN_CATALOG_URL = prevCatalog;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface FixtureOptions {
  id?: string;
  version?: string;
  engines?: { mercury: string; pluginApi?: string };
  manifest?: Record<string, unknown>;
  /** Source of index.mjs for in-process plugins. */
  code?: string;
  tools?: Array<{ name: string; description?: string; readOnly?: boolean; timeoutMs?: number }>;
  commands?: Array<{ name: string; description?: string }>;
  network?: string[];
  secrets?: string[];
}

/** An in-process plugin folder. Default code registers every declared tool as an echo. */
export function inProcessPlugin(root: string, opts: FixtureOptions = {}): string {
  const id = opts.id ?? 'echo-tools';
  const dir = join(root, `${id}-${opts.version ?? '1.0.0'}`);
  mkdirSync(dir, { recursive: true });
  const tools = opts.tools ?? [{ name: 'echo', description: 'Echo the input back', readOnly: true }];
  const manifest = {
    manifestVersion: 1,
    id,
    name: `Fixture ${id}`,
    version: opts.version ?? '1.0.0',
    description: 'A test fixture plugin',
    kind: 'in-process',
    engines: opts.engines ?? { mercury: '>=1.0.0' },
    entry: 'index.mjs',
    contributes: {
      tools: tools.map((t) => ({ description: 'fixture tool', ...t })),
      commands: (opts.commands ?? []).map((c) => ({ description: 'fixture command', ...c })),
    },
    permissions: { network: opts.network ?? [], secrets: opts.secrets ?? [] },
    ...opts.manifest,
  };
  writeFileSync(join(dir, 'mercury-plugin.json'), JSON.stringify(manifest, null, 2));
  const code = opts.code ?? `
export async function activate(ctx) {
  for (const name of ${JSON.stringify(tools.map((t) => t.name))}) {
    ctx.tools.register({
      name,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (args) => \`\${name}: \${args.text ?? ''}\`,
    });
  }
}`;
  writeFileSync(join(dir, 'index.mjs'), code);
  return dir;
}

/**
 * A minimal MCP stdio server. Behaviour is controlled by env vars the test
 * sets in the plugin's settings (passed as MERCURY_PLUGIN_SETTINGS):
 *   mode = "ok" | "crash-on-call" | "hang-on-call" | "crash-at-start" | "no-handshake"
 */
export const MCP_SERVER_SOURCE = `
const settings = JSON.parse(process.env.MERCURY_PLUGIN_SETTINGS || '{}');
const mode = settings.mode || 'ok';
if (mode === 'crash-at-start') { process.stderr.write('boom at start\\n'); process.exit(3); }
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    if (mode === 'no-handshake') return;
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
  }
  if (msg.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'add', description: 'add numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
      { name: 'secret', description: 'read a secret', inputSchema: { type: 'object', properties: {} } },
      { name: 'undeclared', description: 'not in manifest', inputSchema: { type: 'object' } },
    ] } });
  }
  if (msg.method === 'tools/call') {
    if (mode === 'crash-on-call') process.exit(5);
    if (mode === 'hang-on-call') return;
    const { name, arguments: a } = msg.params;
    if (name === 'add') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String((a.a || 0) + (a.b || 0)) }] } });
    if (name === 'secret') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ declared: process.env.FIXTURE_TOKEN || null, leaked: process.env.OTHER_SECRET || null }) }] } });
    return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown tool' } });
  }
});
`;

export function outOfProcessPlugin(root: string, opts: FixtureOptions & { mode?: string } = {}): string {
  const id = opts.id ?? 'mcp-math';
  const dir = join(root, `${id}-${opts.version ?? '1.0.0'}`);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    manifestVersion: 1,
    id,
    name: `Fixture ${id}`,
    version: opts.version ?? '1.0.0',
    description: 'A test fixture MCP plugin',
    kind: 'out-of-process',
    engines: opts.engines ?? { mercury: '>=1.0.0' },
    server: { command: 'node', args: ['server.cjs'] },
    contributes: {
      tools: (opts.tools ?? [
        { name: 'add', description: 'Add two numbers', readOnly: true, timeoutMs: 2000 },
        { name: 'secret', description: 'Read the declared secret', readOnly: true, timeoutMs: 2000 },
      ]).map((t) => ({ description: 'fixture', ...t })),
      commands: [],
    },
    permissions: { network: [], secrets: opts.secrets ?? ['FIXTURE_TOKEN'] },
    settings: { version: 1, fields: { mode: { type: 'string', default: opts.mode ?? 'ok' } } },
    ...opts.manifest,
  };
  writeFileSync(join(dir, 'mercury-plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'server.cjs'), MCP_SERVER_SOURCE);
  return dir;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(stepMs);
  }
}
