/**
 * Author tooling: `mercury plugins init` (a working plugin to start from)
 * and `mercury plugins pack` (the .tgz, its checksum and the catalog entry).
 * Together with `validate` (conformance.ts) this is the whole author loop,
 * with nothing to install from npm.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import semver from 'semver';
import { checkTree, loadManifest, sha256File } from './installer.js';
import { mercuryVersion } from './store.js';
import { PLUGIN_SDK_DTS } from './sdk-dts.js';
import { PLUGIN_ID_RE, PLUGIN_API_VERSION, RESERVED_COMMANDS, type CatalogEntry } from './types.js';

const execFileAsync = promisify(execFile);

export type ScaffoldKind = 'in-process' | 'out-of-process';

function engineRange(): string {
  const v = semver.coerce(mercuryVersion())?.version ?? '1.0.0';
  return `>=${semver.major(v)}.${semver.minor(v)}.0 <${semver.major(v) + 1}.0.0`;
}

function titleCase(id: string): string {
  return id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const IN_PROCESS_ENTRY = (id: string) => `// @ts-check
/**
 * ${titleCase(id)}: a Mercury in-process plugin.
 *
 * Rules that keep Mercury stable (checked by \`mercury plugins validate\`):
 *   - Ship ONE self-contained file. Bundle any npm packages into it
 *     (esbuild --bundle --format=esm --platform=node); only node: builtins
 *     resolve at runtime.
 *   - Talk to Mercury only through \`ctx\`. Timers, tools and commands made
 *     through it are cleaned up when the plugin is turned off.
 *   - Use ctx.fetch for network access; only hosts in the manifest work.
 *
 * @param {import('./mercury-plugin').PluginContext} ctx
 */
