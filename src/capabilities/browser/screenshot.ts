/**
 * browser_screenshot — capture the current page as PNG.
 *
 * Saved into <cwd>/.mercury-screenshots/<timestamp>.png so vision-capable models
 * can be fed the file path, and so the user can review what Mercury saw. If a
 * sendFile handler is plugged in by the active channel, the PNG is also sent
 * back to the user inline (Telegram / Web UI).
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBrowserSessionManager } from './session.js';
import type { BrowserToolContext } from './tool-context.js';

export function createBrowserScreenshotTool(ctx: BrowserToolContext) {
  return tool({
    description:
      'Capture the current page in a browser session as a PNG. ' +
      'Saved into <cwd>/.mercury-screenshots/ and (if the channel supports it) sent back to the user inline. ' +
      'Useful for vision-capable models to "see" the page, or for human review.',
    inputSchema: zodSchema(
      z.object({
        session_id: z.string().describe('Session id returned by browser_open'),
        send_to_user: z.boolean().optional().describe('Send the screenshot back to the user inline (default: false)'),
      }),
    ),
    execute: async ({ session_id, send_to_user }) => {
      try {
        const backend = getBrowserSessionManager().getBackendForSession(session_id);
        const { data } = await backend.screenshot(session_id);

        const dir = join(ctx.getCwd(), '.mercury-screenshots');
        mkdirSync(dir, { recursive: true });
        const filename = `screenshot-${session_id}-${Date.now()}.png`;
        const path = join(dir, filename);
        writeFileSync(path, data);

        if (send_to_user && ctx.sendFile) {
          try {
            await ctx.sendFile(path);
          } catch (err: any) {
            return { sessionId: session_id, backend: backend.name, path, bytes: data.byteLength, send_error: err?.message };
          }
        }

        return {
          sessionId: session_id,
          backend: backend.name,
          path,
          bytes: data.byteLength,
          sentToUser: !!(send_to_user && ctx.sendFile),
        };
      } catch (err: any) {
        return `Error taking screenshot in session ${session_id}: ${err?.message ?? String(err)}`;
      }
    },
  });
}
