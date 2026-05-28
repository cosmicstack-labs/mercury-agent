/**
 * approve_url_scope — explicit user-facing tool to allow a domain for browser_* tools.
 *
 * Counterpart of the `approve_scope` filesystem tool. Adds the host to
 * permissions.yaml → capabilities.browser.allowedDomains so subsequent
 * browser_open calls to it (and subdomains) won't re-prompt.
 *
 * Sensitive domains can still be allowed via this tool, but they will continue
 * to route to the Local backend only — that override cannot be lifted from user
 * config because it's the security floor.
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { PermissionManager } from '../permissions.js';
import { addAllowedDomain } from './router.js';
import { extractHost, looksLikeSensitiveHost } from './backends/base.js';

export function createApproveUrlScopeTool(permissions: PermissionManager) {
  return tool({
    description:
      'Approve a domain so Mercury can browse it without prompting again. ' +
      'Accepts either a bare hostname (example.com) or a full URL (https://example.com/path). ' +
      'Subdomains of an approved domain are also covered. ' +
      'Sensitive domains (banks, email, gov, crypto) remain Local-only even after approval.',
    inputSchema: zodSchema(
      z.object({
        domain: z.string().describe('Hostname or URL to approve, e.g. "example.com" or "https://example.com"'),
      }),
    ),
    execute: async ({ domain }) => {
      let host = domain.trim().toLowerCase();
      if (host.startsWith('http://') || host.startsWith('https://')) {
        const parsed = extractHost(host);
        if (!parsed) return `Invalid domain: ${domain}`;
        host = parsed;
      }
      if (!host || host.includes('/') || host.includes(' ')) return `Invalid domain: ${domain}`;
      addAllowedDomain(permissions, host);
      return {
        domain: host,
        approved: true,
        sensitive: looksLikeSensitiveHost(host),
        note: looksLikeSensitiveHost(host) ? 'Approved, but will continue to route to the Local backend only.' : undefined,
      };
    },
  });
}
