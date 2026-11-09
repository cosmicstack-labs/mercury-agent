#!/usr/bin/env node
const { execSync, execFileSync } = require('child_process');
const { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } = require('fs');
const assert = require('node:assert/strict');
const { dirname, join, resolve } = require('path');
const { tmpdir } = require('os');
const { packageVerificationEnv } = require('./package-verification-env.cjs');

const ROOT = resolve(__dirname, '..');
// Single source of truth for the packaged skill count. The slug list itself is
// derived from the directory below; this constant exists only so an accidental
// stray directory or a forgotten skill cannot pass silently.
const EXPECTED_SKILLS = 9;
const TMP = mkdtempSync(join(tmpdir(), 'mercury-pv-'));
let tarballPath;

let failed = false;

function check(label, fn) {
  try {
    fn();
    console.log(`  \u2713 ${label}`);
  } catch (err) {
    console.log(`  \u2717 ${label}: ${err.message}`);
    failed = true;
  }
}

try {
console.log('\u263F Mercury Agent \u2014 Pack & Verify\n');
console.log('1/5 Building...');
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

console.log('\n2/5 Packing tarball...');
// execFileSync cannot execute .cmd files on Windows. Use npm's JavaScript
// entry point there instead of a shell, preserving paths with spaces as data.
const npmCli = process.platform === 'win32'
  ? (process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  : null;
if (npmCli && !existsSync(npmCli)) throw new Error(`npm CLI not found: ${npmCli}`);
const npm = npmCli ? process.execPath : 'npm';
const npmArgs = npmCli ? [npmCli] : [];
const tarball = JSON.parse(execFileSync(npm, [...npmArgs, 'pack', '--json', '--pack-destination', TMP], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}))[0].filename;
tarballPath = join(TMP, tarball);
console.log(`  Tarball: ${tarball}`);

console.log('\n3/5 Installing from tarball...');
const installDir = join(TMP, 'install');
mkdirSync(installDir, { recursive: true });
writeFileSync(join(installDir, 'package.json'), '{}');
execFileSync(npm, [...npmArgs, 'install', tarballPath, '--omit=dev', '--no-save', '--no-audit', '--no-fund'], {
  cwd: installDir, stdio: 'pipe', timeout: 300_000,
});

const modDir = join(installDir, 'node_modules', '@cosmicstack', 'mercury-agent');

console.log('\n4/5 Verifying package integrity...');

check('package.json exists', () => {
  if (!existsSync(join(modDir, 'package.json'))) throw new Error('missing package.json');
});

check('dist/index.js exists', () => {
  if (!existsSync(join(modDir, 'dist', 'index.js'))) throw new Error('missing dist/index.js');
});

check('shebang present', () => {
  const head = readFileSync(join(modDir, 'dist', 'index.js'), 'utf-8').split('\n')[0];
  if (!head.includes('node')) throw new Error('no #!/usr/bin/env node shebang');
});

check('dist/index.js is the Node version launcher, dist/mercury.js the bundle', () => {
  if (!existsSync(join(modDir, 'dist', 'mercury.js'))) throw new Error('missing dist/mercury.js');
  const launcher = readFileSync(join(modDir, 'dist', 'index.js'), 'utf-8');
  // The check must run before any dependency loads: no static imports
  // other than node builtins, and the gate before the bundle import.
  const staticImports = [...launcher.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]);
  const foreign = staticImports.filter((s) => !s.startsWith('node:'));
  if (foreign.length) throw new Error(`launcher has static imports that load before the version check: ${foreign.join(', ')}`);
  const gate = launcher.indexOf('Mercury needs Node.js 22 or newer');
  const load = launcher.indexOf('./mercury.js');
  if (gate < 0 || load < 0 || gate > load) throw new Error('launcher must check the Node version before loading ./mercury.js');
});

check('no dangling script references', () => {
  const pkg = JSON.parse(readFileSync(join(modDir, 'package.json'), 'utf-8'));
  const scripts = pkg.scripts || {};
  const devOnlyScripts = ['build', 'build:ui', 'build:bin', 'build:bin:all', 'build:bin:force', 'build:bin:all:force', 'dev', 'lint', 'typecheck', 'test', 'test:watch', 'prepublishOnly', 'eval', 'lint:eslint', 'lint:ratchet', 'vendor:ink', 'vendor:ink:check'];
  for (const [key, val] of Object.entries(scripts)) {
    if (devOnlyScripts.includes(key)) continue;
    if (val.includes('bash ')) {
      throw new Error(`script "${key}" references unpublished path: ${val}`);
    }
    // A `scripts/<file>` reference is fine only when that file ships in the
    // tarball (e.g. the postinstall ink-patch fallback).
    for (const m of val.matchAll(/scripts\/[\w.-]+/g)) {
      if (!existsSync(join(modDir, m[0]))) {
        throw new Error(`script "${key}" references unpublished path ${m[0]}: ${val}`);
      }
    }
  }
});

