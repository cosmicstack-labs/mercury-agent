import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionManager } from '../capabilities/permissions.js';
import { getPluginTools, publishTool, resetToolBridge, setPluginImagesAllowed, toolContent } from './tool-bridge.js';

const PNG = 'iVBORw0KGgo=';

function liveTool(result: unknown) {
  return {
    pluginId: 'shots',
    pluginName: 'Shots',
    name: 'look',
    description: 'Take a screenshot',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    timeoutMs: 5000,
    invoke: async () => result,
  };
}

async function run(result: unknown, callId = 'call-1') {
  publishTool(liveTool(result));
  // The bridge returns an AI SDK tool; the test drives its two callbacks directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = getPluginTools({} as PermissionManager)['shots__look'] as any;
  const output = await t.execute({}, { toolCallId: callId, messages: [] });
  const model = await t.toModelOutput({ toolCallId: callId, input: {}, output });
  return { output, model };
}

describe('plugin tool images (plugin API 1.2)', () => {
  afterEach(() => {
    resetToolBridge();
    setPluginImagesAllowed(true);
  });

  it('keeps images out of the text result and gives them to the model', async () => {
    const { output, model } = await run(toolContent('Screen 1 of 1', [{ data: PNG, mimeType: 'image/png' }]));
    expect(output).toBe('Screen 1 of 1\n[1 image attached]');
    expect(output).not.toContain(PNG);
    expect(model).toEqual({
      type: 'content',
      value: [{ type: 'text', text: output }, { type: 'image-data', data: PNG, mediaType: 'image/png' }],
    });
  });

  it('plain text results stay text', async () => {
    const { output, model } = await run('done');
    expect(output).toBe('done');
    expect(model).toEqual({ type: 'text', value: 'done' });
  });

  it('drops unsupported image types and caps the count', async () => {
    const many = Array.from({ length: 6 }, () => ({ data: PNG, mimeType: 'image/png' }));
    const { model } = await run(toolContent('x', [{ data: PNG, mimeType: 'image/tiff' }, ...many]));
    expect(model.value.filter((p: { type: string }) => p.type === 'image-data')).toHaveLength(4);
  });

  it('tells a text-only model the image was left out', async () => {
    setPluginImagesAllowed(false);
    const { model } = await run(toolContent('Screen', [{ data: PNG, mimeType: 'image/png' }]));
    expect(model.type).toBe('text');
    expect(model.value).toContain("can't view images");
  });
});
