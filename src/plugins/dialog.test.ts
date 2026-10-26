import { describe, expect, it } from 'vitest';
import { PluginDialog, renderPrompt } from './dialog.js';
import type { PluginService } from './service.js';
import type { PluginListItem } from './types.js';

function fakeService(overrides: Partial<PluginListItem> = {}) {
  const values: Record<string, unknown> = { owner: '', access: 'general', answerCalls: true, members: '' };
  const calls: string[] = [];
  let linked = false;
  const item = (): PluginListItem => ({
    id: 'whatsapp', name: 'WhatsApp', description: 'Chat with Mercury.', kind: 'out-of-process', tier: 'official',
    status: 'enabled', installedVersion: '0.1.0', enabled: true, running: true, verified: true, tools: [], commands: [],
    channel: { type: 'whatsapp', state: linked ? 'connected' : 'needs-pairing', account: linked ? '639759021037' : undefined },
    settings: [
      { key: 'owner', type: 'string', description: '', value: values.owner, label: 'Which number will you chat from?', setup: true, required: true, format: 'phone' },
      { key: 'access', type: 'enum', description: '', options: ['general', 'extended'], value: values.access, label: 'What can Mercury do in your chat?', setup: true, optionLabels: { general: 'General: chat only', extended: 'Extended: memory, files, tools' } },
      { key: 'answerCalls', type: 'boolean', description: '', value: values.answerCalls, label: 'Answer your voice calls', setup: true },
      { key: 'members', type: 'string', description: '', value: values.members, label: 'Other numbers allowed to chat' },
    ],
    ...overrides,
  });
  const svc = {
    mode: 'local',
    info: async () => item(),
    setSetting: async (_id: string, key: string, value: unknown) => {
      if (key === 'owner' && String(value).replace(/\D/g, '').length < 7) throw new Error('Expected a phone number with country code, like +15551234567.');
      values[key] = key === 'owner' ? `+${String(value).replace(/\D/g, '')}` : value;
      calls.push(`set ${key}=${String(values[key])}`);
    },
    channelStatus: async () => ({ state: linked ? 'connected' : 'needs-pairing', at: Date.now() }),
    pair: async (_id: string, opts: { method: string; phone?: string }) => { calls.push(`pair ${opts.method} ${opts.phone}`); return { state: 'pairing', pairCode: 'ABCD1234', at: Date.now() }; },
    testChannel: async () => { calls.push('test'); return 'Sent a test message.'; },
    unlink: async () => { calls.push('unlink'); linked = false; },
    disable: async () => { calls.push('disable'); },
    enable: async () => { calls.push('enable'); },
    uninstall: async (_id: string, purge?: boolean) => { calls.push(`uninstall ${purge ? 'purge' : 'keep'}`); },
    update: async () => [],
  } as unknown as PluginService;
  return { svc, calls, values, link: () => { linked = true; } };
}

async function say(d: PluginDialog, ...answers: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const a of answers) {
    const r = await d.answer(a);
    if (r.message) out.push(r.message);
    const p = await d.current();
    if (p) out.push(renderPrompt(p, false));
  }
  return out;
}

describe('setup dialog', () => {
  it('asks each setup setting in order, validates, then offers linking', async () => {
    const { svc, calls, values } = fakeService();
    const d = (await PluginDialog.setup(svc, 'whatsapp'))!;
    const first = renderPrompt((await d.current())!, false);
    expect(first).toMatch(/WhatsApp setup \(1\/4\)[\s\S]*Which number will you chat from\?[\s\S]*country code/);

    const out = await say(d, 'abc', '+91 700 680 4336', '2', '1', '1', '+63 975 902 1037', 'ok');
    expect(out[0]).toMatch(/phone number/); // "abc" rejected, same question again
    expect(values.owner).toBe('+917006804336');
    expect(out.join('\n')).toMatch(/Extended: memory, files, tools/);
    expect(values.access).toBe('extended');
    expect(values.answerCalls).toBe(true);
    expect(calls).toContain('pair code 639759021037');
    expect(out.join('\n')).toMatch(/Pairing code: \*ABCD1234\*/);
    expect(out.join('\n')).toMatch(/is set up[\s\S]*\/plugins whatsapp/);
    expect(await d.current()).toBeNull();
  });

  it('options can be picked by number, button command or their words; cancel stops', async () => {
    const { svc, values } = fakeService();
    const d = (await PluginDialog.setup(svc, 'whatsapp'))!;
    await say(d, '+917006804336', '/plugins pick 2');
    expect(values.access).toBe('extended');
    await say(d, 'no');
    expect(values.answerCalls).toBe(false);
    const r = await d.answer('cancel');
    expect(r).toEqual({ message: 'Closed.', finished: true });
  });

  it('a plugin with nothing to set up has no setup dialog', async () => {
    const { svc } = fakeService({ settings: [], channel: undefined });
    expect(await PluginDialog.setup(svc, 'whatsapp')).toBeNull();
  });
});

