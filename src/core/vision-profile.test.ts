import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { estimateImageTokens, visionFamily, visionProfile } from './vision-profile.js';
import { KEEP_IMAGES, TOOL_IMAGE_LEAD, shapeStepMessages } from './payload-policy.js';
import { modelSeesImages } from './attachments.js';
import { screenshotContract } from '../plugins/tool-bridge.js';

/**
 * Screenshots per model (ADR-043): the size each family is billed least
 * for, how the image reaches the model, and none for a model that can't see.
 */
describe('vision profile', () => {
  it.each([
    ['claude-opus-5-5', 'claude', 1024, 640],
    ['gpt-5.2', 'openai', 1024, 640],
    ['gemini-3.1-pro', 'gemini', 768, 480],
    ['nemotron-3.5-super-vl:free', 'patch', 896, 560],
    ['qwen2.5-vl-72b', 'patch', 896, 560],
    ['some-new-model', 'default', 1024, 640],
  ])('%s → %s, %ix%i', (model, family, w, h) => {
    const p = visionProfile({ model, seesImages: true, toolResultImages: true }, {});
    expect(p.family).toBe(family);
    expect(p.box).toEqual({ width: w, height: h });
  });

  it('routes: in the tool result, as an image message, or none', () => {
    expect(visionProfile({ model: 'claude-opus-5-5', seesImages: true, toolResultImages: true }, {}).route).toBe('tool-result');
    expect(visionProfile({ model: 'nemotron-vl', seesImages: true, toolResultImages: false }, {}).route).toBe('user-message');
    expect(visionProfile({ model: 'deepseek-chat', seesImages: false, toolResultImages: false }, {}).route).toBe('none');
  });

  it('the owner can set one size for every model', () => {
    expect(visionProfile({ model: 'gemini-3', seesImages: true, toolResultImages: true }, { MERCURY_SCREENSHOT_BOX: '1280x800' }).box).toEqual({ width: 1280, height: 800 });
    expect(visionProfile({ model: 'gemini-3', seesImages: true, toolResultImages: true }, { MERCURY_SCREENSHOT_BOX: 'huge' }).box).toEqual({ width: 768, height: 480 });
  });

  it('right-sized screenshots cost fewer tokens than the old fixed 1280×800', () => {
    for (const family of ['claude', 'openai', 'gemini'] as const) {
      const p = visionProfile({ model: family === 'openai' ? 'gpt-5' : family === 'claude' ? 'claude-x' : 'gemini-x', seesImages: true, toolResultImages: true }, {});
      expect(estimateImageTokens(family, p.box.width, p.box.height)).toBeLessThan(estimateImageTokens(family, 1280, 800));
    }
    expect(estimateImageTokens('gemini', 768, 480)).toBe(258);
    expect(estimateImageTokens('openai', 1024, 640)).toBe(765);
    expect(visionFamily('o4-mini')).toBe('openai');
  });

  it('"-vl" models are recognised as seeing images', () => {
    expect(modelSeesImages('mercuryCloud', 'nemotron-3.5-super-vl:free')).toBe(true);
    expect(modelSeesImages('ollamaLocal', 'internvl3:8b')).toBe(true);
    expect(modelSeesImages('openaiCompat', 'devstral-small')).toBe(false);
  });
});

describe('a plugin that takes screenshots', () => {
  it('declares it with a mercury_screenshot parameter, which the model never sees', () => {
    const { inputSchema, screenshots } = screenshotContract({ type: 'object', properties: { zoom: { type: 'array' }, mercury_screenshot: { type: 'object' } }, required: ['mercury_screenshot'] });
    expect(screenshots).toBe(true);
    expect(inputSchema).toEqual({ type: 'object', properties: { zoom: { type: 'array' } }, required: [] });
    expect(screenshotContract({ type: 'object', properties: { x: {} } }).screenshots).toBe(false);
    expect(screenshotContract({ type: 'object', properties: {} }, true).screenshots).toBe(true);
  });
});

