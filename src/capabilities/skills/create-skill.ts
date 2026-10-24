import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { SkillLoader } from '../../skills/loader.js';
import { SELF_MADE_CATEGORY, composeSkillMd, readSelfMadeMeta, rejectDraft, slugify } from '../../skills/self-made.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `create_skill` (ADR-027): Mercury saves a procedure that just worked as a
 * self-made skill. Owner-only, like install_skill. Strict on purpose: the
 * owner does not want a shelf of half-written junk.
 */
export function createCreateSkillTool(skillLoader: SkillLoader) {
  return tool({
    description:
      'Save a procedure you just carried out and verified as a reusable self-made skill, so the next time it is one use_skill away. '
      + 'Only for multi-step work you would do again for other inputs (a recurring report, a conversion pipeline, a deploy, a site or device you operate). '
      + 'Never for one-offs, for anything a single tool call does, for anything you did not verify end-to-end, or with credentials inside. '
      + 'To improve an existing self-made skill, call this again with the same name. Self-made skills are listed separately and stay "unverified" until used again.',
    inputSchema: zodSchema(z.object({
      name: z.string().describe('Short slug, e.g. "weekly-sales-report" or "deploy-ceo-site"'),
      description: z.string().describe('One or two sentences: what it does and for which inputs (20–220 chars)'),
      intents: z.array(z.string()).min(1).max(12).describe('How the owner would ask for this, in their words ("make the weekly sales report")'),
      instructions: z.string().describe('The procedure as numbered steps: exact commands, tools, paths, inputs to ask for, checks, and the pitfalls you hit. Not a narrative.'),
      verified: z.string().describe('One line: what you checked when it worked (e.g. "PDF opened, 12 pages, totals match the sheet")'),
      allowedTools: z.array(z.string()).optional().describe('Tools the skill needs (least privilege); omit to inherit'),
    })),
    execute: async ({ name, description, intents, instructions, verified, allowedTools }) => {
      const draft = { name, description, intents, instructions, verified, allowedTools };
      const why = rejectDraft(draft);
      if (why) return `Not saved — ${why}.`;
      const slug = slugify(name)!;

      // A curated skill with this name wins; self-made ones never shadow it.
      const existing = skillLoader.load(slug);
      if (existing && existing.category !== SELF_MADE_CATEGORY) {
        return `Not saved — "${slug}" is already an installed skill. Use it (use_skill), or pick a different name if this is something else.`;
      }
      const file = join(skillLoader.rootDir(), SELF_MADE_CATEGORY, slug, 'SKILL.md');
      const prior = existsSync(file) ? readSelfMadeMeta(readFileSync(file, 'utf-8')) ?? undefined : undefined;
      skillLoader.saveSkill(`${SELF_MADE_CATEGORY}/${slug}`, composeSkillMd(draft, prior));
      const verb = prior ? 'updated' : 'saved';
      return `Self-made skill "${slug}" ${verb}. Tell the owner in one line, e.g. "☿ Skill ${verb}: ${slug} — say /skills self-made to review or remove it." Next time, use_skill "${slug}" before doing this by hand.`;
    },
  });
}
