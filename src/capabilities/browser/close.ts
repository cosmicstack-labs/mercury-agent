/**
 * browser_close — close a browser session.
 *
 * For Cloud sessions this also PATCHes the remote /browsers/{id} → stopped so
 * unused time is refunded immediately. Always call this when done — sessions
 * left running cost money until their timeout expires.
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getBrowserSessionManager } from './session.js';

export function createBrowserCloseTool() {
  return tool({
    description:
      'Close a browser session and release resources. ' +
      'For Cloud sessions this stops billing immediately (unused time is refunded). ' +
      'Always call this when you are done with a session.',
    inputSchema: zodSchema(
      z.object({
        session_id: z.string().describe('Session id returned by browser_open'),
      }),
    ),
    execute: async ({ session_id }) => {
      try {
        const mgr = getBrowserSessionManager();
        const backend = mgr.getBackendForSession(session_id);
        await backend.close(session_id);
        mgr.forgetSession(session_id);
        return { sessionId: session_id, closed: true };
      } catch (err: any) {
        return `Error closing session ${session_id}: ${err?.message ?? String(err)}`;
      }
    },
  });
}
