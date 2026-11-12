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
  /** e.g. "self-made" for skills Mercury wrote (ADR-027). */
  category?: string;
  /** From a folder other agents share (~/.agents/skills): read-only, listed compactly. */
  shared?: boolean;
}

export interface Skill extends SkillMeta {
  instructions: string;
  /** The skill's folder: the files its instructions mention (references/, scripts/) are relative to it. */
  dir?: string;
  /** From a shared folder (~/.agents/skills): its allowed-tools never raise Mercury's permissions. */
  shared?: boolean;
  scriptsDir?: string;
  referencesDir?: string;
}