/**
 * Copies the install scripts from the repo's scripts/ directory into the
 * Docusaurus static/ folder so they're published at:
 *   https://mercury.cosmicstack.org/install.sh
 *   https://mercury.cosmicstack.org/install.ps1
 *
 * Runs automatically as a pre-build hook (see website/package.json).
 * Keeping a single source of truth in scripts/ avoids drift between the
 * installer the repo ships and the one users curl from the website.
 */
const fs = require('node:fs');
const path = require('node:path');

const root        = path.join(__dirname, '..', '..');
const sourceDir   = path.join(root, 'scripts');
const targetDir   = path.join(__dirname, '..', 'static');

const files = ['install.sh', 'install.ps1'];

fs.mkdirSync(targetDir, { recursive: true });
for (const name of files) {
  const src = path.join(sourceDir, name);
  const dst = path.join(targetDir, name);
  if (!fs.existsSync(src)) {
    console.warn(`  ! ${name} not found in scripts/ — skipping`);
    continue;
  }
  fs.copyFileSync(src, dst);
  // Preserve executable bit for the shell installer.
  if (name.endsWith('.sh')) fs.chmodSync(dst, 0o755);
  console.log(`  ✓ copied ${name} → website/static/`);
}
