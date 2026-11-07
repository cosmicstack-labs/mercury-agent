// Portable release content, shared by the binary builder, verifier and focused tests.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

const pluginIds = ['live-time', 'hardlight'];
const skillsAsset = 'mercury-adapted-skills.tgz';
const catalogAsset = 'mercury-community-plugins.json';
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const manifestFor = (root, id) => JSON.parse(fs.readFileSync(path.join(root, 'plugins', id, 'mercury-plugin.json'), 'utf8'));
function contentAssets(root) {
  return [skillsAsset, ...pluginIds.map((id) => {
    const m = manifestFor(root, id);
    if (m.id !== id || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m.version)) throw new Error(`Invalid release plugin: ${id}`);
    return `${id}-${m.version}.tgz`;
  }), catalogAsset];
}

// Inspect without extracting: tar listings alone cannot detect symlinks, hardlinks,
// devices, duplicate paths or PAX path overrides. Bound decompression as well.
function inspectArchive(file) {
  const tar = gunzipSync(fs.readFileSync(file), { maxOutputLength: 128 * 1024 * 1024 });
  const entries = new Map();
  let pax = {};
  const text = (b) => b.toString('utf8').replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) {
      if (!tar.subarray(offset).every((b) => b === 0)) throw new Error('Data after tar terminator');
      return entries;
    }
    const octal = (b) => {
      const s = text(b).trim();
      if (!/^[0-7]+$/.test(s)) throw new Error('Invalid tar number');
      return parseInt(s, 8);
    };
    const sum = [...h].reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== octal(h.subarray(148, 156))) throw new Error('Invalid tar header checksum');
    const size = octal(h.subarray(124, 136));
    const end = offset + 512 + size;
    if (end > tar.length) throw new Error('Truncated tar member');
    const data = tar.subarray(offset + 512, end);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(h[156]);
    if (type === 'x') {
      if (Object.keys(pax).length) throw new Error('Repeated PAX header');
      let i = 0;
      while (i < data.length) {
        const space = data.indexOf(32, i);
        const length = Number(data.subarray(i, space).toString());
        if (space < i || !Number.isSafeInteger(length) || length <= space - i + 1 || i + length > data.length) throw new Error('Invalid PAX header');
        const record = data.subarray(space + 1, i + length).toString('utf8');
        const eq = record.indexOf('=');
        if (eq < 1 || !record.endsWith('\n')) throw new Error('Invalid PAX record');
        const key = record.slice(0, eq);
        if (/size|linkpath|sparse/i.test(key)) throw new Error(`Unsafe PAX key: ${key}`);
        pax[key] = record.slice(eq + 1, -1);
        i += length;
      }
      continue;
    }
    if (!['0', '\0', '5'].includes(type)) throw new Error(`Unsafe tar member type: ${type}`);
    const prefix = text(h.subarray(345, 500));
    const name = (pax.path ?? `${prefix ? `${prefix}/` : ''}${text(h.subarray(0, 100))}`).replace(/\/$/, '');
    pax = {};
    if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\\\x00-\x1f\x7f]/.test(name) || name.split('/').some((s) => !s || s === '.' || s === '..')) throw new Error(`Unsafe archive path: ${name}`);
    if (entries.has(name)) throw new Error(`Duplicate archive path: ${name}`);
    if (type === '5' && size !== 0) throw new Error('Nonempty tar directory');
    entries.set(name, { directory: type === '5', data });
  }
  throw new Error('Missing tar terminator');
}

