export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  capabilities: string[];
}

export interface Skill {
  manifest: SkillManifest;
  execute(input: SkillInput): Promise<SkillOutput>;
}

export interface SkillInput {
  message: string;
  context: Record<string, unknown>;
}

export interface SkillOutput {
  response: string;
  success: boolean;
  metadata?: Record<string, unknown>;
}