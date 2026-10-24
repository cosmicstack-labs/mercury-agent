import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { SkillLoader } from '../../skills/loader.js';
import type { PermissionManager } from '../permissions.js';
import { SELF_MADE_CATEGORY } from '../../skills/self-made.js';

export function createUseSkillTool(skillLoader: SkillLoader, permissions: PermissionManager) {
  return tool({
    description: 'Load and invoke a skill by name. Returns the skill\'s full instructions which should be followed as guidance for the current task.',
    inputSchema: zodSchema(z.object({
      name: z.string().describe('Name of the skill to invoke'),
    })),
    execute: async ({ name }) => {
      const skill = skillLoader.load(name);
      if (!skill) {
        return `Skill "${name}" not found. Use list_skills to see available skills.`;
      }

      if (skill['allowed-tools'] && skill['allowed-tools'].length > 0) {
        permissions.elevateForSkill(skill['allowed-tools']);
      }
      if (skill.category === SELF_MADE_CATEGORY) skillLoader.noteUse(skill.name);

      let result = `## Skill: ${skill.name}\n\n${skill.instructions}`;
      if (skill.category === SELF_MADE_CATEGORY) {
        result += '\n\n_Self-made skill: you wrote this after it worked once. Follow it, but trust the result, not the text — if a step fails, fix it and save the corrected procedure with create_skill under the same name._';
      }

      if (skill['allowed-tools'] && skill['allowed-tools'].length > 0) {
        result += `\n\nAllowed tools: ${skill['allowed-tools'].join(', ')}`;
      }

      if (skill['disable-model-invocation']) {
        result += '\n\nNote: This skill has model invocation disabled. Follow instructions only.';
      }

      return result;
    },
  });
}