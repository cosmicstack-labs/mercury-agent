import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import { rmSync } from 'node:fs';
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-browser-tools-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});
const { PermissionManager } = await import('../permissions.js');
const { makeContext, deriveChildContext } = await import('../permission-context.js');
const { createBrowserTools } = await import('./tools.js');
const { CapabilityRegistry } = await import('../registry.js');
const { IsolatedBrowserReader } = await import('./reader.js');
const { setPluginImagesAllowed } = await import('../../plugins/tool-bridge.js');
const { resolveChildTools } = await import('../../utils/tool-filter.js');
const { filterBotTools } = await import('../../bots/registry-factory.js');
const { WebChannel } = await import('../../channels/web.js');
afterAll(() => rmSync(home, { recursive: true, force: true }));

function setup(seesImages = true) {
  const permissions = new PermissionManager();
  permissions.setCurrentContext('web', 'chat-a', 'canonical-a');
  const ask = vi.fn().mockResolvedValue('yes');
  permissions.onAsk(ask);
  const reader = new IsolatedBrowserReader();
  const run = vi.spyOn(reader, 'run').mockResolvedValue({ text: 'bounded untrusted page', image: 'private-image-a' });
  setPluginImagesAllowed(seesImages);
  return { permissions, ask, reader, run, tools: createBrowserTools(permissions, reader) };
}
async function execute(tool: Tool, args = {}, toolCallId = 'same-call') {
  return tool.execute!(args, { toolCallId, messages: [] });
}
async function output(tool: Tool, value: unknown, toolCallId = 'same-call') {
  return tool.toModelOutput!({ toolCallId, input: {}, output: value });
}

describe('browser tool approval, identity and image ownership', () => {
  it('is absent by default and hidden from members, plan mode and all child allowlists when enabled', () => {
    const registry = new CapabilityRegistry();
    registry.registerAll();
    expect(registry.getTools().browser_navigate).toBeUndefined();
    registry.permissions.getManifest().capabilities.browser = { enabled: true };
    registry.registerAll();
    expect(registry.getTools().browser_navigate).toBeDefined();
    expect(registry.getPlanTools().browser_navigate).toBeUndefined();
    expect(resolveChildTools(registry.getTools(), ['browser_navigate'])).toEqual({});
    const botTools = filterBotTools(registry.getTools(), { id: 'bot', tools: { allow: ['browser_navigate'] } } as Parameters<typeof filterBotTools>[1]);
    expect(botTools.browser_navigate).toBeUndefined();
    registry.permissions.setCurrentSenderRole('member');
    expect(registry.getTools().browser_snapshot).toBeUndefined();
  });

  it('does not launch after denial or invalid/private URL and captures the canonical session', async () => {
    const { tools, ask, run } = setup();
    ask.mockResolvedValueOnce('no');
    expect(await execute(tools.browser_navigate!, { url: 'https://public.example/' })).toBe('Browser navigation denied.');
    await execute(tools.browser_navigate!, { url: 'http://127.0.0.1/' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    await execute(tools.browser_navigate!, { url: 'https://public.example/' });
    expect(run).toHaveBeenCalledWith('canonical-a', 'navigate', 'https://public.example/', undefined);
  });

  it('requires a real web approval despite Allow All, and cannot launch after denial or cancellation', async () => {
    const h = setup();
    const web = new WebChannel('Mercury');
    web.setBypassPermissions(true);
    web.addSSEClient({ enqueue() {}, close() {} } as unknown as ReadableStreamDefaultController, 'chat-a');
    h.permissions.onAsk((prompt, options) => web.askPermission(prompt, 'chat-a', options));
    try {
      const denied = execute(h.tools.browser_navigate!, { url: 'https://public.example/' });
      let pending = web.pendingFor('chat-a');
      expect(pending).toHaveLength(1);
      expect(h.run).not.toHaveBeenCalled();
      expect(web.resolveApproval(pending[0]!.data!.id as string, 'no', 'chat-a')).toBe(true);
      expect(await denied).toContain('denied');

      const controller = new AbortController();
      const cancelled = h.tools.browser_navigate!.execute!({ url: 'https://public.example/' }, { toolCallId: 'cancelled', messages: [], abortSignal: controller.signal });
      pending = web.pendingFor('chat-a');
      expect(pending).toHaveLength(1);
      controller.abort();
      // Even a late affirmative answer cannot start a cancelled request.
      expect(web.resolveApproval(pending[0]!.data!.id as string, 'yes', 'chat-a')).toBe(true);
      expect(await cancelled).toContain('could not complete');
      expect(h.run).not.toHaveBeenCalled();
      expect(web.pendingFor('chat-a')).toHaveLength(0);
    } finally { await web.stop(); }
  });

  it('refuses missing, changed, child, internal and member identities even with a retained tool reference', async () => {
    for (const patch of [{ sessionId: undefined }, { sessionId: 'canonical-b' }, { channelType: 'internal', autoApprove: true }, { senderRole: 'member' as const }]) {
      const { tools, permissions, run, ask } = setup();
      await permissions.withContext(makeContext({ ...permissions.currentContext(), ...patch }), async () => {
        expect(await execute(tools.browser_snapshot!)).toContain('interactive owner session');
      });
      expect(run).not.toHaveBeenCalled();
      expect(ask).not.toHaveBeenCalled();
    }
    const { permissions } = setup();
    expect(deriveChildContext(permissions.currentContext()).sessionId).toBeUndefined();
  });

  it('keeps images out of text/history and consumes each image only once', async () => {
    const { tools } = setup();
    const value = await execute(tools.browser_navigate!, { url: 'https://public.example/' });
    expect(value).not.toContain('private-image-a');
    const first = await output(tools.browser_navigate!, value);
    expect(JSON.stringify(first)).toContain('private-image-a');
    expect(JSON.stringify(await output(tools.browser_navigate!, value))).not.toContain('private-image-a');
  });

  it('isolates repeated call IDs across fresh wrappers and captures text-only capability before another provider changes it', async () => {
    const a = setup(true);
    const b = setup(false);
    const first = await execute(a.tools.browser_snapshot!);
    const second = await execute(b.tools.browser_snapshot!);
    setPluginImagesAllowed(true);
    expect(JSON.stringify(await output(b.tools.browser_snapshot!, second))).not.toContain('image-data');
    expect(JSON.stringify(await output(a.tools.browser_snapshot!, first))).toContain('private-image-a');
  });

  it('keeps two vision sessions with the same tool call ID from exchanging screenshots', async () => {
    const a = setup(true);
    const b = setup(true);
    b.permissions.setCurrentContext('web', 'chat-b', 'canonical-b');
    b.run.mockResolvedValue({ text: 'page b', image: 'private-image-b' });
    b.tools = createBrowserTools(b.permissions, b.reader);
    const [first, second] = await Promise.all([execute(a.tools.browser_snapshot!), execute(b.tools.browser_snapshot!)]);
    expect(JSON.stringify(await output(a.tools.browser_snapshot!, first))).toContain('private-image-a');
    expect(JSON.stringify(await output(b.tools.browser_snapshot!, second))).toContain('private-image-b');
  });
});
