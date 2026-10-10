#!/usr/bin/env node
/**
 * Regenerate `vendor/ink/` — the patched ink build Mercury bundles (ADR-017).
 *
 *   node scripts/vendor-ink.cjs [--tarball <ink-8.0.0.tgz>] [--check]
 *
 * Pipeline, fully deterministic from a pinned stock tarball:
 *   1. obtain the stock `ink@8.0.0` tarball (the given path, or `npm pack`
 *      into a temp dir) and verify its registry integrity (sha512);
 *   2. extract it and copy only what the runtime needs — `build/` (minus
 *      source maps), `package.json` (trimmed of dev-only fields), `license`;
 *   3. run the Mercury patch set (`scripts/apply-ink-patch.cjs`, the single
 *      source of truth for every hunk) against the copy and stamp it as
 *      vendored (`inkPatch.vendored = true`);
 *   4. rewrite `patches/ink+8.0.0.patch` as `git diff --no-index` of stock
 *      vs patched `build/`, so the whole delta stays reviewable in one file.
 *
 * `--check` performs steps 1-3 into a temp dir and fails if the result
 * differs from the committed `vendor/ink` — CI can use it to prove the
 * committed files are exactly tarball + patch, nothing hand-edited.
 *
 * tsup and vitest alias `ink` → `vendor/ink/build/index.js`, so the patched
 * renderer ships inside dist/index.js and the standalone binaries on every
 * install path (npm, Bun --compile, Termux) with no postinstall step.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { apply, isPatched, pathsFor } = require('./apply-ink-patch.cjs');

const root = path.join(__dirname, '..');
const INK_VERSION = '8.0.0';
/** `dist.integrity` of ink@8.0.0 on registry.npmjs.org. */
const INK_INTEGRITY = 'sha512-M2aFwZOqmkFxCwedy6xrP4E+DGoK57iahAFnfTqNyOyJ54O7DZzu027z/NI8EGy44Sw9O9BcbTF4QEUS2GHAtg==';
const VENDOR_DIR = path.join(root, 'vendor', 'ink');
const PATCH_FILE = path.join(root, 'patches', `ink+${INK_VERSION}.patch`);
/** package.json fields that only matter for developing ink itself. */
const DROP_PKG_FIELDS = ['scripts', 'devDependencies', 'ava', 'xo', 'prettier', 'files'];

function parseArgs(argv) {
  const opts = { tarball: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tarball') opts.tarball = path.resolve(argv[++i] || '');
    else if (argv[i] === '--check') opts.check = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return opts;
}

function integrityOf(file) {
  return 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function obtainTarball(explicit, tmp) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`tarball not found: ${explicit}`);
    return explicit;
  }
  console.log(`  fetching ink@${INK_VERSION} with npm pack …`);
  execFileSync('npm', ['pack', `ink@${INK_VERSION}`, '--pack-destination', tmp], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  const found = fs.readdirSync(tmp).find((f) => f.startsWith('ink-') && f.endsWith('.tgz'));
  if (!found) throw new Error('npm pack produced no tarball');
  return path.join(tmp, found);
}

/** Source maps are not needed at runtime (and tsup emits its own). */
const isRuntimeFile = (name) => !name.endsWith('.map');

/** Drop `.map` files and the `//# sourceMappingURL=` trailers that point at
 * them (vitest/vite and esbuild would otherwise warn on every load). */
