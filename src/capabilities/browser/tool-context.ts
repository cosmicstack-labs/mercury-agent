/**
 * Shared helpers for browser_* tools.
 *
 * The `askUser` handler is plugged into the tools by registry.ts and routes to
 * the existing arrow-menu (CLI) / inline-keyboard (Telegram) prompt UX so the
 * permission flow feels native to whichever channel the user is on.
 */

import type { PermissionManager } from '../permissions.js';

export interface BrowserToolContext {
  permissions: PermissionManager;
  /** Cross-channel "ask the user" handler. Resolves to 'yes' | 'always' | 'no'. */
  ask?: (prompt: string) => Promise<string>;
  /** Optional handler for sending file attachments back to the user (screenshots). */
  sendFile?: (path: string) => Promise<void>;
  /** Working directory — screenshots are written here under .mercury-screenshots/. */
  getCwd: () => string;
}

export async function approveDomainPrompt(ctx: BrowserToolContext, host: string, sensitive: boolean): Promise<boolean> {
  if (!ctx.ask) return false;
  const note = sensitive
    ? '\n\nThis is treated as a sensitive domain — Mercury will use the local browser only.'
    : '';
  const answer = await ctx.ask(
    `Allow Mercury to browse \`${host}\`?${note}`,
  );
  return answer === 'yes' || answer === 'always';
}
