import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { SpeechService } from '../../media/speech.js';
import { spokenText } from '../../media/spoken-text.js';

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
      '`text` is ONLY the words the listener hears, exactly as they should be heard: no title, no "Here is…", no "Narrator:", no [pause] or (softly) cues, no notes about tone or about how it was made — every word in `text` is spoken aloud.',
      'Put how to say it in `style`. Instructions such as "keep it natural" or "don\'t make it sound like AI" shape how you WRITE the words; they never go in `text`.',
      'The audio is saved and sent to the user.',
    ].join(' '),
    inputSchema: zodSchema(z.object({
      text: z.string().min(1).max(4000).describe('Only the words to be spoken, word for word. Nothing else: everything here is read aloud.'),
      voice: z.string().max(120).optional().describe('Only when the user names a voice (e.g. "nova", "Kore").'),
      style: z.string().max(300).optional().describe('How to say it, briefly: "calm and warm", "excited", "like a news anchor".'),
      service: z.string().max(40).optional().describe('Whenever the user names a voice service, in this message or earlier in the chat: "elevenlabs", "openai", "gemini", "deepgram". Named means that one only.'),
    })),
    execute: async ({ text: raw, voice, style, service }, { abortSignal }) => {
      try {
        // Directions that slipped into the words come out (they'd be read aloud) and become the style.
        const { text, directions } = spokenText(raw);
        if (!text) return 'Error: nothing to say once the directions are taken out. Put only the spoken words in `text`.';
        const { file, label, ms } = await deps.speech.speakToFile(text, deps.outputDir(), {
          voice,
          instructions: style || directions || undefined,
          ...(service ? { service } : {}),
          // A voice note where the chat plays them (Telegram, WhatsApp); mp3 elsewhere.
          format: deps.inChatApp() ? 'ogg' : 'mp3',
          signal: abortSignal,
        });
        const delivered = await deps.deliver([file], text.slice(0, 200)).catch((err) => `not sent to the chat (${err instanceof Error ? err.message : String(err)})`);
        return [
          `Spoke it with ${label} in ${(ms / 1000).toFixed(1)}s:`, `- ${file}`, delivered,
          ...(directions ? [`(Left out of the audio, as directions: ${directions.slice(0, 200)})`] : []),
          "Don't send it again with send_file.",
        ].join('\n');
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
