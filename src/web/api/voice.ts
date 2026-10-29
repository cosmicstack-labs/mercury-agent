import { Hono } from 'hono';
import { voiceFeed, VOICE_ACTIONS, type VoiceAction } from '../../plugins/voice-feed.js';
import { checkVoiceKey, VOICE_KEY_ENV, VOICE_VENDORS, type VoiceVendor } from '../../plugins/voice-check.js';
import { secretValue } from '../../plugins/store.js';

/**
 * Live voice (Optimus) for clients:
 *   GET  /api/voice          current session state and transcript
 *   GET  /api/voice/events   SSE: `state` and `turn` events (snapshot first)
 *   POST /api/voice/control  { action: start | mute | unmute | interrupt | stop }
 * Owner-authenticated like every /api route.
 */
const voice = new Hono();

voice.get('/api/voice', (c) => c.json(voiceFeed.snapshot()));

/**
 * POST /api/voice/check { vendor, key?, endpoint? }: is this voice key good?
 * With no key, checks the saved one. Read-only; nothing is stored.
 */
voice.post('/api/voice/check', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { vendor?: unknown; key?: unknown; endpoint?: unknown };
  if (typeof body.vendor !== 'string' || !(VOICE_VENDORS as readonly string[]).includes(body.vendor)) return c.json({ ok: false, verified: false, message: 'Unknown voice service.' }, 400);
  const vendor = body.vendor as VoiceVendor;
  const key = typeof body.key === 'string' && body.key.trim() ? body.key : secretValue(VOICE_KEY_ENV[vendor]) ?? '';
  return c.json(await checkVoiceKey(vendor, key, { endpoint: typeof body.endpoint === 'string' ? body.endpoint : undefined }));
});

voice.get('/api/voice/events', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* client gone */ }
      };
      send('state', voiceFeed.snapshot());
      const unsubscribe = voiceFeed.subscribe((ev) => {
        if (ev.type === 'turn' && ev.turn) send('turn', ev.turn);
        else if (ev.type === 'level' && ev.levels) send('level', ev.levels);
        // Turns travel on their own; state events stay small.
        else send('state', { ...ev.state, turns: undefined });
      });
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { clearInterval(keepalive); }
      }, 15000);
      c.req.raw.signal?.addEventListener('abort', () => { clearInterval(keepalive); unsubscribe(); });
    },
    cancel() {},
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
});

voice.post('/api/voice/control', async (c) => {
  const body = await c.req.json<{ action?: unknown }>().catch(() => ({} as { action?: unknown }));
  const action = body.action as VoiceAction;
  if (!VOICE_ACTIONS.includes(action)) return c.json({ error: `action must be one of ${VOICE_ACTIONS.join(', ')}` }, 400);
  if (!voiceFeed.control(action)) {
    const s = voiceFeed.snapshot();
    const why = !s.available ? 'Voice needs the Optimus plugin, installed and turned on.' : action === 'start' ? 'A voice session is already running.' : 'No voice session is running';
    return c.json({ error: why }, 409);
  }
  return c.json({ ok: true });
});

export default voice;
