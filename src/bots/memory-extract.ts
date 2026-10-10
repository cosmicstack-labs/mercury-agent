import { generateText } from 'ai';
import type { UserMemoryStore, UserMemoryType } from '../memory/user-memory.js';
import type { BaseProvider } from '../providers/base.js';
import type { TokenBudget } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

type Candidate = Parameters<UserMemoryStore['remember']>[0][number];

/** Only productive runs teach anything; short replies carry nothing durable. */
const MIN_OUTPUT_CHARS = 200;
const MAX_INPUT_CHARS = 6000;

/**
 * After a productive run, keep what the bot learned (ADR-021): sources it
 * found, decisions it took, where things are, what failed. One small call
 * on the bot's own provider; 0–3 facts into the bot's own memory namespace.
 * The main agent has had this since 1.2; bots had 900 chars of retrieval
 * and nothing written back, which is why they wrote their memory to disk
 * as "records".
 */
export async function extractBotMemories(input: {
  botId: string;
  botName: string;
  prompt: string;
  output: string;
  outcome: string;
  deliverables: string[];
  provider: BaseProvider;
  tokenBudget: TokenBudget;
  memory: UserMemoryStore;
}): Promise<number> {
  const { memory, provider, tokenBudget } = input;
  if (memory.isLearningPaused()) return 0;
  if (input.outcome === 'none' || input.output.trim().length < MIN_OUTPUT_CHARS) return 0;
  if (!tokenBudget.canAfford(1200)) return 0;
  try {
    const result = await generateText({
      model: provider.getModelInstance(),
      system: `You maintain the long-term memory of "${input.botName}", an unattended Mercury bot. From one finished run, output a JSON array of 0-3 facts worth keeping for FUTURE runs.

Each: { type, summary (12-220 chars), detail (optional), confidence (0-1), importance (0-1), categories (1-3 lowercase words) }.

TYPES: project (what is being worked on and its state), decision (a choice made and why), constraint (a rule or limit learned, e.g. a source that is unreliable, a tool that fails), episode (a notable one-time event), goal.

RULES:
- Durable and specific only: sources found and their quality, decisions, where deliverables are, what to avoid next time.
- Never store the run's own narration, status, timestamps, or anything the journal already records (tokens, steps, "run completed").
- No greetings, no assistant behaviour, no duplicates.
- Output a pure JSON array, no markdown fences. Output [] when nothing is durable.`,
      messages: [{ role: 'user', content: `Task given:\n${input.prompt.slice(0, 1500)}\n\nOutcome: ${input.outcome}${input.deliverables.length ? `\nDelivered: ${input.deliverables.join(', ')}` : ''}\n\nFinal reply:\n${input.output.slice(0, MAX_INPUT_CHARS)}` }],
      maxOutputTokens: 400,
    });
    tokenBudget.recordUsage({
      provider: provider.name,
      model: provider.getModel(),
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      channelType: 'bot',
    });
    const text = result.text.trim().replace(/^```(?:json)?\s*|```$/g, '');
    if (!text) return 0;
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return 0; }
    if (!Array.isArray(raw)) return 0;
    const candidates = raw.slice(0, 3).flatMap((c): Candidate[] => {
      if (!c || typeof c !== 'object') return [];
      const o = c as Record<string, unknown>;
      if (typeof o.summary !== 'string' || o.summary.length < 12) return [];
      const type = (['project', 'decision', 'constraint', 'episode', 'goal'].includes(String(o.type)) ? String(o.type) : 'episode') as UserMemoryType;
      return [{
        type,
        summary: o.summary.slice(0, 220),
        detail: typeof o.detail === 'string' ? o.detail.slice(0, 600) : undefined,
        categories: Array.isArray(o.categories) ? o.categories.filter((x): x is string => typeof x === 'string').slice(0, 3) : ['work'],
        evidenceKind: 'direct',
        confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0.7,
        importance: typeof o.importance === 'number' ? Math.max(0, Math.min(1, o.importance)) : 0.5,
        durability: 0.7,
      } as Candidate];
    });
    if (candidates.length === 0) return 0;
    return memory.remember(candidates, 'conversation').length;
  } catch (err) {
    logger.warn({ botId: input.botId, err: (err as Error)?.message }, 'Bot memory extraction failed — continuing');
    return 0;
  }
}
