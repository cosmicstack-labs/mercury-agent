// Build a per-platform plugin package from a compiled companion binary:
//   node plugins/whatsapp/package.mjs <binary> <platform-key> <out-dir>
// Writes <out-dir>/mercury-plugin-<platform-key>.tgz containing the
// manifest (with this platform and the binary's SHA-256 pinned), the
// binary under bin/, and the README.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [binary, platform, outDir] = process.argv.slice(2);
if (!binary || !platform || !outDir) {
  console.error('usage: node package.mjs <binary> <platform-key> <out-dir>');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'mercury-plugin.template.json'), 'utf8'));
const exe = platform.startsWith('win32') ? 'mercury-wa.exe' : 'mercury-wa';
const rel = `bin/${exe}`;

const stage = mkdtempSync(join(tmpdir(), 'mercury-wa-pkg-'));
mkdirSync(join(stage, 'bin'));
copyFileSync(binary, join(stage, rel));
chmodSync(join(stage, rel), 0o755);
copyFileSync(join(here, 'README.md'), join(stage, 'README.md'));

manifest.platforms = [platform];
manifest.checksums = { [rel]: createHash('sha256').update(readFileSync(join(stage, rel))).digest('hex') };
writeFileSync(join(stage, 'mercury-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `mercury-plugin-${platform}.tgz`);
// Archive name relative to cwd: GNU tar on Windows reads "D:\\…" as a remote host.
execFileSync('tar', ['-czf', basename(out), '-C', stage, 'mercury-plugin.json', 'bin', 'README.md'], { cwd: dirname(out) });
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  mercury-plugin-${platform}.tgz\n`);
rmSync(stage, { recursive: true, force: true });
console.log(`${out}\n${sha}`);
