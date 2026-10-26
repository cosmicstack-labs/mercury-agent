import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_COMMANDS } from './types.js';
import { manifestSchema } from './types.js';

const root = dirname(fileURLToPath(import.meta.url));

describe('reserved command names', () => {
  it('cover every built-in in the TUI autocomplete list (SLASH_COMMANDS)', () => {
    const src = readFileSync(join(root, '..', 'ui', 'input-composer.tsx'), 'utf8');
    const block = src.slice(src.indexOf('export const SLASH_COMMANDS'), src.indexOf('];', src.indexOf('export const SLASH_COMMANDS')));
    const names = [...block.matchAll(/'\/([a-z][a-z0-9_-]*)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20);
    const missing = [...new Set(names)].filter((n) => !RESERVED_COMMANDS.has(n));
    expect(missing, 'add these built-ins to RESERVED_COMMANDS in src/plugins/types.ts').toEqual([]);
  });

  it('a manifest claiming a built-in command is rejected at install', () => {
    const r = manifestSchema.safeParse({
      manifestVersion: 1, id: 'evil-help', name: 'x', version: '1.0.0', description: 'x', kind: 'in-process',
      engines: { mercury: '>=1.0.0' }, entry: 'i.mjs', contributes: { tools: [], commands: [{ name: 'help', description: 'mine now' }] },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/\/help is a built-in Mercury command/);
  });
});

describe('guided setup from chat', () => {
  it('install starts setup; numbered replies answer it; /plugins <id> opens the menu', async () => {
    const { tempHome, inProcessPlugin } = await import('./test-fixtures.js');
    const { handlePluginsCommand, answerPluginDialog, hasPluginDialog } = await import('./commands.js');
    const { resetPluginManager } = await import('./manager.js');
    const { readSettings } = await import('./store.js');
    const env = tempHome();
    resetPluginManager();
    try {
      const dir = inProcessPlugin(env.home, {
        id: 'greeter',
        manifest: { settings: { version: 1, fields: {
          greeting: { type: 'string', label: 'How should I greet people?', setup: true, required: true },
          tone: { type: 'enum', options: ['warm', 'formal'], default: 'warm', label: 'Tone', setup: true, optionLabels: { warm: 'Warm and friendly', formal: 'Formal' } },
        } } },
      });
      const sent: string[] = [];
      const channel = { type: 'cli', send: async (t: string) => { sent.push(t); } };
      const msg = { id: '1', channelId: 'cli:test', channelType: 'cli' as const, senderId: 'owner', content: '', timestamp: Date.now() };

      await handlePluginsCommand(`/plugins install ${dir} --yes`, msg, channel);
      expect(sent.at(-1)).toMatch(/Installed[\s\S]*greeter setup \(1\/2\)[\s\S]*How should I greet people\?/);
      expect(hasPluginDialog('cli:test')).toBe(true);
      await answerPluginDialog('Salaam', msg, channel);
      expect(sent.at(-1)).toMatch(/✅ How should I greet people\?: Salaam[\s\S]*Tone[\s\S]*1\* · Warm and friendly[\s\S]*2\* · Formal/);
      await answerPluginDialog('2', msg, channel);
      await answerPluginDialog('1', msg, channel); // "Done"
      expect(hasPluginDialog('cli:test')).toBe(false);
      expect(readSettings('greeter')).toMatchObject({ greeting: 'Salaam', tone: 'formal' });

      await handlePluginsCommand('/plugins greeter', msg, channel);
      // Every setting is on the menu itself, with its value: one tap to change.
      expect(sent.at(-1)).toMatch(/\*1\* · How should I greet people\?: Salaam[\s\S]*\*2\* · Tone: Formal/);
      await answerPluginDialog('cancel', msg, channel);
      expect(hasPluginDialog('cli:test')).toBe(false);
    } finally {
      resetPluginManager();
      env.restore();
    }
  });
});
