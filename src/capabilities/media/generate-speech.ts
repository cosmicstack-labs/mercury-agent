import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { SpeechService } from '../../media/speech.js';

export interface GenerateSpeechDeps {
  speech: SpeechService;
  outputDir(): string;
  /** Is the current chat a messaging app (where audio goes as a voice note)? */
  inChatApp(): boolean;
  deliver(files: string[], caption: string): Promise<string>;
}

/**
 * Text to speech as a deliverable (ADR-042 phase 2): a voice note, a
 * narration, a spoken summary. Chat apps get it as a voice note; the apps
 * show a player; the terminal prints where it was saved.
 */
export function createGenerateSpeechTool(deps: GenerateSpeechDeps) {
  return tool({
    description: [
      'Turn text into spoken audio (a voice note, narration, read-out, pronunciation).',
      'Use when the user asks you to say something out loud, send a voice note or voice message, narrate, or make an audio version.',
      'Write the text exactly as it should be spoken (no markdown). The audio is saved and sent to the user.',
    ].join(' '),
    inputSchema: zodSchema(z.object({
      text: z.string().min(1).max(4000).describe('What to say, word for word.'),
      voice: z.string().max(120).optional().describe('Only when the user names a voice (e.g. "nova", "Kore").'),
      style: z.string().max(300).optional().describe('How to say it, e.g. "calm and warm", "excited", "slowly, like a teacher".'),
    })),
    execute: async ({ text, voice, style }, { abortSignal }) => {
      try {
        const { file, label, ms } = await deps.speech.speakToFile(text, deps.outputDir(), {
          voice,
          instructions: style,
          // A voice note where the chat plays them (Telegram, WhatsApp); mp3 elsewhere.
          format: deps.inChatApp() ? 'ogg' : 'mp3',
          signal: abortSignal,
        });
        const delivered = await deps.deliver([file], text.slice(0, 200)).catch((err) => `not sent to the chat (${err instanceof Error ? err.message : String(err)})`);
        return [`Spoke it with ${label} in ${(ms / 1000).toFixed(1)}s:`, `- ${file}`, delivered, "Don't send it again with send_file."].join('\n');
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
