import type { Skill, SkillInput, SkillOutput } from '../../src/skills/types.js';

export default {
  manifest: {
    name: 'template-skill',
    version: '0.1.0',
    description: 'A template skill for Mercury',
    triggers: ['template'],
    capabilities: ['example'],
  },
  async execute(input: SkillInput): Promise<SkillOutput> {
    return {
      response: `Template skill executed with: ${input.message}`,
      success: true,
    };
  },
} satisfies Skill;