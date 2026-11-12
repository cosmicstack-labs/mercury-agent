import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import type { PermissionManager } from '../permissions.js';
import { resolveToolPath, type CwdSource } from '../filesystem/resolve-path.js';
import { readDenialMessage } from '../filesystem/verified-read.js';
import type { MediaService } from '../../media/service.js';

export interface GenerateImageDeps {
  media: MediaService;
  permissions: PermissionManager;
  getCwd: CwdSource;
  /** Where this chat's images go. */
  outputDir(): string;
  /**
   * Send the images to the chat that asked (Telegram, WhatsApp…). Returns
   * how they were delivered, for the model's reply; apps show them as
   * artifacts and the terminal prints the path.
   */
  deliver(files: string[], caption: string): Promise<string>;
}

/**
 * Real image generation (ADR-042): an image model makes the picture. Without
 * this tool the only way a chat model could "make an image" was to write an
 * SVG with create_file.
 */
export function createGenerateImageTool(deps: GenerateImageDeps) {
  return tool({
    description: [
      'Generate or edit an image with an image model (a picture, photo, illustration, logo, artwork, poster, mockup).',
      'Use this whenever the user asks for an image; do not draw it as SVG or code unless they ask for SVG, a diagram or a vector file.',
      'To change an image you made or one the user gave you, pass its path in reference_images and say what to change.',
      'The image is saved and shown to the user; describe it briefly afterwards.',
    ].join(' '),
    inputSchema: zodSchema(z.object({
      prompt: z.string().min(1).max(4000).describe('What to draw, in detail: subject, style, composition, lighting, text to include.'),
      aspect: z.enum(['square', 'landscape', 'portrait']).optional().describe('Shape of the image (default square).'),
      quality: z.enum(['auto', 'low', 'medium', 'high']).optional().describe('Higher is slower and costs more (default auto).'),
      count: z.number().int().min(1).max(4).optional().describe('How many variations (default 1).'),
      reference_images: z.array(z.string()).max(5).optional().describe('Paths of images to edit or use as references.'),
      model: z.string().optional().describe('Only when the user names a model: "provider::model" from /media, or the model id.'),
    })),
    execute: async ({ prompt, aspect, quality, count, reference_images, model }, { abortSignal }) => {
      const references: string[] = [];
      for (const ref of reference_images ?? []) {
        const resolved = resolveToolPath(ref, deps.getCwd);
        const check = await deps.permissions.checkFsAccess(resolved, 'read');
        if (!check.allowed) return readDenialMessage(resolved, check);
        const target = check.canonical ?? resolved;
        if (!existsSync(target)) return `Error: reference image not found: ${ref}`;
        references.push(target);
      }
      try {
        const result = await deps.media.generateImage({ prompt, aspect, quality, count, references, model, signal: abortSignal }, deps.outputDir());
        const caption = prompt.length > 200 ? `${prompt.slice(0, 197)}…` : prompt;
        const delivered = await deps.deliver(result.files, caption).catch((err) => `not sent to the chat (${err instanceof Error ? err.message : String(err)})`);
        return [
          `Generated ${result.files.length} image${result.files.length === 1 ? '' : 's'} with ${result.model.label} (${result.model.group}) in ${(result.ms / 1000).toFixed(1)}s:`,
          ...result.files.map((f) => `- ${f}`),
          delivered,
          ...(result.failed.length ? [`(Tried first, failed: ${result.failed.map((f) => `${f.ref}: ${f.error}`).join('; ')})`] : []),
          ...(result.revisedPrompt ? [`The model's prompt: ${result.revisedPrompt}`] : []),
          ...(result.note ? [`The model said: ${result.note.slice(0, 500)}`] : []),
          `To edit it, call generate_image again with reference_images: ["${result.files[0]}"]. Don't send it again with send_file.`,
        ].join('\n');
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
