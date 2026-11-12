import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import type { PermissionManager } from '../permissions.js';
import { resolveToolPath, type CwdSource } from '../filesystem/resolve-path.js';
import { readDenialMessage } from '../filesystem/verified-read.js';
import type { MediaService } from '../../media/service.js';
import type { ChatTarget, MediaJobs } from '../../media/jobs.js';

export interface MediaJobDeps {
  media: MediaService;
  jobs: MediaJobs;
  permissions: PermissionManager;
  getCwd: CwdSource;
  outputDir(): string;
  /** The chat to post the result to when it's ready. */
  chat(): ChatTarget;
}

const started = (kind: string, id: string, chatApp: boolean) => [
  `Started making the ${kind} (job ${id}). It takes a minute or a few;`,
  chatApp ? 'it will be sent to this chat when it is ready.' : 'it will appear in this conversation when it is ready.',
  `Tell the user that in one sentence and end your turn — do not wait, poll, or call generate_${kind} again for the same request.`,
].join(' ');

/**
 * Video (ADR-042 phase 3): an image-to-video or text-to-video model makes
 * a short clip in the background; the result is posted to the chat.
 */
export function createGenerateVideoTool(deps: MediaJobDeps) {
  return tool({
    description: [
      'Make a short video clip (3–15 seconds, with sound on models that have it) with an AI video model (Veo, Omni, Sora…).',
      'Use when the user asks for a generated video clip or to animate an image. It runs in the background and is sent to the user when ready (minutes).',
      'Not for videos built from code or a skill — HyperFrames, Remotion, motion graphics, slides, edits of an existing file: when the user names one of those (or a skill), follow that skill and render with its tool (e.g. `npx hyperframes render`); never swap this in instead.',
    ].join(' '),
    inputSchema: zodSchema(z.object({
      prompt: z.string().min(1).max(4000).describe('The shot in detail: subject, action, camera movement, style, sound.'),
      aspect: z.enum(['landscape', 'portrait']).optional().describe('16:9 (default) or 9:16 for phones and stories.'),
      seconds: z.number().int().min(3).max(15).optional().describe('Length in seconds (default 8).'),
      reference_images: z.array(z.string()).max(6).optional().describe('Paths of images to animate or keep characters consistent with.'),
      model: z.string().optional().describe('Only when the user names a model or service: "provider::model" from /media, or the service by name ("veo", "sora", "gemini"). Named means that one only.'),
    })),
    execute: async ({ prompt, aspect, seconds, reference_images, model }) => {
      const references: string[] = [];
      for (const ref of reference_images ?? []) {
        const resolved = resolveToolPath(ref, deps.getCwd);
        const check = await deps.permissions.checkFsAccess(resolved, 'read');
        if (!check.allowed) return readDenialMessage(resolved, check);
        const target = check.canonical ?? resolved;
        if (!existsSync(target)) return `Error: reference image not found: ${ref}`;
        references.push(target);
      }
      // Fail now (not in the background) when nothing can make videos.
      if (!(await deps.media.chain('video', model)).length) {
        return `Error: ${model ? `"${model}" can't make videos here (not set up, or no such model). Tell the user; don't use another service instead unless they agree.` : 'no video model is set up. A Gemini key (Settings → Voice) gives Gemini Omni video; gateways such as LiteLLM or Mercury Cloud can serve others.'}`;
      }
      const outDir = deps.outputDir();
      const chat = deps.chat();
      const job = deps.jobs.start('video', prompt, chat, async (signal) => {
        const r = await deps.media.generateVideo({ prompt, aspect, seconds, references, model, signal }, outDir);
        return { file: r.file, madeWith: `${r.model.label} · ${r.model.group}`, ...(r.note ? { note: r.note } : {}) };
      }, { aspect: aspect ?? 'landscape' });
      return started('video', job.id, !['web', 'cli', 'internal'].includes(chat.channelType));
    },
  });
}

/** Music (phase 3): a song or instrumental clip, made in the background. */
export function createGenerateMusicTool(deps: MediaJobDeps) {
  return tool({
    description: [
      'Compose music: a song (with vocals and lyrics) or an instrumental piece, jingle or background track.',
      'Use when the user asks for music, a song, a beat, a jingle or a soundtrack. It runs in the background and is sent to the user when ready.',
    ].join(' '),
    inputSchema: zodSchema(z.object({
      prompt: z.string().min(1).max(4000).describe('Genre, mood, instruments, tempo, and lyrics or theme for vocals.'),
      seconds: z.number().int().min(5).max(300).optional().describe('Approximate length in seconds.'),
      instrumental: z.boolean().optional().describe('No vocals.'),
      model: z.string().optional().describe('Whenever the user names a service or model, in this message or earlier in the chat: "elevenlabs", "lyria", or "provider::model" from /media. Named means that one only.'),
    })),
    execute: async ({ prompt, seconds, instrumental, model }) => {
      if (!(await deps.media.chain('music', model)).length) {
        return `Error: ${model ? `"${model}" can't make music here (not set up, or no such service). Tell the user; don't use another service instead unless they agree.` : 'no music model is set up. A Gemini key (Lyria) or an ElevenLabs key (Settings → Voice) makes music.'}`;
      }
      const outDir = deps.outputDir();
      const chat = deps.chat();
      const job = deps.jobs.start('music', prompt, chat, async (signal) => {
        const r = await deps.media.generateMusic({ prompt, seconds, instrumental, model, signal }, outDir);
        return { file: r.file, madeWith: `${r.model.label} · ${r.model.group}`, ...(r.note ? { note: r.note } : {}) };
      });
      return started('music', job.id, !['web', 'cli', 'internal'].includes(chat.channelType));
    },
  });
}
