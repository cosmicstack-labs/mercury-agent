// Build the platform-independent plugin package:
//   node plugins/captcha/package.mjs <out-dir>
// Writes <out-dir>/mercury-plugin-captcha.tgz (manifest with checksums, the
// entry module, README) and its .sha256.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node package.mjs <out-dir>'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'mercury-plugin.json'), 'utf8'));
const stage = mkdtempSync(join(tmpdir(), 'mercury-captcha-pkg-'));
for (const f of ['index.mjs', 'README.md']) copyFileSync(join(here, f), join(stage, f));
manifest.checksums = { 'index.mjs': createHash('sha256').update(readFileSync(join(stage, 'index.mjs'))).digest('hex') };
writeFileSync(join(stage, 'mercury-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, 'mercury-plugin-captcha.tgz');
execFileSync('tar', ['-czf', basename(out), '-C', stage, 'mercury-plugin.json', 'index.mjs', 'README.md'], { cwd: dirname(out) });
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  mercury-plugin-captcha.tgz\n`);
rmSync(stage, { recursive: true, force: true });
console.log(`${out}\n${sha}\n${readFileSync(out).length} bytes`);
