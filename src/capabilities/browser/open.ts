/**
 * browser_open — open a URL in a new (or existing) browser session.
 *
 * Routes between Cloud and Local backends via the smart router. The chosen
 * backend, sessionId, and routing reason are returned to the LLM so it knows
 * which session to address with subsequent browser_* calls.
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { chooseBackend } from './router.js';
import { getBrowserSessionManager } from './session.js';
import type { BrowserToolContext } from './tool-context.js';
import { approveDomainPrompt } from './tool-context.js';

export function createBrowserOpenTool(ctx: BrowserToolContext) {
  return tool({
    description:
      'Open a URL in a Mercury-managed browser. Returns a sessionId you must pass to subsequent browser_* calls. ' +
      'Routes automatically between the Browser-Use Cloud (stealth, proxies) and a local Chromium (offline, sensitive domains). ' +
      'Sensitive domains (banks, email providers, gov) always use Local. ' +
      'Use this for JavaScript-rendered pages, logged-in flows, or form-filling. For plain HTML pages, prefer fetch_url (cheaper, offline).',
    inputSchema: zodSchema(
      z.object({
        url: z.string().describe('Fully-qualified URL to navigate to (must include https://)'),
        backend: z.enum(['cloud', 'local', 'auto']).optional().describe(
          'Override the routing decision. "auto" (default) lets Mercury decide.',
        ),
        existing_session_id: z.string().optional().describe(
          'Reuse an existing session (from a prior browser_open) to navigate it to a new URL.',
        ),
      }),
    ),
    execute: async ({ url, backend, existing_session_id }) => {
      const explicit = backend === 'auto' ? undefined : (backend as 'cloud' | 'local' | undefined);

      // If reusing an existing session, dispatch directly without re-running the router.
      if (existing_session_id) {
        const mgr = getBrowserSessionManager();
        try {
          const b = mgr.getBackendForSession(existing_session_id);
          const handle = await b.open(url, { existingSessionId: existing_session_id });
          mgr.registerSession(handle, url);
          return {
            sessionId: handle.sessionId,
            backend: handle.backend,
            url,
            reused: true,
          };
        } catch (err: any) {
          return `Error reusing session ${existing_session_id}: ${err?.message ?? String(err)}`;
        }
      }

      const route = await chooseBackend({
        url,
        explicit,
        permissions: ctx.permissions,
        approveDomain: (host, sensitive) => approveDomainPrompt(ctx, host, sensitive),
      });

      if ('error' in route) return `browser_open denied: ${route.error}`;

      try {
        const handle = await route.backend.open(url);
        getBrowserSessionManager().registerSession(handle, url);
        return {
          sessionId: handle.sessionId,
          backend: handle.backend,
          routing: route.decision.reason,
          url,
        };
      } catch (err: any) {
        return `Error opening ${url} via ${route.decision.backend}: ${err?.message ?? String(err)}`;
      }
    },
  });
}
