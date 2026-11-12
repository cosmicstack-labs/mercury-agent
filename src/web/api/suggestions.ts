import { Hono } from 'hono';
import type { SuggestionEngine } from '../../learning/suggestions.js';
import type { SessionRepository } from '../../sessions/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Suggestions for a new chat (learning/suggestions.ts).
 *
 *   GET  /api/suggestions?n=4          a few, the least recently shown first; a stale pool is remade in the background
 *   POST /api/suggestions/:id/used     the owner picked one: it leaves the pool
 */

let engine: SuggestionEngine | null = null;
let sessions: SessionRepository | null = null;
export function setSuggestionEngine(e: SuggestionEngine | null, repo?: SessionRepository | null): void {
  engine = e;
  sessions = repo ?? null;
}

const suggestions = new Hono();

suggestions.get('/api/suggestions', (c) => {
  if (!engine) return c.json({ error: 'Suggestions are not available.' }, 503);
  const n = Math.min(Math.max(Number(c.req.query('n') ?? 4) || 4, 1), 8);
  const pick = engine.pick(n);
  // Never on the request path: a stale pool is remade after answering, for the next new chat.
  let last = 0;
  try { last = sessions?.listSummaries().reduce((m, s) => Math.max(m, s.updatedAt), 0) ?? 0; } catch { /* none */ }
  if (engine.shouldRefresh(Date.now(), last)) void engine.refresh().catch((err) => logger.debug({ err }, 'Suggestions refresh failed'));
  return c.json(pick);
});

suggestions.post('/api/suggestions/:id/used', (c) => {
  if (!engine) return c.json({ error: 'Suggestions are not available.' }, 503);
  return c.json({ ok: engine.used(c.req.param('id')) });
});

export default suggestions;
