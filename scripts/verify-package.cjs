#!/usr/bin/env node
const { execSync } = require('child_process');
const { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } = require('fs');
const { join, resolve } = require('path');
const { tmpdir } = require('os');

const ROOT = resolve(__dirname, '..');
const TMP = join(tmpdir(), `mercury-pv-${process.pid}`);

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

console.log('\u263F Mercury Agent \u2014 Pack & Verify\n');
console.log('1/5 Building...');
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

console.log('\n2/5 Packing tarball...');
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const tarball = execSync('npm pack', { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n').pop();
const tarballPath = join(ROOT, tarball);
console.log(`  Tarball: ${tarball}`);

console.log('\n3/5 Installing from tarball...');
const installDir = join(TMP, 'install');
mkdirSync(installDir, { recursive: true });
writeFileSync(join(installDir, 'package.json'), '{}');
execSync(`npm install "${tarballPath}" --omit=dev --no-save`, { cwd: installDir, stdio: 'pipe' });

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

check('no dangling script references', () => {
  const pkg = JSON.parse(readFileSync(join(modDir, 'package.json'), 'utf-8'));
  const scripts = pkg.scripts || {};
  for (const [key, val] of Object.entries(scripts)) {
    if (val.includes('scripts/') || val.includes('bash ')) {
      throw new Error(`script "${key}" references unpublished path: ${val}`);
    }
  }
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

check('engines requires >=20', () => {
  const pkg = JSON.parse(readFileSync(join(modDir, 'package.json'), 'utf-8'));
  if (!pkg.engines || !pkg.engines.node || !pkg.engines.node.includes('20')) {
    throw new Error('engines.node should require >=20.0.0');
  }
});

console.log('\n5/5 Cleaning up...');
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
try { rmSync(tarballPath, { force: true }); } catch {}

if (failed) {
  console.log('\n\u2717 Verification FAILED \u2014 do not publish!\n');
  process.exit(1);
} else {
  console.log('\n\u2713 All checks passed \u2014 safe to publish.\n');
}