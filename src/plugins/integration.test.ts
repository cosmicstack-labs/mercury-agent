import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionManager } from '../capabilities/permissions.js';
import { filterBotTools } from '../bots/registry-factory.js';
import type { BotManifest } from '../bots/types.js';
import { isPluginToolName, pluginToolAllowed } from './tool-bridge.js';
import { tempHome } from './test-fixtures.js';

let env: ReturnType<typeof tempHome>;
beforeEach(() => { env = tempHome(); });
afterEach(() => env.restore());

const tools = { read_file: {}, run_command: {}, 'weather__forecast': {}, 'weather__alerts': {}, 'notes__write': {} };
const manifest = { id: 'b', name: 'B' } as unknown as BotManifest;

describe('bots never see plugin tools unless explicitly allowed', () => {
  it('deny-only gate (the default) hides every plugin tool', () => {
    const out = filterBotTools(tools, manifest, { tools: { deny: ['run_command'] } } as never);
    expect(Object.keys(out)).toEqual(['read_file']);
  });
  it('an exact allow entry exposes that tool only', () => {
    const out = filterBotTools(tools, manifest, { tools: { allow: ['read_file', 'weather__forecast'] } } as never);
    expect(Object.keys(out)).toEqual(['read_file', 'weather__forecast']);
  });
  it('"<plugin>__*" exposes one plugin\'s tools, not others', () => {
    const out = filterBotTools(tools, manifest, { tools: { allow: ['weather__*'] } } as never);
    expect(Object.keys(out)).toEqual(['weather__forecast', 'weather__alerts']);
  });
  it('deny still wins over allow', () => {
    const out = filterBotTools(tools, manifest, { tools: { allow: ['weather__*'], deny: ['weather__alerts'] } } as never);
    expect(Object.keys(out)).toEqual(['weather__forecast']);
  });
  it('name helpers', () => {
    expect(isPluginToolName('weather__forecast')).toBe(true);
    expect(isPluginToolName('read_file')).toBe(false);
    expect(isPluginToolName('Weather__x')).toBe(false);
    expect(pluginToolAllowed('notes__write', ['weather__*'])).toBe(false);
  });
});

describe('approvePluginTool', () => {
  it('fail-closed (bots): runs without asking (the bot gate already allowed it)', async () => {
    const pm = new PermissionManager();
    pm.setFailClosed(true);
    pm.onAsk(async () => { throw new Error('bots must never be asked'); });
    expect(await pm.approvePluginTool('weather__forecast', 'x')).toBe(true);
  });
  it('internal turns approve only under allow-all', async () => {
    const pm = new PermissionManager();
    pm.setCurrentContext('internal', 'sched-1');
    expect(await pm.approvePluginTool('notes__write', 'x')).toBe(false);
    pm.setAutoApproveAll(true);
    expect(await pm.approvePluginTool('notes__write', 'x')).toBe(true);
  });
  it('session Allow All approves locally but never for web requests', async () => {
    const pm = new PermissionManager();
    pm.setCurrentContext('cli', 'local');
    pm.setAutoApproveAll(true);
    expect(await pm.approvePluginTool('notes__write', 'x')).toBe(true);
    pm.setCurrentContext('web', 'session-9');
    pm.setAutoApproveAll(true);
    pm.onAsk(async () => 'no');
    expect(await pm.approvePluginTool('notes__write', 'x')).toBe(false);
  });
  it('"always" is remembered per channel, not across channels', async () => {
    const pm = new PermissionManager();
    pm.setCurrentContext('telegram', 'chat-1');
    pm.onAsk(async () => 'always');
    expect(await pm.approvePluginTool('notes__write', 'x')).toBe(true);
    pm.onAsk(async () => 'no');
    expect(await pm.approvePluginTool('notes__write', 'x')).toBe(true);
    pm.setCurrentContext('telegram', 'chat-2');
    expect(await pm.approvePluginTool('notes__write', 'x')).toBe(false);
  });
  it('no one to ask means no', async () => {
    const pm = new PermissionManager();
    pm.setCurrentContext('cli', 'local');
    expect(await pm.approvePluginTool('notes__write', 'x')).toBe(false);
  });
});

describe('general access disables every tool for the turn', () => {
  it('getTools and getPlanTools return nothing while disabled', async () => {
    const { CapabilityRegistry } = await import('../capabilities/registry.js');
    const reg = new CapabilityRegistry();
    reg.registerAll();
    expect(Object.keys(reg.getTools()).length).toBeGreaterThan(0);
    reg.setToolsDisabled(true);
    expect(reg.getTools()).toEqual({});
    expect(reg.getPlanTools()).toEqual({});
    reg.setToolsDisabled(false);
    expect(Object.keys(reg.getTools()).length).toBeGreaterThan(0);
  });
});

describe('web_search is a built-in tool', () => {
  it('is registered alongside fetch_url', async () => {
    const { CapabilityRegistry } = await import('../capabilities/registry.js');
    const reg = new CapabilityRegistry();
    reg.registerAll();
    expect(Object.keys(reg.getTools())).toEqual(expect.arrayContaining(['web_search', 'fetch_url']));
  });
});
