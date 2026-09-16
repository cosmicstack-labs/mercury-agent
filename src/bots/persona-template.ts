import type { BaseProvider } from '../providers/base.js';
import { logger } from '../utils/logger.js';

export interface PersonaRefinement {
  /** Refined persona (template format), or null when unusable. */
  text: string | null;
}

/**
 * "Convert to template" — turn a user's free-form persona text into the
 * structured format that produces good bot behavior (Character / Standing
 * instructions / Output, the same sections as the onboarding template).
 *
 * Hard rule: refinement only RESTRUCTURES. It may not add capabilities,
 * permissions, or instructions the user didn't give — an LLM quietly
 * widening a bot's mandate would be a silent privilege grant.
 */
export async function refinePersona(raw: string, botName: string, provider: BaseProvider): Promise<string | null> {
  try {
    const result = await provider.generateText(
      `Convert this free-form bot persona into a structured persona file. Bot name: ${botName}.

User's persona (preserve every explicit requirement, restructure only):
"""
${raw.slice(0, 4000)}
"""

Output ONLY markdown, in exactly this shape:

# ${botName}

<one-sentence identity summary>

## Character

<personality, voice, expertise boundaries>

## Standing instructions

- <each behavioral requirement as a bullet, including every rule the user wrote>

## Output

<output format expectations>

Rules: never invent new capabilities, tools, or permissions; keep the bot's stated restrictions verbatim in meaning; 100-300 words; no preamble, no code fences.`,
      'You write precise bot persona files. Restructure only; never add or remove requirements.',
    );
    const text = (result.text ?? '').trim();
    if (!text.startsWith('#') || text.length < 80 || text.length > 5000 || !text.includes('##')) {
      logger.debug({ botName }, 'Persona refinement produced unusable output — keeping raw');
      return null;
    }
    return text.endsWith('\n') ? text : text + '\n';
  } catch (err: any) {
    logger.warn({ botName, err: err?.message }, 'Persona refinement failed — keeping raw persona');
    return null;
  }
}