import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { readFileSync, closeSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { PermissionManager } from '../permissions.js';
import { openVerified, readDenialMessage } from './verified-read.js';

/** Cap on tool-result size — the full file text is echoed into the LLM
 * conversation and retained for every subsequent agent step (the AI SDK
 * keeps per-step conversation clones). 64KB covers most source files while
 * keeping a 75-step task's retained heap in the low tens of MB. */
const MAX_RESULT_CHARS = 64 * 1024;

export function createReadFileTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Read the contents of a file. The path must be within an allowed scope. Files larger than 64KB are returned truncated — read specific ranges with run_command if you need more.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Absolute or relative path to the file'),
    })),
    execute: async ({ path }) => {
      const resolved = isAbsolute(path) ? resolve(path) : resolve(getCwd(), path);
      const check = await permissions.checkFsAccess(resolved, 'read');
      if (!check.allowed) {
        return readDenialMessage(resolved, check);
      }

      // Read the canonical target the check authorised (never the lexical
      // path), and prove the opened descriptor is that same file.
      const opened = openVerified(check.canonical ?? resolved, check.fileId);
      if (opened.error !== undefined) return opened.error;
      const { fd, stat } = opened;

      try {
        if (stat.isDirectory()) {
          return `Error: ${resolved} is a directory, not a file. Use list_dir instead.`;
        }
        if (stat.size > 1024 * 1024) {
          return `Error: File too large (${Math.round(stat.size / 1024)}KB). Maximum is 1MB. Use run_command with sed/head/tail to read portions.`;
        }
        const content = readFileSync(fd, 'utf-8');
        if (content.length > MAX_RESULT_CHARS) {
          return content.slice(0, MAX_RESULT_CHARS)
            + `\n\n[File truncated: showing first ${Math.round(MAX_RESULT_CHARS / 1024)}KB of ${Math.round(content.length / 1024)}KB. Use run_command with sed/head/tail to read specific sections.]`;
        }
        return content;
      } catch (err: any) {
        return `Error reading file: ${err.message}`;
      } finally {
        closeSync(fd);
      }
    },
  });
}
