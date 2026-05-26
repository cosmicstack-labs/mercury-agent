export interface SkillMeta {
  name: string;
  description: string;
  version?: string;
  category?: string;              // Primary category
  categories?: string[];          // Multiple categories for cross-listing
  intents?: string[];             // Natural language trigger phrases
  tags?: string[];                // Freeform tags for matching
  'allowed-tools'?: string[];
  'disable-model-invocation'?: boolean;
}

export interface MatchedSkill {
  name: string;
  description: string;
  category?: string;
  categories?: string[];
  intents?: string[];
  tags?: string[];
  confidence: number;            // 0.0 - 1.0 match confidence
  matchedIntent?: string;        // Which intent phrase matched
}

export interface SkillBatch {
  category: string;
  categoryLabel: string;
  skills: MatchedSkill[];
}

export interface SkillDiscovery {
  name: string;
  description: string;
}

export interface Skill extends SkillMeta {
  instructions: string;
  scriptsDir?: string;
  referencesDir?: string;
}