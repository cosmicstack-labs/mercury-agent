import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { SkillLoader } from '../../skills/loader.js';
import { parse as parseYaml } from 'yaml';

export function createInstallSkillTool(skillLoader: SkillLoader) {
  return tool({
    description: 'Install a new skill by providing SKILL.md markdown content or a URL. The content must have YAML frontmatter (---) with at least name and description fields.',
    inputSchema: zodSchema(z.object({
      content: z.string().optional().describe('Raw SKILL.md markdown content with YAML frontmatter'),
      url: z.string().optional().describe('URL to fetch a SKILL.md from'),
    })),
    execute: async ({ content, url }) => {
      let skillContent: string;

      if (url && !content) {
        try {
          const resp = await fetch(url);
          if (!resp.ok) {
            return `Failed to fetch skill from URL: ${resp.status} ${resp.statusText}`;
          }
          skillContent = await resp.text();
        } catch (err: any) {
          return `Failed to fetch skill from URL: ${err.message}`;
        }
      } else if (content) {
        skillContent = content;
      } else {
        return 'Either content or url must be provided.';
      }

      const fmMatch = skillContent.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        return 'Invalid SKILL.md: missing YAML frontmatter (--- delimiters).';
      }

      try {
        const meta = parseYaml(fmMatch[1]) as Record<string, any>;
        if (!meta.name || !meta.description) {
          return 'Invalid SKILL.md: frontmatter must include at least "name" and "description".';
        }
      } catch {
        return 'Invalid SKILL.md: could not parse YAML frontmatter.';
      }

      const fmMatch2 = skillContent.match(/^---\s*\n([\s\S]*?)\n---/);
      const meta = parseYaml(fmMatch2![1]) as { name: string };
      const skillDir = skillLoader.saveSkill(meta.name, skillContent);

      return `Skill "${meta.name}" installed to ${skillDir}. Use list_skills to see all installed skills, or use_skill to invoke it.`;
    },
  });
}