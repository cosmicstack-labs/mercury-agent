import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { BaseProvider } from '../providers/base.js';

export interface SkillSynthesisInput {
  botId: string;
  botName: string;
  /** The task the bot performed. */
  prompt: string;
  /** The bot's final summary. */
  output: string;
  /** Distinct tools used during the run (≥3 distinct = a procedure worth keeping). */
  toolsUsed: string[];
  provider: BaseProvider;
  skillsRoot?: string;
}

export interface SynthesizedSkill {
  name: string;
  path: string;
}

export const MIN_TOOLS_FOR_SYNTHESIS = 3;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'skill';
}

/**
 * Auto-skill synthesis (competitive-roadmap "self-improvement" wedge):
 * after a bot completes a genuinely multi-step run, draft a reusable
 * SKILL.md from the transcript — written with `draft: true` so it is
 * reviewable, and never allowed to break or block the run that produced it.
 */
export async function synthesizeSkill(input: SkillSynthesisInput): Promise<SynthesizedSkill | null> {
  const skillsRoot = resolve(input.skillsRoot ?? join(getMercuryHome(), 'skills'));
  try {
    const result = await input.provider.generateText(
      `You distill a completed bot run into a reusable skill for the Mercury agent.

Bot: ${input.botName} (${input.botId})
Task: ${input.prompt.slice(0, 800)}
Tools used: ${input.toolsUsed.join(', ')}
Outcome summary:
${input.output.slice(0, 2000)}

Write the skill that captures the REUSABLE procedure (not this one instance). Rules:
- Start with YAML frontmatter: name, description (one line, when to use), allowed-tools (comma-separated tool names actually needed), draft: true
- Then markdown instructions: numbered steps, decision points, and failure handling.
- The skill must generalize beyond this specific task instance.
- 150-350 words. No preamble, no code fences around the whole file.`,
      'You write concise, procedural agent skills. Return ONLY the file content.',
    );

    const content = (result.text ?? '').trim();
    if (!content || content.length < 80 || !content.startsWith('---')) {
      logger.debug({ botId: input.botId }, 'Skill synthesis skipped: unusable model output');
      return null;
    }
    // Pull the skill name out of the frontmatter for the directory slug.
    const nameMatch = /^name:\s*(.+)$/m.exec(content);
    const name = (nameMatch?.[1] ?? `${input.botId}-skill`).trim().slice(0, 60);
    const slug = slugify(`${input.botId}-${name}`);
    const dir = join(skillsRoot, 'bots', slug);
    if (!dir.startsWith(resolve(skillsRoot) + '/')) return null; // traversal guard
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    if (!existsSync(path)) {
      writeFileSync(path, content.endsWith('\n') ? content : content + '\n', 'utf-8');
      logger.info({ botId: input.botId, path }, 'Auto-skill draft synthesized from bot run');
      return { name, path };
    }
    logger.debug({ botId: input.botId, path }, 'Skill draft already exists — not overwritten');
    return null;
  } catch (err: any) {
    logger.warn({ botId: input.botId, err: err?.message }, 'Auto-skill synthesis failed (non-fatal)');
    return null;
  }
}