/**
 * Post-build script: copies static assets and builds the UI.
 * Cross-platform (works on Linux, macOS, Windows, Termux).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 0. ADR-017: the patched ink (vendor/ink) must be INSIDE the bundle — a
// bare `import "ink"` would load whatever stock ink npm put in node_modules
// and silently lose every fix (Static.itemKey, freeze gate, live-region
// guard, hardware cursor).
{
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'mercury.js'), 'utf8');
  const problems = [];
  if (/(?:from|import\()\s*["']ink["']/.test(bundle)) problems.push('dist/mercury.js imports "ink" at runtime (tsup alias/noExternal missing)');
  for (const marker of ['__mercuryFrameGate', '__mercuryCursorAnchor', 'maxLiveRows', 'setCommitTick', 'vendored: true']) {
    if (!bundle.includes(marker)) problems.push(`vendored ink marker missing from the bundle: ${marker}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('  ✓ patched ink is bundled (vendor/ink)');
}

// 0b. Standalone binaries have no node_modules: a CommonJS `require("pkg")`
// left in the bundle resolves at runtime only, so `bun build --compile`
// cannot see it and the binary throws "Cannot find package" when that code
// first runs (react-reconciler → react broke the TUI this way). Only node
// builtins may be required at runtime.
{
  const { builtinModules } = require('node:module');
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'mercury.js'), 'utf8');
  const runtime = new Set([...bundle.matchAll(/__require\("([^"]+)"\)/g)].map((m) => m[1]));
  const foreign = [...runtime].filter((id) => !id.startsWith('node:') && !builtinModules.includes(id.split('/')[0]));
  if (foreign.length) {
    console.error(`  ✗ runtime require of bundled-away packages (breaks standalone binaries): ${foreign.join(', ')}`);
    console.error('    add them to tsup noExternal so they are bundled');
    process.exit(1);
  }
  console.log('  ✓ no runtime requires of npm packages (binary-safe)');
}

// 1. Copy src/web/static -> dist/web/static
const staticSrc = path.join(__dirname, '..', 'src', 'web', 'static');
const staticDest = path.join(__dirname, '..', 'dist', 'web', 'static');
copyDirSync(staticSrc, staticDest);

// 2. Copy sql-wasm.wasm
const wasmSrc = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmDest = path.join(staticDest, 'vendor', 'sql-wasm.wasm');
fs.mkdirSync(path.dirname(wasmDest), { recursive: true });
fs.copyFileSync(wasmSrc, wasmDest);

// 3. Build UI (install deps if needed). Skip on Termux — esbuild has no
// prebuilt binary for android/x86_64, and the CLI agent does not need
// the web dashboard to run. The web UI is exercised by the linux/macos/
// windows CI jobs; Termux only needs to confirm the CLI builds.
const uiDir = path.join(__dirname, '..', 'ui');
const isTermux = process.env.TERMUX_VERSION || fs.existsSync('/data/data/com.termux');
if (isTermux) {
  console.log('  Skipping UI build on Termux (esbuild has no android/x86_64 prebuilt).');
} else {
  if (!fs.existsSync(path.join(uiDir, 'node_modules'))) {
    console.log('  Installing UI dependencies...');
    execSync('npm install', { cwd: uiDir, stdio: 'pipe' });
  }
  console.log('  Building UI...');
  try {
    execSync('npx vite build', { cwd: uiDir, stdio: 'pipe' });
  } catch (e) {
    // PWA terser plugin fails on Node <20 (crypto not defined) but assets are still built
    if (!fs.existsSync(path.join(uiDir, 'dist', 'index.html'))) {
      // Real failure — show output for debugging
      if (e.stdout) process.stderr.write(e.stdout);
      if (e.stderr) process.stderr.write(e.stderr);
      console.error('ERROR: Vite build failed and no output was produced');
      process.exit(1);
    }
  }
}

// 4. Copy ui/dist -> dist/web/ui
const uiDistSrc = path.join(uiDir, 'dist');
const uiDistDest = path.join(__dirname, '..', 'dist', 'web', 'ui');
if (fs.existsSync(uiDistSrc)) {
  copyDirSync(uiDistSrc, uiDistDest);
} else {
  console.log('  No ui/dist present (e.g. Termux build) — skipping UI copy.');
}

// 5. Write a self-unregistering service worker.
// PWA is currently disabled — any previously-installed SW would keep serving
// stale cached assets. This SW unregisters itself and clears all caches on
// activation, then reloads any controlled window clients.
const killSwitchSW = `// Self-unregistering service worker.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.navigate(client.url));
  })());
});
`;
if (fs.existsSync(uiDistDest)) {
  fs.writeFileSync(path.join(uiDistDest, 'sw.js'), killSwitchSW);
}

console.log('  ✓ Build complete');
