/**
 * browser_task — high-level natural-language browsing via the Browser-Use Cloud Agent API.
 *
 * One-shot: submit a task in English ("Find the top 3 trending repos on GitHub today"),
 * wait for the agent to complete it on a remote stealth browser, return the textual output.
 *
 * Differs from the fine-grained browser_open/click/type/extract tools — those are for when
 * Mercury wants to drive the browser step-by-step. browser_task delegates to browser-use's
 * own agent for tasks where their model + tooling will likely outperform our step-by-step loop.
 *
 * Only available when BROWSER_USE_API_KEY is configured. Cloud-only by design — no local
 * equivalent because there is no analogous "agent" running locally.
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getBrowserSessionManager } from './session.js';
import { extractHost, looksLikeSensitiveHost } from './backends/base.js';
import type { BrowserToolContext } from './tool-context.js';
import { addAllowedDomain, isDomainAllowed } from './router.js';
import { approveDomainPrompt } from './tool-context.js';

export function createBrowserTaskTool(ctx: BrowserToolContext) {
  return tool({
    description:
      'Delegate a natural-language browsing task to the Browser-Use Cloud Agent. ' +
      'Use this for high-level tasks where step-by-step browser control is overkill: research, scraping, multi-site comparisons, form completions. ' +
      'Provide a clear task description and (optionally) one or more starting URLs. ' +
      'The agent runs on browser-use\'s stealth Cloud Chromium with residential proxies. ' +
      'Requires BROWSER_USE_API_KEY. Costs are billed per-task by browser-use.',
    inputSchema: zodSchema(
      z.object({
        task: z.string().min(10).describe(
          'Natural-language task. Be specific about what data to extract and in what format. ' +
          'Example: "List the top 20 posts on Hacker News today with their points and URLs as markdown."',
        ),
        starting_urls: z.array(z.string()).optional().describe(
          'Optional list of URLs the agent should consider as starting points. Each will be permission-checked.',
        ),
        max_wait_seconds: z.number().int().min(30).max(900).optional().describe(
          'How long to wait for the agent to finish (default: 240). Cloud sessions max out at 4 hours.',
        ),
      }),
    ),
    execute: async ({ task, starting_urls, max_wait_seconds }) => {
      const mgr = getBrowserSessionManager();
      const cloud = mgr.getCloudBackend();
      if (!cloud) {
        return 'browser_task requires Browser-Use Cloud (BROWSER_USE_API_KEY). Use `mercury browser auth` or set the env var.';
      }
      const avail = await cloud.isAvailable();
      if (!avail.ok) return `browser_task unavailable: ${avail.reason}`;

      // Permission-check any starting URLs the LLM passed.
      if (starting_urls && starting_urls.length > 0) {
        for (const url of starting_urls) {
          const host = extractHost(url);
          if (!host) return `Invalid starting URL: ${url}`;
          if (looksLikeSensitiveHost(host)) {
            return `Starting URL ${url} is treated as a sensitive domain and cannot be delegated to Cloud. Drive it locally with browser_open instead.`;
          }
          if (!isDomainAllowed(ctx.permissions, host)) {
            const approved = await approveDomainPrompt(ctx, host, false);
            if (!approved) return `User denied delegation to domain ${host}.`;
            addAllowedDomain(ctx.permissions, host);
          }
        }
      }

      // Augment the task with explicit starting URLs so the remote agent honors them.
      const fullTask = starting_urls && starting_urls.length > 0
        ? `${task}\n\nStarting URL(s): ${starting_urls.join(', ')}`
        : task;

      try {
        const output = await cloud.runAgentTask(fullTask, { maxWaitMs: (max_wait_seconds ?? 240) * 1000 });
        return { backend: 'cloud' as const, output };
      } catch (err: any) {
        return `browser_task failed: ${err?.message ?? String(err)}`;
      }
    },
  });
}
