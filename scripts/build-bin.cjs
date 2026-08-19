/**
 * Build standalone Mercury binaries using `bun build --compile`.
 *
 * Why Bun (and not pkg / Node SEA)?
 *   Mercury's dependency graph includes ESM modules with top-level await
 *   (ink, yoga-layout) which can't be transformed to CommonJS. Both pkg
 *   and Node SEA require CJS entry points. Bun runs ESM natively and
 *   embeds its own JS runtime, so it sidesteps the whole problem.
 *
 * Output layout (versioned, never clobbers older releases):
 *   release/
 *     v1.1.9/
 *       mercury-macos-arm64
 *       mercury-macos-x64
 *       mercury-linux-x64
 *       mercury-linux-arm64
 *       mercury-win-x64.exe
 *       web.tar.gz
 *       checksums.txt
 *     v1.2.0/ ...
 *     smoke/v1.2.0/ ...         ← non-publishable host-only builds
 *     latest -> v1.2.0    (symlink to most-recent build)
 *
 * `--all` is the release-producing mode. It refuses to mix with an existing
 * version directory unless --force is passed, in which case the directory is
 * deleted first. Host builds are isolated under release/smoke.
 *
 * Usage:
 *   node scripts/build-bin.cjs                # host target only
 *   node scripts/build-bin.cjs --all          # all configured targets
 *   node scripts/build-bin.cjs --force        # overwrite existing binaries
 *   node scripts/build-bin.cjs --all --force
 *
 * Cross-compilation:
 *   Bun ships its own runtime per target, so cross-compile works for JS.
 *   Native addons still need target-specific packaging; sql.js is not a
 *   general fallback for every better-sqlite3-backed feature.
 */
const { execFileSync, execSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.join(__dirname, '..');
const releaseRoot = path.join(root, 'release');
const entry = path.join(root, 'dist', 'index.js');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name.endsWith('.map')) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Read version straight from package.json — single source of truth.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

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
  const target = ALL_TARGETS.find((candidate) => candidate.id === id);
  if (!target) {
    console.error(`Unsupported host target: ${id}`);
    process.exit(1);
  }
  return target;
}

function findBun() {
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [executable, path.join(os.homedir(), '.bun', 'bin', executable)];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) return candidate;
  }
  console.error('ERROR: bun not found. Install it from https://bun.sh');
  process.exit(1);
}

function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function compile(bun, target, { force, versionDir }) {
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
  const command = `"${bun}" ${args.join(' ')}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      run(command);
      break;
    } catch (error) {
      fs.rmSync(outPath, { force: true });
      fs.rmSync(outPath.replace(/\.exe$/, ''), { force: true });
      if (attempt === 3) throw error;
      const delay = attempt * 2_000;
      console.warn(`  ! ${target.id} compile failed; retrying in ${delay / 1000}s (${attempt}/3)`);
      sleepSync(delay);
    }
  }

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

function createWebArchive(versionDir, { required }) {
  const webSrc = path.join(root, 'dist', 'web');
  const webDest = path.join(versionDir, 'web');
  const webTarPath = path.join(versionDir, 'web.tar.gz');
  fs.rmSync(webDest, { recursive: true, force: true });
  fs.rmSync(webTarPath, { force: true });

  if (!fs.existsSync(webSrc)) {
    const message = 'dist/web/ not found. Run `npm run build` first.';
    if (required) throw new Error(message);
    console.warn(`  ⚠ ${message} Skipping web.tar.gz for this smoke build.`);
    return null;
  }

  copyDirSync(webSrc, webDest);
  execFileSync('tar', ['-czf', webTarPath, '-C', versionDir, 'web'], { cwd: root, stdio: 'pipe' });
  if (required) fs.rmSync(webDest, { recursive: true, force: true });
  const sizeKB = (fs.statSync(webTarPath).size / 1024).toFixed(0);
  console.log(`  ✓ web.tar.gz (${sizeKB} KB)`);
  return webTarPath;
}

function writeChecksums(versionDir, assetPaths) {
  const checksumsPath = path.join(versionDir, 'checksums.txt');
  const files = assetPaths.filter(Boolean).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const lines = files.map((filePath) => `${sha256(filePath)}  ${path.basename(filePath)}`);
  fs.writeFileSync(checksumsPath, lines.join('\n') + '\n');
  console.log(`  ✓ checksums.txt (${files.length} file${files.length === 1 ? '' : 's'})`);
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
const unknownArgs = args.filter((arg) => arg !== '--all' && arg !== '--force');
if (unknownArgs.length > 0) {
  console.error(`ERROR: unknown argument(s): ${unknownArgs.join(', ')}`);
  process.exit(1);
}

const versionDir = buildAll
  ? path.join(releaseRoot, `v${version}`)
  : path.join(releaseRoot, 'smoke', `v${version}`);
if (!buildAll && force) fs.rmSync(versionDir, { recursive: true, force: true });
if (buildAll && fs.existsSync(versionDir)) {
  if (!force && fs.readdirSync(versionDir).length > 0) {
    console.error(`ERROR: ${path.relative(root, versionDir)} already contains release assets.`);
    console.error('Refusing to mix revisions. Re-run with --all --force to replace the entire release directory.');
    process.exit(1);
  }
  fs.rmSync(versionDir, { recursive: true, force: true });
}
fs.mkdirSync(versionDir, { recursive: true });

const bun = findBun();
const targets = buildAll ? ALL_TARGETS : [hostTarget()];

console.log(`\nMercury v${version} — building ${targets.length} ${buildAll ? 'release' : 'host smoke'} target(s) with ${bun}`);
console.log(`Output: ${path.relative(root, versionDir)}/${force ? '  (force overwrite)' : ''}\n`);

const results = [];
for (const target of targets) {
  console.log(`→ ${target.id}`);
  results.push(compile(bun, target, { force, versionDir }));
}

const webTarPath = createWebArchive(versionDir, { required: buildAll });
writeChecksums(versionDir, [...results.map((result) => result.outPath), webTarPath]);

if (buildAll) {
  execFileSync(process.execPath, [path.join(__dirname, 'verify-standalone-release.cjs'), versionDir], {
    cwd: root,
    stdio: 'inherit',
  });
  updateLatestSymlink();
}

const built = results.filter((r) => !r.skipped).length;
const skipped = results.length - built;
console.log(`\nDone. ${built} built, ${skipped} skipped. Binaries in ${path.relative(root, versionDir)}/`);
