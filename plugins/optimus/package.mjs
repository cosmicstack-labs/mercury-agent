// Build a per-platform plugin package from a compiled companion binary:
//   node plugins/optimus/package.mjs <binary> <platform-key> <out-dir> [fallback-libs-dir]
// Writes <out-dir>/mercury-plugin-<platform-key>.tgz containing the
// manifest (with this platform and every file's SHA-256 pinned), the
// binary under bin/, and the README.
//
// Linux packages start through linux/mercury-optimus.sh (bin/mercury-optimus),
// which runs bin/mercury-optimus-bin and falls back to the libraries in
// fallback-libs-dir (copied to lib/<soname>/) only when the system lacks one.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [binary, platform, outDir, fallbackLibs] = process.argv.slice(2);
if (!binary || !platform || !outDir) {
  console.error('usage: node package.mjs <binary> <platform-key> <out-dir>');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'mercury-plugin.template.json'), 'utf8'));
const exe = platform.startsWith('win32') ? 'mercury-optimus.exe' : 'mercury-optimus';
const rel = `bin/${exe}`;

const linux = platform.startsWith('linux');

const stage = mkdtempSync(join(tmpdir(), 'mercury-optimus-pkg-'));
mkdirSync(join(stage, 'bin'));
const entries = ['mercury-plugin.json', 'bin', 'README.md'];
if (linux) {
  copyFileSync(binary, join(stage, 'bin/mercury-optimus-bin'));
  chmodSync(join(stage, 'bin/mercury-optimus-bin'), 0o755);
  copyFileSync(join(here, 'linux/mercury-optimus.sh'), join(stage, rel));
  if (fallbackLibs && existsSync(fallbackLibs)) {
    cpSync(fallbackLibs, join(stage, 'lib'), { recursive: true });
    entries.push('lib');
  }
} else {
  copyFileSync(binary, join(stage, rel));
}
chmodSync(join(stage, rel), 0o755);
copyFileSync(join(here, 'README.md'), join(stage, 'README.md'));

/** Every file under bin/ and lib/, relative to the package root. */
const files = (dir) => readdirSync(join(stage, dir)).flatMap((n) => {
  const r = `${dir}/${n}`;
  return statSync(join(stage, r)).isDirectory() ? files(r) : [r];
});
manifest.platforms = [platform];
manifest.checksums = Object.fromEntries(
  entries.filter((e) => e === 'bin' || e === 'lib').flatMap(files).sort()
    .map((f) => [f, createHash('sha256').update(readFileSync(join(stage, f))).digest('hex')]),
);
writeFileSync(join(stage, 'mercury-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `mercury-plugin-${platform}.tgz`);
// Archive name relative to cwd: GNU tar on Windows reads "D:\\…" as a remote host.
execFileSync('tar', ['-czf', basename(out), '-C', stage, ...entries], { cwd: dirname(out) });
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  mercury-plugin-${platform}.tgz\n`);
rmSync(stage, { recursive: true, force: true });
console.log(`${out}\n${sha}`);
