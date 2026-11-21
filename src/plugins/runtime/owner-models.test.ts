import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
mkdirSync(join(process.cwd(), '.vitest-tmp'), { recursive: true });
import { join } from 'node:path';
import { InProcessRuntime } from './in-process.js';
import { manifestSchema } from '../types.js';
import { OwnerTasks, _setOwnerTasks, ownerTasks } from '../../security/owner-tasks.js';

/** Plugin API 1.3: ctx.owner.ask and ctx.models.lookAt exist only for plugins that declared them. */
let dir = '';
afterEach(() => { _setOwnerTasks(null); rmSync(dir, { recursive: true, force: true }); delete (globalThis as Record<string, unknown>).__ctx; });

async function start(permissions: Record<string, unknown>) {
  dir = mkdtempSync(join(process.cwd(), '.vitest-tmp', 'plugin-owner-'));
  writeFileSync(join(dir, 'index.mjs'), 'export function activate(ctx) { globalThis.__ctx = ctx; }');
  const manifest = manifestSchema.parse({ manifestVersion: 1, id: 'probe', name: 'Probe', version: '0.1.0', description: 'test', kind: 'in-process', entry: 'index.mjs', engines: { mercury: '>=1.0.0', pluginApi: '^1.3.0' }, permissions });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const rt = new InProcessRuntime(manifest, dir, { mercuryVersion: '1.5.4', dataDir: dir, settings: {}, secrets: {}, log, onError() {} });
  await rt.start();
  return { rt, ctx: (globalThis as Record<string, any>).__ctx };
}

describe('plugin access to the owner and to models', () => {
  it('without the permissions, both throw', async () => {
    const { rt, ctx } = await start({});
    await expect(ctx.owner.ask({ title: 'Solve', prompt: 'Type it' })).rejects.toThrow(/askOwner/);
    await expect(ctx.models.lookAt({ prompt: 'Read', image: { mimeType: 'image/png', data: new Uint8Array([1]) } })).rejects.toThrow(/useModels/);
    await rt.stop();
  });

  it('with askOwner, a task reaches the owner named after the plugin, and the answer comes back', async () => {
    _setOwnerTasks(new OwnerTasks(Date.now, () => join(dir, 'tasks')));
    const { rt, ctx } = await start({ askOwner: true });
    const asking = ctx.owner.ask({ title: 'Solve this CAPTCHA', prompt: 'Type the letters', media: { mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) } });
    await vi.waitFor(() => expect(ownerTasks().pending()).toHaveLength(1));
    const [t] = ownerTasks().pending();
    expect(t.who).toBe('Probe (plugin)');
    expect(t.media?.kind).toBe('image');
    ownerTasks().answer(t.code, 'q7k2', 'app');
    await expect(asking).resolves.toEqual({ status: 'answered', answer: 'q7k2' });
    await rt.stop();
  });

  it('stopping the plugin cancels its open task', async () => {
    _setOwnerTasks(new OwnerTasks(Date.now, () => join(dir, 'tasks')));
    const { rt, ctx } = await start({ askOwner: true });
    const asking = ctx.owner.ask({ title: 'Code', prompt: 'Send it' });
    await vi.waitFor(() => expect(ownerTasks().pending()).toHaveLength(1));
    await rt.stop();
    await expect(asking).resolves.toEqual({ status: 'cancelled' });
  });
});