describe('screenshots as image messages (APIs that take images only from the user)', () => {
  const img = { data: 'AAAA', mimeType: 'image/jpeg' };
  const held = new Map([['c1', [img]], ['c2', [img]], ['c3', [img]]]);
  const step = (id: string) => [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'optimus__act', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'optimus__act', output: { type: 'text', value: 'Sent.\n(The screenshot follows as an image.)' } }] },
  ];
  const conversation = [{ role: 'user', content: 'do it' }, ...step('c1'), ...step('c2'), ...step('c3')];

  it('follows each tool run, newest two as images, older ones as a note', () => {
    const out = shapeStepMessages(conversation as never[], { toolImages: { route: 'user-message', imagesFor: (id) => held.get(id) } }) as Array<{ role: string; content: unknown }>;
    const added = out.filter((m) => m.role === 'user' && Array.isArray(m.content));
    expect(added).toHaveLength(3);
    const images = added.map((m) => (m.content as Array<{ type: string }>).filter((p) => p.type === 'image').length);
    expect(images).toEqual([0, 1, 1]);
    expect(KEEP_IMAGES).toBe(2);
    expect(JSON.stringify(added[2].content)).toContain(TOOL_IMAGE_LEAD);
    // Each comes right after its tool message.
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user']);
  });

  it('leaves other routes and screenshot-free turns alone', () => {
    expect(shapeStepMessages(conversation as never[], { toolImages: { route: 'tool-result', imagesFor: (id) => held.get(id) } })).toBe(conversation);
    expect(shapeStepMessages(conversation as never[], { toolImages: { route: 'user-message', imagesFor: () => undefined } })).toBe(conversation);
  });

  it('on the wire (OpenAI-compatible chat): an image_url part in a user message after the tool message', async () => {
    let body: { messages: Array<{ role: string; content: unknown }> } = { messages: [] };
    const fake = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const shaped = shapeStepMessages(step('c3') as never[], { toolImages: { route: 'user-message', imagesFor: (id) => held.get(id) } });
    await generateText({ model: createOpenAI({ apiKey: 'k', baseURL: 'http://x/v1', fetch: fake }).chat('nemotron-vl'), messages: [{ role: 'user', content: 'go' }, ...shaped] as never });
    const roles = body.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user']);
    const last = body.messages[3].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(last.find((p) => p.type === 'image_url')?.image_url?.url).toBe('data:image/jpeg;base64,AAAA');
  });
});

describe('the bridge fills in the size for the model in use', () => {
  it('passes mercury_screenshot to a screenshot tool, and tells the model how the image comes', async () => {
    const bridge = await import('../plugins/tool-bridge.js');
    const images = await import('../capabilities/tool-images.js');
    bridge.resetToolBridge();
    const calls: Array<Record<string, unknown>> = [];
    bridge.publishTool({
      pluginId: 'optimus', pluginName: 'Optimus', name: 'look', description: 'See the screen',
      ...bridge.screenshotContract({ type: 'object', properties: { mercury_screenshot: { type: 'object' } } }),
      readOnly: true, timeoutMs: 5000,
      invoke: async (args) => { calls.push(args); return bridge.toolContent('Display 1 of 1.', [{ data: 'AAAA', mimeType: 'image/jpeg' }]); },
    });
    const tools = bridge.getPluginTools({ approvePluginTool: async () => true } as never);
    const look = tools['optimus__look'] as unknown as { execute: (i: unknown, o: unknown) => Promise<string>; toModelOutput: (x: unknown) => unknown };

    images.setToolVision({ route: 'user-message', box: { width: 896, height: 560 } });
    await look.execute({}, { toolCallId: 't1' });
    expect(calls[0].mercury_screenshot).toEqual({ include: true, max_width: 896, max_height: 560 });
    expect(look.toModelOutput({ toolCallId: 't1', output: 'Display 1 of 1.\n[1 image attached]' })).toEqual({ type: 'text', value: 'Display 1 of 1.\n[1 image attached]\n(The screenshot follows as an image.)' });
    expect(images.heldImages('t1')).toHaveLength(1);

    images.setToolVision({ route: 'none', box: { width: 1024, height: 640 } });
    await look.execute({}, { toolCallId: 't2' });
    expect(calls[1].mercury_screenshot).toEqual({ include: false, max_width: 1024, max_height: 640 });

    images.setToolVision({ route: 'tool-result', box: { width: 1024, height: 640 } });
    bridge.resetToolBridge();
  });
});
