/**
 * Ensure the bundled ink patch (patches/ink+5.2.1.patch) is applied to the
 * installed ink. Idempotent: checks for the fix marker first.
 *
 * Why this exists as a standalone script: newer npm policies may block
 * lifecycle scripts (`npm warn install-scripts`), so `postinstall` cannot be
 * the ONLY place the patch is applied. The build pipeline (post-build.cjs)
 * runs on every build regardless of install-script policy, so it calls this.
 * The un-patched ink has the freed-Yoga-node crash class — every <Static>
 * unmount in the TUI is a latent WASM trap — so a silent skip is never
 * acceptable: failures are LOUD.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const reconcilerPath = path.join(root, 'node_modules', 'ink', 'build', 'reconciler.js');
const staticPath = path.join(root, 'node_modules', 'ink', 'build', 'components', 'Static.js');
const patchPath = path.join(root, 'patches', 'ink+5.2.1.patch');

const MARKERS = ['clearYogaRefs', 'itemKey'];

function isPatched() {
  if (!fs.existsSync(reconcilerPath)) return false;
  const reconciler = fs.readFileSync(reconcilerPath, 'utf8');
  const staticComponent = fs.existsSync(staticPath)
    ? fs.readFileSync(staticPath, 'utf8')
    : '';
  return reconciler.includes('clearYogaRefs')
    && reconciler.includes('Array.isArray(node.childNodes)')
    && reconciler.includes('rootNode.staticNode = undefined')
    && staticComponent.includes('itemKey');
}

function apply() {
  if (isPatched()) return { ok: true, applied: false };
  if (!fs.existsSync(patchPath)) {
    return { ok: false, applied: false, error: 'patches/ink+5.2.1.patch is missing from the install' };
  }
  try {
    execSync('npx --yes patch-package ink', {
      cwd: root,
      stdio: 'pipe',
    });
  } catch (err) {
    return { ok: false, applied: true, error: `patch-package failed: ${err.message}` };
  }
  if (!isPatched()) {
    return { ok: false, applied: true, error: 'patch ran but the fix markers are still missing' };
  }
  return { ok: true, applied: true };
}

module.exports = { isPatched, apply };

if (require.main === module) {
  const result = apply();
  if (result.ok && result.applied) {
    console.log('  ✓ ink patch applied (Yoga WASM crash fixes + Static identity dedup)');
  } else if (result.ok) {
    console.log('  ✓ ink patch already applied');
  } else {
    console.error('  ⚠ INK PATCH NOT APPLIED — the Yoga WASM crash class is UNPATCHED in this install.');
    console.error(`    Reason: ${result.error}`);
    console.error('    Fix: run `npx patch-package ink` in the repo root, or reinstall with scripts enabled.');
  }
}