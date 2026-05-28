/**
 * browser_extract — pull readable text out of the current page.
 *
 * If `selector` is provided, scoped to elements matching that CSS selector
 * (concatenated). Otherwise extracts whole-page innerText with scripts/styles/nav
 * stripped. Output is capped at ~12 KB.
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getBrowserSessionManager } from './session.js';

export function createBrowserExtractTool() {
  return tool({
    description:
      'Extract readable text from the current page in a browser session. ' +
      'Without a selector: returns the whole-page innerText with scripts/styles/nav/footer removed. ' +
      'With a CSS selector (e.g. "article", ".result-title"): concatenates matching elements\' text. ' +
      'Output is capped at ~12 KB.',
    inputSchema: zodSchema(
      z.object({
        session_id: z.string().describe('Session id returned by browser_open'),
        selector: z.string().optional().describe('Optional CSS selector to scope extraction'),
      }),
    ),
    execute: async ({ session_id, selector }) => {
      try {
        const backend = getBrowserSessionManager().getBackendForSession(session_id);
        const text = await backend.extract(session_id, selector);
        return text;
      } catch (err: any) {
        return `Error extracting from session ${session_id}: ${err?.message ?? String(err)}`;
      }
    },
  });
}
