/**
 * browser_state — snapshot the current page: URL, title, top-N interactive elements.
 *
 * The returned `elements` array gives each clickable / typeable element a stable
 * `index` that the LLM passes to browser_click / browser_type. Returned uncapped
 * count helps the LLM decide whether to scroll/extract for more.
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getBrowserSessionManager } from './session.js';

const DEFAULT_MAX_ELEMENTS = 60;

export function createBrowserStateTool() {
  return tool({
    description:
      'Snapshot the current page in a browser session: URL, title, and a numbered list of interactive elements (links, buttons, inputs). ' +
      'Use the returned element indices with browser_click and browser_type. ' +
      'Call this after browser_open and after any browser_click that may have changed the page.',
    inputSchema: zodSchema(
      z.object({
        session_id: z.string().describe('Session id returned by browser_open'),
        max_elements: z.number().int().min(1).max(200).optional().describe(
          `Cap on returned element count (default ${DEFAULT_MAX_ELEMENTS}). Use higher only when truly needed — large pages cost more tokens.`,
        ),
      }),
    ),
    execute: async ({ session_id, max_elements }) => {
      try {
        const backend = getBrowserSessionManager().getBackendForSession(session_id);
        const state = await backend.state(session_id, { maxElements: max_elements ?? DEFAULT_MAX_ELEMENTS });
        return {
          sessionId: session_id,
          backend: backend.name,
          url: state.url,
          title: state.title,
          totalElements: state.totalElements,
          shownElements: state.elements.length,
          elements: state.elements,
        };
      } catch (err: any) {
        return `Error reading state for session ${session_id}: ${err?.message ?? String(err)}`;
      }
    },
  });
}
