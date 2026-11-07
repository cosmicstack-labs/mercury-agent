import type { BaseProvider } from '../providers/base.js';
import { MAX_INSTRUCTION_CHARS, MIN_INSTRUCTION_CHARS, rejectDraft, slugify } from './self-made.js';

/**
 * The skill builder: the owner describes a skill in their own words and
 * Mercury's model writes it (name, when to use it, a step-by-step
 * procedure, the tools it needs). Nothing is saved here; the owner reviews,
 * edits or asks for changes, then saves it as a self-made skill.
 */

export interface SkillDraft {
  name: string;
  description: string;
  intents: string[];
  instructions: string;
  allowedTools?: string[];
}

export const BUILDER_VERIFIED_NOTE = 'Written with the skill builder from the owner\'s description; not run yet.';

const SYSTEM = `You write skills for Mercury, a personal AI agent. A skill is a reusable, step-by-step procedure Mercury follows when the owner asks for that kind of task.

Return ONLY a JSON object, no prose, no code fences:
{
  "name": "short-kebab-slug (3-40 chars)",
  "description": "One or two sentences (20-220 chars): what it does and for which inputs.",
  "intents": ["3-6 ways the owner would ask for this, in plain words"],
  "instructions": "The procedure as numbered steps (1. 2. 3.). Exact tools to use, inputs to ask the owner for, checks to make, the output to deliver, and pitfalls. ${MIN_INSTRUCTION_CHARS}-${Math.min(4000, MAX_INSTRUCTION_CHARS)} chars. No credentials: refer to where they are configured.",
  "allowedTools": ["only tools from the list given, the fewest that do the job"]
}

Rules: concrete and runnable, not a narrative; ask the owner for anything you can't know; verify the result before reporting; never invent tools.`;

export function builderPrompt(request: string, tools: string[], previous?: { draft: SkillDraft; feedback: string }): string {
  const lines = [`The owner wants a skill for this:\n${request.trim()}`, '', `Tools Mercury has (use these names exactly): ${tools.slice(0, 200).join(', ') || '(none listed)'}`];
  if (previous) lines.push('', 'Your previous draft:', JSON.stringify(previous.draft), '', `Change it like this: ${previous.feedback.trim()}`);
  return lines.join('\n');
}

/** Pull the JSON object out of a model reply (tolerates fences and chatter around it). */
export function parseDraft(text: string, tools: string[]): SkillDraft {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model didn\'t return a skill. Try describing it again.');
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('The model returned something that isn\'t a skill. Try again.'); }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const known = new Set(tools);
  const allowed = Array.isArray(raw.allowedTools) ? (raw.allowedTools as unknown[]).map(str).filter((t) => t && (known.size === 0 || known.has(t))) : [];
  return {
    name: slugify(str(raw.name)) ?? str(raw.name),
    description: str(raw.description),
    intents: Array.isArray(raw.intents) ? (raw.intents as unknown[]).map(str).filter(Boolean).slice(0, 12) : [],
    instructions: str(raw.instructions),
    ...(allowed.length ? { allowedTools: [...new Set(allowed)] } : {}),
  };
}

/** What's wrong with a draft as a self-made skill, or null. */
export function draftProblem(d: SkillDraft): string | null {
  return rejectDraft({ ...d, verified: BUILDER_VERIFIED_NOTE });
}

/**
 * Write a draft with the given model. One automatic retry when the first
 * try breaks the skill rules, telling the model exactly what to fix.
 */
export async function buildSkillDraft(provider: BaseProvider, request: string, tools: string[], previous?: { draft: SkillDraft; feedback: string }): Promise<{ draft: SkillDraft; problem: string | null; model: string }> {
  const first = await provider.generateText(builderPrompt(request, tools, previous), SYSTEM);
  let draft = parseDraft(first.text, tools);
  let problem = draftProblem(draft);
  if (problem) {
    const again = await provider.generateText(builderPrompt(request, tools, { draft, feedback: `Fix this: ${problem}.` }), SYSTEM);
    try {
      const fixed = parseDraft(again.text, tools);
      const fixedProblem = draftProblem(fixed);
      if (!fixedProblem || fixedProblem.length <= problem.length) { draft = fixed; problem = fixedProblem; }
    } catch { /* keep the first draft and say what's wrong */ }
  }
  return { draft, problem, model: provider.getModel() };
}
