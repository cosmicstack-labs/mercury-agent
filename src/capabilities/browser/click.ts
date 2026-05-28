/**
 * browser_click — click an interactive element by its index from the last browser_state.
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getBrowserSessionManager } from './session.js';

export function createBrowserClickTool() {
  return tool({
    description:
      'Click an interactive element by its index (from the most recent browser_state). ' +
      'After clicking, call browser_state again to see the new page state — indices change between calls.',
    inputSchema: zodSchema(
      z.object({
        session_id: z.string().describe('Session id returned by browser_open'),
        index: z.number().int().min(0).describe('Element index from browser_state.elements[].index'),
      }),
    ),
    execute: async ({ session_id, index }) => {
      try {
        const backend = getBrowserSessionManager().getBackendForSession(session_id);
        await backend.click(session_id, index);
        return { sessionId: session_id, backend: backend.name, clicked: index, ok: true };
      } catch (err: any) {
        return `Error clicking index ${index} in session ${session_id}: ${err?.message ?? String(err)}`;
      }
    },
  });
}
