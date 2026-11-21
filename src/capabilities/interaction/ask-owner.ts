import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import type { PermissionManager } from '../permissions.js';
import { OWNER_TASK_MAX_MEDIA_BYTES, ownerTasks, type OwnerTaskResult } from '../../security/owner-tasks.js';

/**
 * ask_owner (ADR-048): hand the owner something only they can do and wait
 * for their answer — a CAPTCHA to read, a one-time code, a step to finish on a
 * website. They get it on their phone, their chat apps, Mercury Desktop and the
 * terminal, and answer from whichever is nearest.
 */

const MEDIA_TYPES: Record<string, { kind: 'image' | 'audio'; mimeType: string }> = {
  '.png': { kind: 'image', mimeType: 'image/png' }, '.jpg': { kind: 'image', mimeType: 'image/jpeg' }, '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.gif': { kind: 'image', mimeType: 'image/gif' }, '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' }, '.wav': { kind: 'audio', mimeType: 'audio/wav' }, '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
  '.webm': { kind: 'audio', mimeType: 'audio/webm' }, '.m4a': { kind: 'audio', mimeType: 'audio/mp4' },
};

export function describeOwnerTaskResult(r: OwnerTaskResult, minutes: number): string {
  switch (r.status) {
    case 'answered': return `The owner answered: ${r.answer}`;
    case 'declined': return 'The owner declined this. Do not ask again for the same thing; carry on without it or report that it is blocked.';
    case 'cancelled': return 'The request was cancelled.';
    default: return `No answer from the owner within ${minutes} minute${minutes === 1 ? '' : 's'}. Do not guess; report that this step is waiting on them.`;
  }
}

export function createAskOwnerTool(deps: { permissions: PermissionManager; cwd: () => string }) {
  return tool({
    description: 'Hand the owner something only a human can do, and wait for their answer: read a CAPTCHA (attach the image or audio), give a one-time or 2FA code they received, or finish a step on a website themselves (answer "done"). '
      + 'They get it on their phone, chat apps and Mercury Desktop. Use it only when you are stuck on it, for the owner\'s own task. Never ask for passwords or bank PINs. Waits up to timeout_minutes.',
    inputSchema: zodSchema(z.object({
      title: z.string().min(3).max(120).describe('One line: "Solve this CAPTCHA", "Enter the code your bank texted you".'),
      request: z.string().min(3).max(1000).describe('Exactly what to do and what to send back. Say which site it is for.'),
      file: z.string().optional().describe('Path to an image (png, jpg, gif, webp) or audio clip (mp3, wav, ogg, webm, m4a) to show them, e.g. the CAPTCHA.'),
      link: z.string().optional().describe('The page this is for (https://…), when they need to open it themselves.'),
      answer: z.enum(['text', 'done']).optional().describe('"text" (default): they type an answer. "done": they finish it themselves and confirm.'),
      timeout_minutes: z.number().int().min(1).max(30).optional().describe('How long to wait (default 5).'),
    })),
    execute: async ({ title, request, file, link, answer, timeout_minutes }, options?: { abortSignal?: AbortSignal }) => {
      const minutes = timeout_minutes ?? 5;
      let media: { kind: 'image' | 'audio'; mimeType: string; data: Buffer } | undefined;
      if (file) {
        const path = isAbsolute(file) ? file : resolve(deps.cwd(), file);
        const type = MEDIA_TYPES[extname(path).toLowerCase()];
        if (!type) return 'Not sent: attach an image (png, jpg, gif, webp) or audio (mp3, wav, ogg, webm, m4a).';
        const access = await deps.permissions.checkFsAccess(path, 'read');
        if (!access.allowed) return `Not sent: ${access.reason ?? `no read access to ${file}`}`;
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return `Not sent: ${file} doesn't exist.`;
        if (info.size > OWNER_TASK_MAX_MEDIA_BYTES) return `Not sent: ${file} is larger than ${OWNER_TASK_MAX_MEDIA_BYTES / 1048576} MB.`;
        media = { ...type, data: await readFile(path) };
      }
      let task;
      try {
        task = ownerTasks().request({ title, prompt: request, who: 'Mercury', ...(link ? { link } : {}), ...(media ? { media } : {}), answerKind: answer ?? 'text' }, minutes * 60_000);
      } catch (err) {
        return `Not sent: ${(err as Error).message}`;
      }
      const result = await ownerTasks().wait(task.id, options?.abortSignal);
      return describeOwnerTaskResult(result, minutes);
    },
  });
}
