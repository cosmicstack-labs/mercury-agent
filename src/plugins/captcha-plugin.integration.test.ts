import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from 'ai';
import { PermissionManager } from '../capabilities/permissions.js';
import { PluginManager } from './manager.js';
import { getPluginTools, resetToolBridge } from './tool-bridge.js';
import { tempHome } from './test-fixtures.js';
import { OwnerTasks, _setOwnerTasks, ownerTasks } from '../security/owner-tasks.js';

/** The real plugins/captcha package, installed and called the way the model calls it. */
let env: ReturnType<typeof tempHome>;
let mgr: PluginManager;
beforeEach(() => {
  env = tempHome();
  resetToolBridge();
  mgr = new PluginManager({ safeMode: false, notify: () => {} });
  _setOwnerTasks(new OwnerTasks(Date.now, () => join(env.home, 'tasks')));
});
afterEach(async () => { await mgr.shutdown(); _setOwnerTasks(null); env.restore(); });

async function install() {
  const src = join(env.home, 'src', 'captcha');
  mkdirSync(src, { recursive: true });
  cpSync(join(process.cwd(), 'plugins', 'captcha'), src, { recursive: true });
  // The package needs the release that ships Plugin API 1.3; this checkout may still carry the previous version number.
  const manifestPath = join(src, 'mercury-plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.engines.mercury = '>=1.5.4 <2.0.0';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await mgr.install(src);
  // No service: only own models (none in tests), then the owner.
  await mgr.setSetting('captcha', 'service', 'none');
  await mgr.setSetting('captcha', 'useOwnModels', false);
}

const call = (tools: Record<string, Tool>, name: string, args: Record<string, unknown>) =>
  (tools[name] as Tool & { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, { toolCallId: 't1', messages: [] });

describe('CAPTCHA plugin, installed', () => {
  it('installs with its declared permissions and tools', async () => {
    await install();
    const tools = getPluginTools(new PermissionManager());
    expect(Object.keys(tools).sort()).toEqual(['captcha__balance', 'captcha__detect', 'captcha__solve']);
  });

  it('the owner gets the image and their answer comes back as the solve result', async () => {
    await install();
    const img = join(env.home, 'c.png');
    writeFileSync(img, Buffer.from('89504e470d0a1a0a', 'hex'));
    const pm = new PermissionManager();
    pm.setAutoApproveAll(true);
    const solving = call(getPluginTools(pm), 'captcha__solve', { type: 'image', image_path: img, page_url: 'https://shop.example/login' });
    await vi.waitFor(() => expect(ownerTasks().pending()).toHaveLength(1));
    const [t] = ownerTasks().pending();
    expect(t).toMatchObject({ who: 'CAPTCHA Solver (plugin)', title: 'Solve this CAPTCHA', link: 'https://shop.example/login' });
    ownerTasks().answer(t.code, 'k9xm', 'telegram');
    const out = JSON.parse(String(await solving));
    expect(out).toMatchObject({ solved: true, value: 'k9xm', method: 'owner' });
  });

  it('from a bot (fail-closed), nobody is asked', async () => {
    await install();
    const pm = new PermissionManager();
    pm.setFailClosed(true);
    // A bot's gate must allow the plugin tool explicitly; approve it for this test.
    vi.spyOn(pm, 'approvePluginTool').mockResolvedValue(true);
    const out = JSON.parse(String(await call(getPluginTools(pm), 'captcha__solve', { type: 'turnstile', page_url: 'https://x.com', site_key: 'K' })));
    expect(out.solved).toBe(false);
    expect(out.why).toContain('not asked (unattended run)');
    expect(ownerTasks().pending()).toEqual([]);
  });
});