export async function activate(ctx) {
  ctx.tools.register({
    name: 'greet',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Who to greet' } },
      required: ['name'],
    },
    execute: async (args) => {
      const greeting = ctx.settings.get('greeting') ?? 'Hello';
      return \`\${greeting}, \${String(args.name)}!\`;
    },
  });

  ctx.commands.register({
    name: '${id.replace(/-/g, '_').slice(0, 30)}',
    run: async (args, io) => {
      await io.reply(\`${titleCase(id)} is running. You said: \${args || '(nothing)'}\`);
    },
  });

  ctx.log.info('activated');
}

/** Optional. Anything registered through ctx is already cleaned up for you. */
export async function deactivate() {}
`;

const OUT_OF_PROCESS_SERVER = (id: string) => `// ${titleCase(id)}: a Mercury out-of-process plugin.
//
// A minimal MCP server over stdio (JSON-RPC 2.0, one message per line),
// with no dependencies. Mercury starts it with its own runtime, restarts it
// if it crashes, and stops it when the plugin is turned off. You can swap
// this for any MCP SDK, or ship a native binary and point "server.command"
// at it. Settings arrive as JSON in MERCURY_PLUGIN_SETTINGS; declared
// secrets arrive as environment variables. Log to stderr, never stdout.
import { createInterface } from 'node:readline';

const settings = JSON.parse(process.env.MERCURY_PLUGIN_SETTINGS || '{}');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

const tools = [
  {
    name: 'greet',
    description: 'Greet someone by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];

async function callTool(name, args) {
  if (name === 'greet') return \`\${settings.greeting ?? 'Hello'}, \${String(args?.name)}!\`;
  throw new Error(\`Unknown tool \${name}\`);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (message) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: '${id}', version: '0.1.0' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call':
      try {
        const text = await callTool(msg.params?.name, msg.params?.arguments);
        return reply({ content: [{ type: 'text', text }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true });
      }
    default:
      if (msg.id !== undefined) fail(\`Method not found: \${msg.method}\`);
  }
});
`;

const README = (id: string, kind: ScaffoldKind) => `# ${titleCase(id)}

A Mercury ${kind} plugin.

## Develop

\`\`\`sh
mercury plugins validate .          # checks it the way Mercury will run it
mercury plugins install . --yes     # install this folder into your Mercury
mercury plugins info ${id}
\`\`\`

Edit, then run \`mercury plugins install . --yes\` again: the new version
replaces the running one (bump "version" in mercury-plugin.json).

## Publish

\`\`\`sh
mercury plugins pack .              # writes ${id}-<version>.tgz and prints its catalog entry
\`\`\`

Attach the .tgz to a GitHub release as \`mercury-plugin.tgz\` and anyone can
install it with \`mercury plugins install github:<owner>/<repo>\`. To be
listed in \`/plugins\`, open a pull request adding the printed entry to the
Mercury plugin catalog.

## Contract

- Plugin API ${PLUGIN_API_VERSION} (types in \`mercury-plugin.d.ts\`). Minor
  versions only add; a breaking change is a new major, and the previous one
  stays supported for at least two Mercury minor releases.
- No dependencies on other plugins.
- Renamed or removed a setting? Bump \`settings.version\` and add a
  \`settings.migrations\` step so saved values carry over.
`;

export function scaffoldPlugin(parent: string, id: string, kind: ScaffoldKind = 'in-process'): string {
  if (!PLUGIN_ID_RE.test(id)) throw new Error('Plugin ids are 3-32 characters: lowercase letters, digits and hyphens, starting with a letter.');
  const command = id.replace(/-/g, '_').slice(0, 30);
  if (kind === 'in-process' && RESERVED_COMMANDS.has(command)) throw new Error(`"${id}" would add /${command}, which is a built-in command. Pick another id.`);
  const dir = resolve(parent, id);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} already exists and isn't empty.`);
  mkdirSync(dir, { recursive: true });

  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    id,
    name: titleCase(id),
    version: '0.1.0',
    description: `${titleCase(id)} for Mercury.`,
    kind,
    engines: { mercury: engineRange(), pluginApi: `^${PLUGIN_API_VERSION}` },
    ...(kind === 'in-process' ? { entry: 'index.mjs' } : { server: { command: 'node', args: ['server.mjs'] } }),
    contributes: {
      tools: [{ name: 'greet', description: 'Greet someone by name.', readOnly: true }],
      ...(kind === 'in-process' ? { commands: [{ name: command, description: `Check that ${titleCase(id)} is running` }] } : {}),
    },
    permissions: { network: [], secrets: [] },
    settings: {
      version: 1,
      fields: { greeting: { type: 'string', description: 'How to start a greeting', default: 'Hello' } },
    },
  };
  writeFileSync(join(dir, 'mercury-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (kind === 'in-process') {
    writeFileSync(join(dir, 'index.mjs'), IN_PROCESS_ENTRY(id));
    writeFileSync(join(dir, 'mercury-plugin.d.ts'), PLUGIN_SDK_DTS);
  } else {
    writeFileSync(join(dir, 'server.mjs'), OUT_OF_PROCESS_SERVER(id));
  }
  writeFileSync(join(dir, 'README.md'), README(id, kind));
  writeFileSync(join(dir, '.gitignore'), '*.tgz\nnode_modules/\n');
  return dir;
}

export interface PackResult {
  file: string;
  sha256: string;
  size: number;
  entry: Omit<CatalogEntry, 'tier'> & { tier: 'community' };
}

/** Build `<id>-<version>.tgz` from a plugin folder, plus its catalog entry. */
export async function packPlugin(dir: string, outDir = process.cwd()): Promise<PackResult> {
  const root = resolve(dir);
  const manifest = loadManifest(root);
  checkTree(root);
  mkdirSync(outDir, { recursive: true });
  const file = join(resolve(outDir), `${manifest.id}-${manifest.version}.tgz`);
  const skip = new Set(['.git', 'node_modules', '.DS_Store']);
  const members = readdirSync(root).filter((n) => !skip.has(n) && !n.endsWith('.tgz') && !n.endsWith('.d.ts'));
  // Archive name relative to cwd: GNU tar reads "C:\\…" as a remote host.
  await execFileAsync('tar', ['-czf', basename(file), '-C', root, ...members], { cwd: dirname(file), windowsHide: true });
  const sha256 = await sha256File(file);
  const size = statSync(file).size;
  return {
    file,
    sha256,
    size,
    entry: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      kind: manifest.kind,
      tier: 'community',
      ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
      engines: manifest.engines,
      artifact: { url: `https://github.com/<owner>/<repo>/releases/download/v${manifest.version}/${basename(file)}`, sha256, size },
      tools: manifest.contributes.tools.map((t) => t.name),
      permissions: manifest.permissions,
    },
  };
}