function sourceFiles(dir, prefix = '', plugin = false, files = new Map()) {
  for (const name of fs.readdirSync(dir)) {
    if (plugin && (['.git', 'node_modules', '.DS_Store'].includes(name) || name.endsWith('.tgz') || (!prefix && name.endsWith('.d.ts')))) continue;
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsafe source: ${full}`);
    if (stat.isDirectory()) sourceFiles(full, rel, plugin, files);
    else files.set(rel, fs.readFileSync(full));
  }
  return files;
}

function verifyTree(file, source, prefix = '', plugin = false) {
  const entries = inspectArchive(file);
  const expected = sourceFiles(source, '', plugin);
  for (const required of ['LICENSE', 'README.md', ...(plugin ? ['mercury-plugin.json', 'index.mjs'] : [])]) {
    if (!expected.has(required)) throw new Error(`Missing required source file: ${required}`);
  }
  if (!plugin && ![...expected.keys()].some((p) => p.endsWith('/SKILL.md'))) throw new Error('Skills archive has no skills');
  for (const [name, entry] of entries) {
    if (prefix && name !== prefix && !name.startsWith(`${prefix}/`)) throw new Error(`Unexpected archive root: ${name}`);
    if (entry.directory) continue;
    const relative = prefix ? name.slice(prefix.length + 1) : name;
    const want = expected.get(relative);
    if (!want || !entry.data.equals(want)) throw new Error(`Unexpected or changed archive file: ${name}`);
    expected.delete(relative);
  }
  if (expected.size) throw new Error(`Missing archive files: ${[...expected.keys()].join(', ')}`);
}

function verifyContent(root, outDir, { dev = false } = {}) {
  verifyTree(path.join(outDir, skillsAsset), path.join(root, 'skills', 'mercury-adapted'), 'mercury-adapted');
  const catalog = JSON.parse(fs.readFileSync(path.join(outDir, catalogAsset), 'utf8'));
  if (catalog.catalogVersion !== 1 || catalog.plugins?.length !== pluginIds.length) throw new Error('Invalid community catalog');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  pluginIds.forEach((id, i) => {
    const m = manifestFor(root, id);
    const name = `${id}-${m.version}.tgz`;
    verifyTree(path.join(outDir, name), path.join(root, 'plugins', id), '', true);
    const e = catalog.plugins[i];
    const bytes = fs.readFileSync(path.join(outDir, name));
    const url = `https://github.com/cosmicstack-labs/mercury-agent/releases/download/${dev ? 'mercury-dev-latest' : `v${version}`}/${name}`;
    if (e.id !== id || e.version !== m.version || e.tier !== 'community' || e.artifact?.url !== url || e.artifact?.sha256 !== sha256(bytes) || e.artifact?.size !== bytes.length) throw new Error(`Invalid pinned community entry: ${id}`);
  });
}

function buildContent(root, outDir, { dev = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const env = { ...process.env, COPYFILE_DISABLE: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  execFileSync('tar', ['--no-xattrs', '-czf', path.join(outDir, skillsAsset), '-C', path.join(root, 'skills'), 'mercury-adapted'], { env });
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const plugins = pluginIds.map((id) => {
    // Use the built CLI's canonical packer, never a second plugin packaging implementation.
    const output = execFileSync(process.execPath, [path.join(root, 'dist', 'index.js'), 'plugins', 'pack', path.join(root, 'plugins', id), '--out', outDir], { cwd: root, env, encoding: 'utf8' });
    const start = output.indexOf('\n  {');
    const end = output.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error(`Canonical packer did not print a catalog entry: ${id}`);
    const entry = JSON.parse(output.slice(start, end + 1));
    const m = manifestFor(root, id);
    entry.tier = 'community';
    entry.artifact.url = `https://github.com/cosmicstack-labs/mercury-agent/releases/download/${dev ? 'mercury-dev-latest' : `v${version}`}/${id}-${m.version}.tgz`;
    return entry;
  });
  fs.writeFileSync(path.join(outDir, catalogAsset), `${JSON.stringify({ catalogVersion: 1, updatedAt: new Date().toISOString(), plugins }, null, 2)}\n`);
  verifyContent(root, outDir, { dev });
  return contentAssets(root).map((name) => path.join(outDir, name));
}

module.exports = { buildContent, verifyContent, contentAssets, inspectArchive };