describe('/plugins <id> menu', () => {
  it('shows status, every setting with its value, and its actions work', async () => {
    const { svc, calls, values, link } = fakeService();
    link();
    const d = (await PluginDialog.menu(svc, 'whatsapp', true))!;
    const menu = renderPrompt((await d.current())!, false);
    expect(menu).toMatch(/WhatsApp[\s\S]*Account: linked as \+639759021037/);
    expect(menu).toMatch(/What can Mercury do in your chat\?: General[\s\S]*Answer your voice calls: On[\s\S]*Send me a test message[\s\S]*Unlink the account[\s\S]*Turn off[\s\S]*Uninstall[\s\S]*Close/);
    expect(menu).not.toMatch(/Change a setting/);

    await say(d, 'Send me a test message');
    expect(calls).toContain('test');
    // One tap opens the setting; the current choice is marked; a way back is always there.
    const opened = await say(d, '2');
    expect(opened.at(-1)).toMatch(/General: chat only ✓ now[\s\S]*Extended: memory, files, tools[\s\S]*← Back \(no change\)/);
    const saved = await say(d, '2');
    expect(values.access).toBe('extended');
    expect(saved[0]).toBe('✅ What can Mercury do in your chat?: Extended: memory, files, tools');
    await say(d, 'unlink', 'yes');
    expect(calls).toContain('unlink');
    const r = await d.answer('close');
    expect(r.finished).toBe(true);
  });

  it('yes/no settings say what each choice does, and Back leaves them unchanged', async () => {
    const { svc, values } = fakeService();
    const base = (await svc.info('whatsapp'))!.settings!;
    const settings = base.map((s) => s.key === 'answerCalls' ? { ...s, optionLabels: { true: 'On: Mercury picks up when you call', false: 'Off: calls ring out' } } : s);
    const d = (await PluginDialog.menu({ ...svc, info: async () => ({ ...(await svc.info('whatsapp'))!, settings: settings.map((s) => ({ ...s, value: values[s.key] })) }) } as typeof svc, 'whatsapp', true))!;
    expect(renderPrompt((await d.current())!, false)).toMatch(/Answer your voice calls: On/);
    const opened = await say(d, '3');
    expect(opened.at(-1)).toMatch(/On: Mercury picks up when you call ✓ now[\s\S]*Off: calls ring out[\s\S]*← Back/);
    await say(d, '3'); // Back
    expect(values.answerCalls).toBe(true);
    const saved = await say(d, '3', '2');
    expect(values.answerCalls).toBe(false);
    expect(saved).toContain('✅ Answer your voice calls: Off: calls ring out');
  });

  it('a typed setting offers suggestions, and typing your own still works', async () => {
    const values: Record<string, unknown> = { hotkey: 'ctrl+alt+m' };
    const svc = {
      info: async () => ({
        id: 'optimus', name: 'Optimus', description: 'x', kind: 'out-of-process', tier: 'official', status: 'enabled', installedVersion: '0.4.4', enabled: true, running: true, verified: true, tools: [], commands: [],
        settings: [{ key: 'hotkey', type: 'string', description: '', value: values.hotkey, label: 'Key to start and stop talking', setup: true, examples: ['ctrl+alt+m', 'ctrl+shift+space', 'f9'] }],
      }),
      setSetting: async (_id: string, k: string, v: unknown) => { values[k] = v; },
    } as unknown as PluginService;
    const d = (await PluginDialog.menu(svc, 'optimus', true))!;
    expect(renderPrompt((await d.current())!, false)).toMatch(/Key to start and stop talking: ctrl\+alt\+m/);
    const opened = await say(d, '1');
    expect(opened.at(-1)).toMatch(/Pick one, or reply with your own[\s\S]*ctrl\+alt\+m ✓ now[\s\S]*ctrl\+shift\+space[\s\S]*f9/);
    await say(d, '3');
    expect(values.hotkey).toBe('f9');
    await say(d, '1', 'ctrl+alt+k');
    expect(values.hotkey).toBe('ctrl+alt+k');
  });

  it('a section lists its settings; choosing an engine asks for what it needs next', async () => {
    const values: Record<string, unknown> = { voiceEngine: 'openai', voiceModel: 'gpt-realtime', geminiModel: 'gemini-3.8-live' };
    let geminiKey = false;
    const settings = () => [
      { key: 'voiceEngine', type: 'enum', description: '', options: ['openai', 'gemini'], value: values.voiceEngine, label: 'Who listens and speaks?', setup: true, group: 'voice', optionLabels: { openai: '⭐ OpenAI Realtime: recommended', gemini: 'Google Gemini Live: free tier' } },
      { key: 'voiceModel', type: 'string', description: '', value: values.voiceModel, label: 'OpenAI voice model', group: 'voice', when: { voiceEngine: ['openai'] } },
      { key: 'geminiKey', type: 'secret', description: '', value: undefined, isSet: geminiKey, label: 'Gemini API key', setup: true, required: true, group: 'voice', when: { voiceEngine: ['gemini'] } },
      { key: 'geminiModel', type: 'string', description: '', value: values.geminiModel, label: 'Gemini Live model', group: 'voice', when: { voiceEngine: ['gemini'] } },
    ];
    const svc = {
      info: async () => ({
        id: 'optimus', name: 'Optimus', description: 'x', kind: 'out-of-process', tier: 'official', status: 'enabled', installedVersion: '0.4.4', enabled: true, running: true, verified: true, tools: [], commands: [],
        settingGroups: [{ id: 'voice', label: '🎙 Voice', ready: values.voiceEngine === 'openai' || geminiKey }],
        settings: settings(),
      }),
      setSetting: async (_id: string, k: string, v: unknown) => { if (k === 'geminiKey') geminiKey = true; else values[k] = v; },
    } as unknown as PluginService;
    const d = (await PluginDialog.menu(svc, 'optimus', true))!;
    expect(renderPrompt((await d.current())!, false)).toMatch(/🎙 Voice: OpenAI Realtime ✓/);
    const section = await say(d, '1');
    expect(section.at(-1)).toMatch(/Who listens and speaks\?: OpenAI Realtime[\s\S]*OpenAI voice model: gpt-realtime[\s\S]*Set up step by step[\s\S]*← Back/);
    expect(section.at(-1)).not.toMatch(/Gemini API key/); // doesn't apply to OpenAI
    const picked = await say(d, '1', '2'); // engine → Gemini
    expect(values.voiceEngine).toBe('gemini');
    // The key is required for Gemini, so it's asked right away; the model has a working default.
    expect(picked.join('\n')).toMatch(/✅ Who listens and speaks\?: Google Gemini Live: free tier\nNext, one more thing it needs:[\s\S]*Gemini API key/);
    const after = await say(d, 'AIzaSyTESTKEY123456');
    expect(geminiKey).toBe(true);
    expect(after.at(-1)).toMatch(/🎙 Voice[\s\S]*Who listens and speaks\?: Google Gemini Live[\s\S]*Gemini API key: set ✓/);
  });

  it('a desktop plugin (Optimus) has nothing to link: no link step in setup or the menu', async () => {
    const { svc } = fakeService({ id: 'optimus', name: 'Optimus', channel: { type: 'desktop', state: 'connected', detail: 'Press Control+Option+M to talk.' } });
    const setup = (await PluginDialog.setup(svc, 'optimus'))!;
    const all = (await say(setup, '+15550001111', '1', '1')).join('\n');
    expect(all).not.toMatch(/Link the|Pairing code|spare number/);
    expect(all).toMatch(/is set up/);
    const menu = renderPrompt((await (await PluginDialog.menu(svc, 'optimus', true))!.current())!, false);
    expect(menu).toMatch(/Press Control\+Option\+M to talk\./);
    expect(menu).not.toMatch(/Account:|Link the account|test message|Unlink/);
  });

  it('members see status only, with no actions', async () => {
    const { svc } = fakeService();
    const d = (await PluginDialog.menu(svc, 'whatsapp', false))!;
    expect((await d.current())!.options).toBeUndefined();
  });
});
