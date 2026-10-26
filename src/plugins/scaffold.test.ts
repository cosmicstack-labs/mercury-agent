import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginManager } from './manager.js';
import { runConformance } from './conformance.js';
import { packPlugin, scaffoldPlugin } from './scaffold.js';
import { PLUGIN_SDK_DTS } from './sdk-dts.js';
import { readState } from './store.js';
import { getPluginTools, resetToolBridge } from './tool-bridge.js';
import { PermissionManager } from '../capabilities/permissions.js';
import { tempHome } from './test-fixtures.js';

let env: ReturnType<typeof tempHome>;
let mgr: PluginManager;
beforeEach(() => { env = tempHome(); resetToolBridge(); mgr = new PluginManager({ safeMode: false, notify: () => {} }); });
afterEach(async () => { await mgr.shutdown(); resetToolBridge(); env.restore(); });

describe('author tooling', () => {
  it('the embedded SDK types match src/plugins/sdk.ts (run: node scripts/gen-plugin-sdk.mjs)', () => {
    // Git may check sdk.ts out with CRLF endings on Windows; the embedded copy is always LF.
    expect(PLUGIN_SDK_DTS).toBe(readFileSync(join(process.cwd(), 'src/plugins/sdk.ts'), 'utf8').replace(/\r\n/g, '\n'));
  });

  for (const kind of ['in-process', 'out-of-process'] as const) {
    it(`a fresh ${kind} scaffold passes conformance, packs, installs and works`, async () => {
      const dir = scaffoldPlugin(env.home, kind === 'in-process' ? 'hello-world' : 'hello-mcp', kind);
      const report = await runConformance(dir);
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);

      const packed = await packPlugin(dir, join(env.home, 'out'));
      expect(packed.entry.artifact?.sha256).toBe(packed.sha256);
      await mgr.install(packed.file);
      const id = report.id!;
      expect(readState().plugins[id]).toMatchObject({ version: '0.1.0', enabled: true });

      const tools = getPluginTools(new PermissionManager());
      const greet = tools[`${id}__greet`] as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> };
      expect(await greet.execute({ name: 'Ada' }, { toolCallId: 't', messages: [] })).toBe('Hello, Ada!');
    });
  }

  it('refuses ids that would take a built-in command', () => {
    expect(() => scaffoldPlugin(env.home, 'help', 'in-process')).toThrow();
    expect(() => scaffoldPlugin(env.home, 'stop', 'in-process')).toThrow(/built-in/);
  });
});
