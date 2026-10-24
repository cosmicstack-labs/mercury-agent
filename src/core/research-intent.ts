/**
 * Does the owner want a full research article, or just an answer / a task
 * done? Words alone can't tell: "do X with the latest file" and "what's the
 * latest on X" both say "latest". The cheap word filter (looksResearchy in
 * agent.ts) decides whether to ask at all; this asks the model.
 *
 * Anything unclear, slow or failing counts as NORMAL: a missed research
 * prompt costs nothing (the owner can type /research), a wrong one interrupts
 * a request with a question nobody asked for.
 */

export const RESEARCH_INTENT_SYSTEM = `You decide whether a chat message asks for a full research report.

Answer RESEARCH only when the person explicitly wants an in-depth, multi-source write-up on a topic: a report, an article, a deep dive, a comprehensive overview, a comparison study, a literature review.

Answer NORMAL for everything else, including:
- instructions to do something (convert, fix, send, open, install, write code, edit a file), even if the task needs a web search;
- quick factual questions, prices, definitions, "who is", "when is";
- today's news or headlines, weather, scores;
- conversation, opinions, follow-ups.

Reply with exactly one word: RESEARCH or NORMAL.`;

export type ResearchIntent = 'research' | 'normal';

/** The model's verdict; anything but a clear RESEARCH is NORMAL. */
export function parseResearchIntent(text: string): ResearchIntent {
  const first = text.trim().split(/\s+/)[0]?.replace(/[^a-z]/gi, '').toUpperCase() ?? '';
  return first === 'RESEARCH' ? 'research' : 'normal';
}

/**
 * Ask the model, within `timeoutMs`. `generate` runs one small completion
 * with the given system prompt and user text and returns its text.
 */
export async function classifyResearchIntent(
  message: string,
  generate: (system: string, user: string) => Promise<string>,
  timeoutMs = 6000,
): Promise<ResearchIntent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verdict = await Promise.race([
      generate(RESEARCH_INTENT_SYSTEM, message.slice(0, 2000)),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('NORMAL'), timeoutMs); }),
    ]);
    return parseResearchIntent(verdict);
  } catch {
    return 'normal';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
