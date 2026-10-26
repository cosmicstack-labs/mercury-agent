import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PluginManager } from './manager.js';
import { outOfProcessPlugin, tempHome } from './test-fixtures.js';
import { resetToolBridge } from './tool-bridge.js';

let env: ReturnType<typeof tempHome>;
let mgr: PluginManager;
beforeEach(() => { env = tempHome(); resetToolBridge(); mgr = new PluginManager({ safeMode: false, notify: () => {} }); });
afterEach(async () => { await mgr.shutdown(); env.restore(); });

// Regression: boot() with nothing installed left a settled promise in
// `reconciling`, so a later install into the running daemon never started.
it('install into a running manager starts it (fresh, and after uninstall)', async () => {
  const src = join(env.home, 'src'); mkdirSync(src, { recursive: true });
  await mgr.boot();
  const dir = outOfProcessPlugin(src, { id: 'oop' });
  await mgr.install(dir);
  expect((await mgr.info('oop'))?.running).toBe(true);
  await mgr.uninstall('oop');
  await mgr.install(dir);
  expect((await mgr.info('oop'))?.running).toBe(true);
});

it('a reconcile requested mid-pass runs again and sees the change', async () => {
  const src = join(env.home, 'src'); mkdirSync(src, { recursive: true });
  await mgr.boot();
  const a = outOfProcessPlugin(src, { id: 'oop-a' });
  const b = outOfProcessPlugin(src, { id: 'oop-b' });
  await Promise.all([mgr.install(a), mgr.install(b)]);
  expect((await mgr.info('oop-a'))?.running).toBe(true);
  expect((await mgr.info('oop-b'))?.running).toBe(true);
});
