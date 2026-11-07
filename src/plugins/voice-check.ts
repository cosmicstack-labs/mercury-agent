/**
 * Check a voice vendor's key before the user relies on it: one cheap,
 * read-only call per vendor. Where the vendor lists voices, they come back
 * too, for the voice menu. Vendors with no read-only endpoint say so
 * plainly instead of pretending ("checked on first use").
 */

export const VOICE_VENDORS = ['elevenlabs', 'deepgram', 'assemblyai', 'cartesia', 'gemini', 'qwen', 'azure', 'sarvam', 'minimax'] as const;
export type VoiceVendor = (typeof VOICE_VENDORS)[number];

/** The env name each vendor's key is stored under (the Optimus plugin's `secret`). */
export const VOICE_KEY_ENV: Record<VoiceVendor, string> = {
  elevenlabs: 'ELEVENLABS_API_KEY', deepgram: 'DEEPGRAM_API_KEY', assemblyai: 'ASSEMBLYAI_API_KEY', cartesia: 'CARTESIA_API_KEY',
  gemini: 'GEMINI_API_KEY', qwen: 'DASHSCOPE_API_KEY', azure: 'AZURE_OPENAI_API_KEY', sarvam: 'SARVAM_API_KEY', minimax: 'MINIMAX_API_KEY',
};

export interface VoiceCheck {
  ok: boolean;
  /** false when the vendor offers no way to check a key without using it. */
  verified: boolean;
  message: string;
  voices?: Array<{ id: string; name: string }>;
  models?: string[];
}

type Fetch = typeof fetch;

const LABEL: Record<VoiceVendor, string> = {
  elevenlabs: 'ElevenLabs', deepgram: 'Deepgram', assemblyai: 'AssemblyAI', cartesia: 'Cartesia', gemini: 'Gemini', qwen: 'Qwen (DashScope)',
  azure: 'Azure OpenAI', sarvam: 'Sarvam', minimax: 'MiniMax',
};

async function call(f: Fetch, url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await f(url, { headers, signal: AbortSignal.timeout(10_000) });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

function verdict(vendor: VoiceVendor, status: number): VoiceCheck | null {
  if (status === 401 || status === 403) return { ok: false, verified: true, message: `${LABEL[vendor]} rejected this key. Copy it again from your ${LABEL[vendor]} account.` };
  if (status === 429) return { ok: true, verified: true, message: `${LABEL[vendor]} accepted the key but is rate-limiting it right now.` };
  if (status >= 400) return { ok: false, verified: true, message: `${LABEL[vendor]} answered ${status}. Try again in a moment.` };
  return null;
}

export async function checkVoiceKey(vendor: VoiceVendor, key: string, opts: { endpoint?: string; fetch?: Fetch } = {}): Promise<VoiceCheck> {
  const f = opts.fetch ?? fetch;
  const k = key.trim();
  if (!k) return { ok: false, verified: false, message: `Add your ${LABEL[vendor]} key first.` };
  if (/\s/.test(k) || k.includes('•')) return { ok: false, verified: false, message: 'Paste the full key, with no spaces.' };
  try {
    switch (vendor) {
      case 'elevenlabs': {
        const r = await call(f, 'https://api.elevenlabs.io/v1/voices', { 'xi-api-key': k });
        const bad = verdict(vendor, r.status); if (bad) return bad;
        const voices = ((r.body as { voices?: Array<{ voice_id: string; name: string }> })?.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name }));
        return { ok: true, verified: true, message: `Connected. ${voices.length} voices available.`, voices };
      }
      case 'cartesia': {
        const r = await call(f, 'https://api.cartesia.ai/voices', { 'X-API-Key': k, 'Cartesia-Version': '2024-06-10' });
        const bad = verdict(vendor, r.status); if (bad) return bad;
        const list = Array.isArray(r.body) ? r.body : ((r.body as { data?: unknown[] })?.data ?? []);
        const voices = (list as Array<{ id: string; name: string }>).map((v) => ({ id: v.id, name: v.name }));
        return { ok: true, verified: true, message: `Connected. ${voices.length} voices available.`, voices };
      }
      case 'deepgram': {
        const r = await call(f, 'https://api.deepgram.com/v1/projects', { Authorization: `Token ${k}` });
        return verdict(vendor, r.status) ?? { ok: true, verified: true, message: 'Connected.' };
      }
      case 'assemblyai': {
        const r = await call(f, 'https://api.assemblyai.com/v2/transcript?limit=1', { Authorization: k });
        return verdict(vendor, r.status) ?? { ok: true, verified: true, message: 'Connected.' };
      }
      case 'gemini': {
        const r = await call(f, `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}&pageSize=1000`, {});
        if (r.status === 400) return { ok: false, verified: true, message: 'Gemini rejected this key. Copy it again from Google AI Studio.' };
        const bad = verdict(vendor, r.status); if (bad) return bad;
        const models = ((r.body as { models?: Array<{ name: string }> })?.models ?? []).map((m) => m.name.replace(/^models\//, '')).filter((m) => /live|native-audio|realtime/i.test(m));
        return { ok: true, verified: true, message: models.length ? `Connected. ${models.length} live voice models.` : 'Connected.', models };
      }
      case 'qwen': {
        // International and mainland accounts live on different hosts; a key only works on its own.
        for (const host of ['https://dashscope-intl.aliyuncs.com', 'https://dashscope.aliyuncs.com']) {
          const r = await call(f, `${host}/compatible-mode/v1/models`, { Authorization: `Bearer ${k}` });
          if (r.status === 401 || r.status === 403) continue;
          return verdict(vendor, r.status) ?? { ok: true, verified: true, message: 'Connected.' };
        }
        return { ok: false, verified: true, message: 'DashScope rejected this key on both the international and mainland endpoints.' };
      }
      case 'azure': {
        const endpoint = (opts.endpoint ?? '').trim().replace(/\/+$/, '');
        if (!/^https:\/\//.test(endpoint)) return { ok: false, verified: false, message: 'Add your Azure endpoint (https://<name>.openai.azure.com) to check the key.' };
        const r = await call(f, `${endpoint}/openai/models?api-version=2024-10-21`, { 'api-key': k });
        if (r.status === 404) return { ok: false, verified: true, message: 'The endpoint answered, but it is not an Azure OpenAI resource. Check the URL.' };
        return verdict(vendor, r.status) ?? { ok: true, verified: true, message: 'Connected.' };
      }
      case 'sarvam':
      case 'minimax':
        return { ok: true, verified: false, message: `Saved. ${LABEL[vendor]} has no way to check a key without using it, so it is checked the first time you talk.` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, verified: false, message: /timeout|abort/i.test(msg) ? `${LABEL[vendor]} didn't answer in 10 seconds. Check your connection.` : `Couldn't reach ${LABEL[vendor]}: ${msg}` };
  }
  return { ok: false, verified: false, message: 'Unknown voice service.' };
}