function stripSourceMaps(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) stripSourceMaps(p);
    else if (!isRuntimeFile(entry.name)) fs.rmSync(p);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      const src = fs.readFileSync(p, 'utf8');
      const out = src.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
      if (out !== src) fs.writeFileSync(p, out);
    }
  }
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() && !isRuntimeFile(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** Build the vendored tree into `outDir` from `tarball`; returns the stock package dir. */
function buildVendored(tarball, tmp, outDir) {
  const got = integrityOf(tarball);
  if (got !== INK_INTEGRITY) {
    throw new Error(`tarball integrity mismatch for ${tarball}\n    expected ${INK_INTEGRITY}\n    got      ${got}`);
  }
  const extractDir = path.join(tmp, 'stock');
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir]);
  const stockPkg = path.join(extractDir, 'package');
  const stockJson = JSON.parse(fs.readFileSync(path.join(stockPkg, 'package.json'), 'utf8'));
  if (stockJson.name !== 'ink' || stockJson.version !== INK_VERSION) {
    throw new Error(`tarball is ${stockJson.name}@${stockJson.version}, expected ink@${INK_VERSION}`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  copyTree(path.join(stockPkg, 'build'), path.join(outDir, 'build'));
  fs.copyFileSync(path.join(stockPkg, 'license'), path.join(outDir, 'license'));
  for (const field of DROP_PKG_FIELDS) delete stockJson[field];
  stockJson._mercury = {
    source: `ink@${INK_VERSION}`,
    integrity: INK_INTEGRITY,
    patched: true,
    generator: 'scripts/vendor-ink.cjs',
    note: 'Generated file set: stock tarball + scripts/apply-ink-patch.cjs. Do not hand-edit; see docs/ink-patch.md.',
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(stockJson, null, '\t') + '\n');

  const inkDir = path.join(outDir, 'build');
  const result = apply({ inkDir });
  if (!result.ok || !result.applied) {
    throw new Error(`patch set did not apply cleanly: ${result.error || 'nothing applied — stock tarball already carries markers?'}`);
  }
  const inkJs = path.join(inkDir, 'ink.js');
  const stamped = fs.readFileSync(inkJs, 'utf8').replace('    vendored: false,', '    vendored: true,');
  if (!stamped.includes('vendored: true')) throw new Error('could not stamp inkPatch.vendored in ink.js');
  fs.writeFileSync(inkJs, stamped);
  stripSourceMaps(inkDir);
  if (!isPatched(pathsFor(root, { inkDir }))) throw new Error('markers missing after apply');
  return stockPkg;
}

/** `patches/ink+<v>.patch`: stock build/ vs vendored build/, patch-package style paths. */
function writePatchFile(stockPkg, outDir) {
  // Compare like with like: the vendored tree carries no source maps.
  stripSourceMaps(path.join(stockPkg, 'build'));
  const r = spawnSync('git', [
    '-c', 'core.autocrlf=false', '-c', 'color.diff=never',
    'diff', '--no-index', '--src-prefix=a/node_modules/ink/', '--dst-prefix=b/node_modules/ink/',
    'build', path.join(outDir, 'build'),
  ], { cwd: stockPkg, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    console.warn(`  ! git not available — patches file not regenerated (${r.error.message})`);
    return false;
  }
  if ((r.status !== 0 && r.status !== 1) || !r.stdout.trim()) throw new Error(`git diff failed (status ${r.status}): ${r.stderr}`);
  // git prints the vendored side with the relative path we passed; normalise
  // both sides to `node_modules/ink/build/...` so the file reads like the
  // patch-package diff it replaces.
  const vendoredRel = path.join(outDir, 'build').split(path.sep).join('/').replace(/^\//, '');
  const text = r.stdout
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ') || line.startsWith('+++ ') || line.startsWith('--- ')) {
        return line.split(`b/node_modules/ink/${vendoredRel}`).join('b/node_modules/ink/build');
      }
      return line;
    })
    .join('\n');
  fs.mkdirSync(path.dirname(PATCH_FILE), { recursive: true });
  fs.writeFileSync(PATCH_FILE, text);
  return true;
}

function treesEqual(a, b) {
  const fa = listFiles(a);
  const fb = listFiles(b);
  if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return { equal: false, why: 'file lists differ' };
  for (const f of fa) {
    if (!fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))) return { equal: false, why: `${f} differs` };
  }
  return { equal: true };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-vendor-ink-'));
  try {
    const tarball = obtainTarball(opts.tarball, tmp);
    console.log(`  tarball: ${tarball}`);
    if (opts.check) {
      const candidate = path.join(tmp, 'vendor-ink');
      buildVendored(tarball, tmp, candidate);
      const cmp = treesEqual(candidate, VENDOR_DIR);
      if (!cmp.equal) {
        console.error(`  ✗ vendor/ink is NOT tarball + patch: ${cmp.why}. Run: node scripts/vendor-ink.cjs`);
        process.exitCode = 1;
        return;
      }
      console.log('  ✓ vendor/ink matches stock tarball + patch set');
      return;
    }
    const stockPkg = buildVendored(tarball, tmp, VENDOR_DIR);
    const wrotePatch = writePatchFile(stockPkg, VENDOR_DIR);
    console.log(`  ✓ vendor/ink regenerated from ink@${INK_VERSION} (${listFiles(VENDOR_DIR).length} files)`);
    if (wrotePatch) console.log(`  ✓ ${path.relative(root, PATCH_FILE)} rewritten`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`  ✗ vendor-ink failed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { INK_VERSION, INK_INTEGRITY, VENDOR_DIR, buildVendored, treesEqual };
