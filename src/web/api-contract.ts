/**
 * The API contract between a Mercury runtime and every client that is not
 * shipped inside the same binary: Mercury Desktop, the phone apps, scripts.
 *
 * Two numbers exist and they move independently:
 *
 *  - the PACKAGE version (`package.json`, `/api/health.version`) — what to
 *    print in an About box and what `mercury upgrade` compares;
 *  - the API VERSION (`API_VERSION`, `/api/health.apiVersion`) — a single
 *    integer bumped ONLY on a change a client cannot tolerate: a removed or
 *    renamed route, a changed response shape, a changed auth scheme.
 *
 * Additive changes never bump the integer. They add a FEATURE flag instead,
 * and clients gate UI on the flag. A client declares the range of API
 * versions it understands; outside that range it tells the user to update
 * one side or the other. `docs/api-contract.md` records which runtime
 * release introduced each version.
 */

export const API_VERSION = 1;

/**
 * Capabilities a client may rely on. Order is irrelevant; names are stable
 * once published (remove = bump API_VERSION).
 */
export const API_FEATURES: readonly string[] = Object.freeze([
  'auth.devices',      // device tokens: POST /api/auth/token, GET/DELETE /api/auth/devices
  'chat.sse',          // GET /api/chat/events (Server-Sent Events)
  'chat.attachments',  // multipart uploads on POST /api/chat/send
  'bots',              // /api/bots/*
  'plugins',           // /api/plugins/*
  'mcp',               // /api/mcp/*
  'boards',            // /api/boards/*
  'brain',             // /api/brain/*
  'code.session',      // POST /api/chat/send { programming, cwd } — per-session coding
  'chat.uploads',      // attachments on messages + GET /api/chat/uploads/:month/:file
  'voice',             // /api/voice, /api/voice/events, /api/voice/control (Optimus)
  'usage.history',     // GET /api/usage/history?days= — tokens per local day
  'brain.people',      // PATCH/merge persons, person checks, GET /api/brain/graph/v2
  'chat.stop',         // POST /api/chat/stop — interrupt the running turn (same as /stop)
  'providers.manage',  // GET /api/providers/settings, POST /api/providers/:id/check (live, unsaved), PUT /api/providers/roles; saves apply live; health.setupRequired
  'voice.check',
  'artifacts',         // GET /api/artifacts (paged), /:id, /:id/file (Range), POST /:id/export, DELETE /:id; SSE 'artifacts'; message.artifacts
  'chat.activity',     // GET /api/chat/activity (SSE: started, needs_you, resolved, done, stopped, failed per session), GET /api/chat/pending?sessionId
  'chat.plan',         // SSE 'plan' { steps, updatedAt } + GET /api/chat/plan?sessionId= (the plan checklist)
  'channels',          // GET /api/channels, POST :type/check, PUT :type, POST :type/access, POST/GET signal/link
  'transcribe',        // GET/POST /api/transcribe — dictation: raw audio in, text out
  'speak',             // GET/POST /api/speak — read aloud: text in, MP3 out
  'budget',            // GET/PUT /api/budget — daily cap, Token Saver, bot caps; saves apply live
  'threads.save',      // POST /api/chat/threads/:id/save { saved } — thread.savedAt
  'cloud.signin',      // GET /api/cloud/status, POST/GET/DELETE /api/cloud/signin (browser pairing from any client)       // POST /api/voice/check { vendor, key?, endpoint? }
  'brain.map',         // GET /api/brain/map[?archive=1] — themes, sub-themes, notes, related links
]);

export interface ApiContractInfo {
  apiVersion: number;
  features: readonly string[];
}

export function apiContract(): ApiContractInfo {
  return { apiVersion: API_VERSION, features: API_FEATURES };
}
