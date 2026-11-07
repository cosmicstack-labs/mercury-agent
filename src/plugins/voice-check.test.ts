import { describe, expect, it, vi } from 'vitest';
import { checkVoiceKey } from './voice-check.js';

const reply = (status: number, body: unknown) => vi.fn().mockResolvedValue({ status, json: async () => body } as Response);

describe('voice key check', () => {
  it('ElevenLabs: a good key lists voices', async () => {
    const f = reply(200, { voices: [{ voice_id: 'v1', name: 'Rachel' }, { voice_id: 'v2', name: 'Adam' }] });
    const r = await checkVoiceKey('elevenlabs', 'sk_abc123', { fetch: f });
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(r.voices).toEqual([{ id: 'v1', name: 'Rachel' }, { id: 'v2', name: 'Adam' }]);
    expect(f.mock.calls[0][1].headers['xi-api-key']).toBe('sk_abc123');
  });

  it('a rejected key says so, by vendor name', async () => {
    const r = await checkVoiceKey('deepgram', 'bad-key-123', { fetch: reply(401, {}) });
    expect(r).toMatchObject({ ok: false, verified: true });
    expect(r.message).toMatch(/Deepgram rejected/);
  });

  it('Gemini lists only live voice models', async () => {
    const f = reply(200, { models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-live-2.5-flash-preview' }, { name: 'models/gemini-2.5-flash-native-audio-dialog' }] });
    const r = await checkVoiceKey('gemini', 'AIzaKey123', { fetch: f });
    expect(r.models).toEqual(['gemini-live-2.5-flash-preview', 'gemini-2.5-flash-native-audio-dialog']);
  });

  it('Qwen tries the mainland host when the international one rejects the key', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: [] }) });
    const r = await checkVoiceKey('qwen', 'sk-dash123', { fetch: f as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    expect(f.mock.calls[1][0]).toContain('dashscope.aliyuncs.com');
  });

  it('Azure needs its endpoint before it can check', async () => {
    const f = reply(200, {});
    expect((await checkVoiceKey('azure', 'abc123', { fetch: f })).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('vendors with no check endpoint are honest about it', async () => {
    const r = await checkVoiceKey('sarvam', 'key-123');
    expect(r).toMatchObject({ ok: true, verified: false });
    expect(r.message).toMatch(/first time/);
  });

  it('empty, masked or spaced keys never reach the network', async () => {
    const f = reply(200, {});
    for (const k of ['', 'ab cd', 'sk-a••••b3c4']) expect((await checkVoiceKey('cartesia', k, { fetch: f })).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('a timeout reads as a timeout', async () => {
    const f = vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout'));
    const r = await checkVoiceKey('assemblyai', 'k123', { fetch: f as unknown as typeof fetch });
    expect(r.message).toMatch(/10 seconds/);
  });
});
