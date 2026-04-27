/**
 * @fileoverview Skill View Tool - View Skill Details
 * 
 * Allows the agent to view a skill's full content including metadata and instructions.
 * Use this before creating a similar skill or when updating an existing one.
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { SkillLoader } from '../../skills/loader.js';
import { MAX_NAME_LENGTH } from '../../skills/utils.js';

/**
 * Creates the skill_view tool for the capability registry.
 * @param skillLoader - The skill loader instance
 * @returns AI tool definition for viewing skills
 */
export function createSkillViewTool(skillLoader: SkillLoader) {
  return tool({
    description: `View a skill's full content including metadata and instructions. Use this before creating a similar skill or when updating an existing one. Shows the complete SKILL.md content so you can understand the format and decide if you need to create a new skill or update an existing one.`,

    inputSchema: zodSchema(z.object({
      name: z.string().max(MAX_NAME_LENGTH).describe('Name of the skill to view.'),
    })),

    execute: async ({ name }) => {
      const skill = skillLoader.load(name);
      if (!skill) {
        return `Skill "${name}" not found. Use list_skills to see available skills.`;
      }

      let result = `## Skill: ${skill.name}\n\n`;
      result += `**Description:** ${skill.description}\n`;
      
      if (skill.version) {
        result += `**Version:** ${skill.version}\n`;
      }
      
      if (skill['allowed-tools'] && skill['allowed-tools'].length > 0) {
        result += `**Allowed Tools:** ${skill['allowed-tools'].join(', ')}\n`;
      }
      
      if (skill['disable-model-invocation']) {
        result += `**Model Invocation:** Disabled\n`;
      }

      result += `\n---\n\n${skill.instructions}`;

      // Show available supporting files
      if (skill.scriptsDir || skill.referencesDir) {
        result += '\n\n---\n\n**Supporting Files:**\n';
        if (skill.scriptsDir) result += '- `scripts/` directory available\n';
        if (skill.referencesDir) result += '- `references/` directory available\n';
      }

      return result;
    },
  });
}