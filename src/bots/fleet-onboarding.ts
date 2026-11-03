import type { BaseProvider } from '../providers/base.js';
import { logger } from '../utils/logger.js';

export interface CrewProposal {
  id: string;
  name: string;
  description: string;
  persona: string;
}

/**
 * Fleet auto-onboarding: one LLM call proposes a crew of 3-5 specialists for
 * a lead bot, matched to its domain. CrewAI guidance — small crews (3-6)
 * keep delegation accuracy high; the proposal is only a SUGGESTION: every
 * member still goes through the standard creation path (validation, cap,
 * persona builder) before anything exists.
 *
 * Output is parsed from a strict JSON array; unusable output returns []
 * (non-fatal — the user falls back to the manual path).
 */
export async function proposeCrew(
  leadName: string,
  leadDescription: string,
  leadPersona: string,
  provider: BaseProvider,
  maxCrew = 6,
): Promise<CrewProposal[]> {
  try {
    const result = await provider.generateText(
      `Design the crew for a fleet lead bot. Lead: "${leadName}" — ${leadDescription || 'no description'}.

Lead persona (context for what specialists it needs):
"""
${leadPersona.slice(0, 3000)}
"""

Propose ${Math.min(5, maxCrew)} sub-bots (2-5, no more) that this lead should command. Each must be a DISTINCT specialty the lead would genuinely delegate to (research, writing, monitoring, development, analysis...). Output ONLY a JSON array, no preamble, no code fences:
[
  {
    "id": "short-lowercase-id-with-dashes",
    "name": "Display Name",
    "description": "One-line specialty",
    "persona": "Full persona text (80-250 words): who it is, how it works, how it reports. Character, standing instructions, output expectations."
  }
]`,
      'You design focused, non-overlapping agent teams. Return ONLY the JSON array.',
    );
    const text = (result.text ?? '').trim().replace(/^```(?:json)?\n?|\n?```$/g, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(text.slice(start, end + 1)) as CrewProposal[];
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .filter(p => {
        if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') return false;
        if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(p.id)) return false;
        if (!p.persona || p.persona.length < 20) return false;
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      })
      .slice(0, maxCrew)
      .map(p => ({
        id: p.id,
        name: p.name.slice(0, 48),
        description: (p.description ?? '').slice(0, 200),
        persona: p.persona,
      }));
  } catch (err: any) {
    logger.warn({ leadName, err: err?.message }, 'Fleet crew proposal failed — falling back to manual');
    return [];
  }
}
export interface BotShapePlan {
  shape: 'solo' | 'fleet';
  /** One plain sentence: why this shape. */
  reason: string;
  /** The lead's crew, when shape is fleet (2-5). */
  crew: CrewProposal[];
}

/**
 * "Let Mercury decide": one call looks at what the owner wants a bot for and
 * says whether one bot does it (solo) or it needs a small team (a lead with
 * crew), and if so, proposes the crew. A fleet costs a turn per hand-off, so
 * it's only right when the work has genuinely separate stages or specialties.
 * The plan is a proposal: the owner sees it, edits it, and only then is
 * anything created. Unusable output falls back to solo with no crew.
 */
export async function planBotShape(
  input: { name: string; description: string; persona: string; fleet?: boolean },
  provider: BaseProvider,
  maxCrew = 6,
): Promise<BotShapePlan> {
  const solo = (reason: string): BotShapePlan => ({ shape: 'solo', reason, crew: [] });
  try {
    const result = await provider.generateText(
      `An owner is creating an autonomous bot. Decide whether ONE bot should do this job, or a small FLEET: a lead bot that delegates to 2-5 specialist crew bots.

Bot: "${input.name}" — ${input.description || 'no description'}
What it should do:
"""
${input.persona.slice(0, 4000) || '(not written yet)'}
"""

${input.fleet
    ? 'The owner has decided this is a FLEET: answer "fleet" and design the crew — the fewest distinct specialists that cover the job.'
    : 'Choose "fleet" ONLY when the job has clearly separate stages or specialties that each need their own focus (e.g. research → write → fact-check → publish, or monitoring several unrelated sources). Every hand-off costs a full extra run, so a single focused job, a monitor, a digest, a researcher or a writer is "solo". When in doubt, choose solo.'}

Output ONLY JSON, no preamble, no code fences:
{
  "shape": "solo" | "fleet",
  "reason": "One plain sentence for the owner: why this shape.",
  "crew": [
    { "id": "short-lowercase-id", "name": "Display Name", "description": "One-line specialty", "persona": "80-200 words: who it is, how it works, what it hands back to the lead (as a bot_report)." }
  ]
}
crew is [] for solo; 2-${Math.min(5, maxCrew)} distinct, non-overlapping specialists for fleet.`,
      'You design lean agent setups. Prefer the simplest setup that does the job. Return ONLY the JSON object.',
    );
    const text = (result.text ?? '').trim().replace(/^```(?:json)?\n?|\n?```$/g, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return solo('Mercury couldn\'t plan this one, so it starts as a single bot.');
    const raw = JSON.parse(text.slice(start, end + 1)) as { shape?: string; reason?: string; crew?: CrewProposal[] };
    const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim().slice(0, 300) : '';
    if (raw.shape !== 'fleet') return solo(reason || 'One bot can do this job.');
    const seen = new Set<string>();
    const crew = (Array.isArray(raw.crew) ? raw.crew : [])
      .filter((p) => p && typeof p.name === 'string' && typeof p.persona === 'string' && p.persona.length >= 20)
      .map((p) => ({
        id: (typeof p.id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(p.id) ? p.id : p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 48),
        name: p.name.slice(0, 48),
        description: (p.description ?? '').slice(0, 200),
        persona: p.persona,
      }))
      .filter((p) => p.id && !seen.has(p.id) && (seen.add(p.id), true))
      .slice(0, Math.min(5, maxCrew));
    if (crew.length < 2) return solo(reason || 'One bot can do this job.');
    return { shape: 'fleet', reason: reason || `This job has ${crew.length} separate parts.`, crew };
  } catch (err) {
    logger.warn({ name: input.name, err: (err as Error)?.message }, 'Bot shape planning failed — suggesting solo');
    return solo('Mercury couldn\'t plan this one, so it starts as a single bot.');
  }
}