check('patched ink is bundled into dist (ADR-017, no postinstall)', () => {
  const bundle = readFileSync(join(modDir, 'dist', 'mercury.js'), 'utf-8');
  if (/(?:from|import\()\s*["']ink["']/.test(bundle)) throw new Error('dist/mercury.js imports "ink" at runtime — the vendored build is not bundled');
  // Same markers as scripts/post-build.cjs (ink 8 patch set, ADR-019).
  for (const marker of ['__mercuryFrameGate', '__mercuryCursorAnchor', 'maxLiveRows', 'setCommitTick', 'vendored: true']) {
    if (!bundle.includes(marker)) throw new Error(`vendored ink marker missing from dist/mercury.js: ${marker}`);
  }
  const pkg = JSON.parse(readFileSync(join(modDir, 'package.json'), 'utf-8'));
  if (pkg.scripts && pkg.scripts.postinstall) throw new Error(`postinstall must not be needed any more (got: ${pkg.scripts.postinstall})`);
});

check('better-sqlite3 is optional', () => {
  const pkg = JSON.parse(readFileSync(join(modDir, 'package.json'), 'utf-8'));
  if (pkg.dependencies && pkg.dependencies['better-sqlite3']) {
    throw new Error('better-sqlite3 is in dependencies, not optionalDependencies');
  }
  if (!pkg.optionalDependencies || !pkg.optionalDependencies['better-sqlite3']) {
    throw new Error('better-sqlite3 missing from optionalDependencies');
  }
});

check('engines requires >=22', () => {
  const pkg = JSON.parse(readFileSync(join(modDir, 'package.json'), 'utf-8'));
  // ink 8 (the vendored TUI renderer) requires Node 22.
  if (!pkg.engines || !pkg.engines.node || !pkg.engines.node.includes('22')) {
    throw new Error('engines.node should require >=22.0.0');
  }
});

// Exercise the installed package, not the checkout. A fresh home prevents
// accidental access to the owner's daemon, plugin state or skill index.
const cliEnv = packageVerificationEnv(TMP);
function cli(...args) {
  return execFileSync(process.execPath, [join(modDir, 'dist', 'index.js'), ...args], {
    cwd: installDir, env: cliEnv, encoding: 'utf8', timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

check('all nine packaged skills install and reload byte-identically via the CLI', () => {
  const sourceRoot = join(ROOT, 'skills', 'mercury-adapted');
  const shippedRoot = join(modDir, 'skills', 'mercury-adapted');
  for (const name of ['README.md', 'LICENSE']) {
    assert.equal(readFileSync(join(shippedRoot, name), 'utf8'), readFileSync(join(sourceRoot, name), 'utf8'));
  }
  const slugs = readdirSync(sourceRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.equal(slugs.length, EXPECTED_SKILLS);
  assert.deepEqual(readdirSync(shippedRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(), slugs);
  const ids = [];
  for (const slug of slugs) {
    const source = readFileSync(join(sourceRoot, slug, 'SKILL.md'), 'utf8');
    const file = join(shippedRoot, slug, 'SKILL.md');
    assert.equal(readFileSync(file, 'utf8'), source, `packaged bytes: ${slug}`);
    const installed = JSON.parse(cli('skills', '--json', 'install', '--from', file, '-y'));
    assert.equal(installed.ok, true, slug);
    assert.equal(typeof installed.id, 'string', slug);
    ids.push(installed.id);
    assert.equal(cli('skills', 'view', installed.id, '--raw'), source, `reloaded bytes: ${slug}`);
  }
  const listed = JSON.parse(cli('skills', '--json', 'list'));
  assert.deepEqual(listed.skills.map((skill) => skill.id).sort(), ids.sort());
  assert.equal(new Set(ids).size, EXPECTED_SKILLS);
});

} catch (err) {
  console.error(`  \u2717 Package verification failed: ${err.stack || err.message}`);
  failed = true;
} finally {
  console.log('\n5/5 Cleaning up...');
  try { rmSync(TMP, { recursive: true, force: true }); } catch (err) {
    console.error(`Could not clean ${TMP}: ${err.message}`);
    failed = true;
  }
}

if (failed) {
  console.log('\n\u2717 Verification FAILED \u2014 do not publish!\n');
  process.exitCode = 1;
} else {
  console.log('\n\u2713 Package checks passed (credentials and release approval are separate).\n');
}