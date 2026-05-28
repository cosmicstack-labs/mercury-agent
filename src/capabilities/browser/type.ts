/**
 * browser_type — type text into an input/textarea by its index from browser_state.
 *
 * Clears existing value first. Set submit=true to press Enter after typing
 * (useful for search boxes that submit on Enter rather than requiring a button click).
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getBrowserSessionManager } from './session.js';

export function createBrowserTypeTool() {
  return tool({
    description:
      'Type text into an input or textarea by its index from the most recent browser_state. ' +
      'Existing value is cleared first. Set submit=true to press Enter after typing (e.g. for search boxes).',
    inputSchema: zodSchema(
      z.object({
        session_id: z.string().describe('Session id returned by browser_open'),
        index: z.number().int().min(0).describe('Element index from browser_state.elements[].index'),
        text: z.string().describe('Text to type into the field'),
        submit: z.boolean().optional().describe('Press Enter after typing (default: false)'),
      }),
    ),
    execute: async ({ session_id, index, text, submit }) => {
      try {
        const backend = getBrowserSessionManager().getBackendForSession(session_id);
        await backend.type(session_id, index, text, { submit: submit ?? false });
        return { sessionId: session_id, backend: backend.name, typed_at: index, submitted: !!submit, ok: true };
      } catch (err: any) {
        return `Error typing into index ${index} in session ${session_id}: ${err?.message ?? String(err)}`;
      }
    },
  });
}
