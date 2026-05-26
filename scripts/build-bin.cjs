/**
 * Build standalone Mercury binaries using `bun build --compile`.
 *
 * Why Bun (and not pkg / Node SEA)?
 *   Mercury's dependency graph includes ESM modules with top-level await
 *   (ink, yoga-layout) which can't be transformed to CommonJS. Both pkg
 *   and Node SEA require CJS entry points. Bun runs ESM natively and
 *   embeds its own JS runtime, so it sidesteps the whole problem.
 *
 * Output layout (versioned, never clobbers older builds):
 *   release/
 *     v1.1.9/
 *       mercury-macos-arm64
 *       mercury-macos-x64
 *       mercury-linux-x64
 *       mercury-linux-arm64
 *       mercury-win-x64.exe
 *       checksums.txt
 *     v1.2.0/ ...
 *     latest -> v1.2.0    (symlink to most-recent build)
 *
 * Version is read from package.json. Bumping the version there automatically
 * produces a new folder on the next build. If a binary already exists for
 * the current version+target, the script skips it unless --force is passed.
 *
 * Usage:
 *   node scripts/build-bin.cjs                # host target only
 *   node scripts/build-bin.cjs --all          # all configured targets
 *   node scripts/build-bin.cjs --force        # overwrite existing binaries
 *   node scripts/build-bin.cjs --all --force
 *
 * Cross-compilation:
 *   Bun ships its own runtime per target, so cross-compile works for JS.
 *   Native modules (e.g. better-sqlite3) cannot cross-compile, but
 *   Mercury's better-sqlite3 is optional and falls back to sql.js, so
 *   cross-compiled binaries still work end-to-end.
 */
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.join(__dirname, '..');
const releaseRoot = path.join(root, 'release');
const entry = path.join(root, 'dist', 'index.js');

// Read version straight from package.json — single source of truth.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const versionDir = path.join(releaseRoot, `v${version}`);

// All Bun-supported targets we want to ship. The `out` name is the file
// basename (without the version prefix — version lives in the parent folder).
const ALL_TARGETS = [
  { id: 'bun-darwin-arm64', out: 'mercury-macos-arm64' },
  { id: 'bun-darwin-x64',   out: 'mercury-macos-x64' },
  { id: 'bun-linux-x64',    out: 'mercury-linux-x64' },
  { id: 'bun-linux-arm64',  out: 'mercury-linux-arm64' },
  { id: 'bun-windows-x64',  out: 'mercury-win-x64.exe' },
];

function hostTarget() {
  const platform = process.platform;
  const arch = process.arch;
  const platMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
  const archMap = { x64: 'x64', arm64: 'arm64' };
  if (!platMap[platform] || !archMap[arch]) {
    console.error(`Unsupported host platform: ${platform}/${arch}`);
    process.exit(1);
  }
  const id = `bun-${platMap[platform]}-${archMap[arch]}`;
  // Match the same naming scheme as --all so files are predictable.
  const platName = platform === 'darwin' ? 'macos' : platMap[platform];
  const ext = platform === 'win32' ? '.exe' : '';
  const out = `mercury-${platName}-${arch}${ext}`;
  return { id, out };
}

function findBun() {
  try {
    execSync('command -v bun', { stdio: 'pipe' });
    return 'bun';
  } catch (_) {}
  const fallback = path.join(os.homedir(), '.bun', 'bin', 'bun');
  if (fs.existsSync(fallback)) return fallback;
  console.error('ERROR: bun not found. Install it from https://bun.sh');
  process.exit(1);
}

function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function compile(bun, target, { force }) {
  const outPath = path.join(versionDir, target.out);

  if (fs.existsSync(outPath) && !force) {
    const stat = fs.statSync(outPath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    console.log(`  ↷ skip (already built): ${path.relative(root, outPath)}  (${sizeMB} MB)`);
    console.log(`    pass --force to rebuild\n`);
    return { outPath, skipped: true };
  }

  const args = [
    'build',
    `"${entry}"`,
    '--compile',
    `--target=${target.id}`,
    `--outfile="${outPath.replace(/\.exe$/, '')}"`,
    '--minify',
  ];
  run(`"${bun}" ${args.join(' ')}`);

  // Bun appends .exe for windows targets automatically — handle both names.
  if (!fs.existsSync(outPath)) {
    const alt = outPath.replace(/\.exe$/, '');
    if (fs.existsSync(alt) && target.out.endsWith('.exe')) fs.renameSync(alt, outPath);
  }

  const stat = fs.statSync(outPath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  console.log(`  ✓ ${path.relative(root, outPath)}  (${sizeMB} MB)\n`);
  return { outPath, skipped: false };
}

function writeChecksums(builtPaths) {
  const checksumsPath = path.join(versionDir, 'checksums.txt');
  // Re-hash everything that exists in versionDir so re-runs keep the file
  // accurate even when only a subset was rebuilt.
  const entries = fs.readdirSync(versionDir)
    .filter((f) => f !== 'checksums.txt')
    .filter((f) => fs.statSync(path.join(versionDir, f)).isFile())
    .sort();
  const lines = entries.map((name) => `${sha256(path.join(versionDir, name))}  ${name}`);
  fs.writeFileSync(checksumsPath, lines.join('\n') + '\n');
  console.log(`  ✓ checksums.txt (${entries.length} file${entries.length === 1 ? '' : 's'})`);
}

function updateLatestSymlink() {
  const linkPath = path.join(releaseRoot, 'latest');
  try { fs.unlinkSync(linkPath); } catch (_) { /* doesn't exist yet */ }
  try {
    fs.symlinkSync(`v${version}`, linkPath, 'dir');
    console.log(`  ✓ release/latest → v${version}`);
  } catch (e) {
    // Windows without dev-mode can't create symlinks for non-admins; not fatal.
    console.warn(`  ! could not create release/latest symlink: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------

if (!fs.existsSync(entry)) {
  console.error(`ERROR: ${path.relative(root, entry)} not found. Run \`npm run build\` first.`);
  process.exit(1);
}

const args = process.argv.slice(2);
const buildAll = args.includes('--all');
const force = args.includes('--force');

fs.mkdirSync(versionDir, { recursive: true });

const bun = findBun();
const targets = buildAll ? ALL_TARGETS : [hostTarget()];

console.log(`\nMercury v${version} — building ${targets.length} target(s) with ${bun}`);
console.log(`Output: ${path.relative(root, versionDir)}/${force ? '  (force overwrite)' : ''}\n`);

const results = [];
for (const target of targets) {
  console.log(`→ ${target.id}`);
  results.push(compile(bun, target, { force }));
}

writeChecksums(results.map((r) => r.outPath));
updateLatestSymlink();

const built = results.filter((r) => !r.skipped).length;
const skipped = results.length - built;
console.log(`\nDone. ${built} built, ${skipped} skipped. Binaries in ${path.relative(root, versionDir)}/`);
