import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { SkillLoader } from '../../skills/loader.js';

export function createListSkillsTool(skillLoader: SkillLoader) {
  return tool({
    description: 'List all installed skills with their names and descriptions.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const skills = skillLoader.getDiscovered();
      if (skills.length === 0) {
        return 'No skills installed. Use install_skill to add one.';
      }
      return skills.map(s => `${s.name}: ${s.description}`).join('\n');
    },
  });
}