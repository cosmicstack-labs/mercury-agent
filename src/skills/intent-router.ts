import type { SkillDiscovery, SkillMeta, MatchedSkill } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * IntentRouter — the skill index: categories for the skill list, and an
 * exact match of a message against declared intents (whole phrases) and tags
 * (whole words). No fuzzy scoring (ADR-040): shared single words, word-pair
 * similarity and description guessing matched unrelated requests, and Mercury
 * no longer routes automatically anyway — the model picks skills itself.
 */

/** `phrase` occurs in `text` as whole words. */
function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
}

export class IntentRouter {
  private intentIndex: Map<string, Array<{ skillName: string; intent: string }>> = new Map();
  private tagIndex: Map<string, string[]> = new Map();    // tag -> skill names
  private skillMap: Map<string, { name: string; description: string; category?: string; categories?: string[]; intents?: string[]; tags?: string[] }> = new Map();
  private initialized = false;

  /**
   * Build indexes from discovered skills.
   * Call this after every discovery/re-discovery.
   */
  buildIndex(skills: SkillDiscovery[]): void {
    this.intentIndex.clear();
    this.tagIndex.clear();
    this.skillMap.clear();

    for (const skill of skills) {
      // skill is SkillDiscovery with only name+description.
      // We need to load the full meta to get intents/tags/categories.
      // We store a placeholder and lazy-load on match.
      this.skillMap.set(skill.name, { name: skill.name, description: skill.description });
    }

    this.initialized = true;
    logger.info({ skillCount: skills.length }, 'Intent router index built');
  }

  /**
   * Register full skill metadata (called by loader when parsing SKILL.md).
   * This enriches the index with intents, tags, and categories for matching.
   */
  registerSkillMeta(meta: SkillMeta): void {
    this.skillMap.set(meta.name, {
      name: meta.name,
      description: meta.description,
      category: meta.category,
      categories: meta.categories,
      intents: meta.intents,
      tags: meta.tags,
    });

    // Index intents
    if (meta.intents && meta.intents.length > 0) {
      for (const intent of meta.intents) {
        const normalized = intent.toLowerCase().trim();
        if (!this.intentIndex.has(normalized)) {
          this.intentIndex.set(normalized, []);
        }
        this.intentIndex.get(normalized)!.push({ skillName: meta.name, intent: normalized });
      }
    }

    // Index tags
    if (meta.tags && meta.tags.length > 0) {
      for (const tag of meta.tags) {
        const normalized = tag.toLowerCase().trim();
        if (!this.tagIndex.has(normalized)) {
          this.tagIndex.set(normalized, []);
        }
        if (!this.tagIndex.get(normalized)!.includes(meta.name)) {
          this.tagIndex.get(normalized)!.push(meta.name);
        }
      }
    }
  }

  /**
   * Match user input against all registered intents.
   * Returns ranked matches sorted by confidence (highest first).
   */
  match(userInput: string): MatchedSkill[] {
    if (!this.initialized) return [];

    const input = userInput.toLowerCase().trim();
    if (!input) return [];

    const matches: Map<string, MatchedSkill> = new Map();

    // 1. Exact intent match (highest confidence). Whole words only: "hi"
    // used to match inside "this" or "history", and a one-word message
    // inside any longer intent. The reverse direction (the message is part
    // of an intent) needs at least two words.
    const inputWordCount = input.split(/\s+/).filter(Boolean).length;
    for (const [intent, skills] of this.intentIndex.entries()) {
      if (containsPhrase(input, intent) || (inputWordCount >= 2 && containsPhrase(intent, input))) {
        for (const s of skills) {
          this.addOrUpdateMatch(matches, s.skillName, 0.95, intent);
        }
      }
    }

    // 2. Tag match — require tag ≥4 chars and matched as a whole word
    //    (not just substring) so short tags like "cli" don't match "clip".
    for (const [tag, skillNames] of this.tagIndex.entries()) {
      if (tag.length < 4) continue;
      const wholeWord = new RegExp(`\\b${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (wholeWord.test(input)) {
        for (const name of skillNames) {
          const current = matches.get(name);
          const currentConf = current?.confidence ?? 0;
          this.addOrUpdateMatch(matches, name, Math.max(currentConf, 0.8), undefined);
        }
      }
    }

    // Sort by confidence descending
    return [...matches.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10); // cap at top 10
  }

  /**
   * Group matched skills by category.
   */
  groupByCategory(matchedSkills: MatchedSkill[]): Map<string, MatchedSkill[]> {
    const grouped = new Map<string, MatchedSkill[]>();

    for (const skill of matchedSkills) {
      const categories = skill.categories && skill.categories.length > 0
        ? skill.categories
        : [skill.category || 'uncategorized'];

      for (const cat of categories) {
        if (!grouped.has(cat)) {
          grouped.set(cat, []);
        }
        grouped.get(cat)!.push(skill);
      }
    }

    return grouped;
  }

  /**
   * Get a skill's description (for clarification prompts, # picker, etc.).
   */
  getSkillDescription(name: string): string | undefined {
    return this.skillMap.get(name)?.description;
  }

  /**
   * Analyze the top matches for clear-winner vs ambiguous decision making.
   * - clearWinner: top match >= clearThreshold AND >= gap above the second match
   * - ambiguous: multiple matches clustered near the top with no clear winner
   *
   * IMPORTANT: "ambiguous" requires a *minimum floor of confidence* on the
   * contenders. Without it, three weak 0.55 matches would trip the picker
   * even though none of them is actually a plausible answer — better to
   * fall through and let the LLM decide than to nag the user with a list
   * of irrelevant skills.
   */
  analyzeMatch(userInput: string, opts: { clearThreshold?: number; gap?: number; ambiguityFloor?: number } = {}): {
    matches: MatchedSkill[];
    top?: MatchedSkill;
    clearWinner: boolean;
    ambiguous: boolean;
    closeContenders: MatchedSkill[];
  } {
    const clearThreshold = opts.clearThreshold ?? 0.85;
    const gap = opts.gap ?? 0.15;
    // Default floor: 0.75. A 0.55 weak-keyword match is not a real candidate.
    const ambiguityFloor = opts.ambiguityFloor ?? 0.75;
    const matches = this.match(userInput);
    if (matches.length === 0) {
      return { matches, clearWinner: false, ambiguous: false, closeContenders: [] };
    }

    // Heuristic: if the user is asking to *build*, *create*, or *publish* a
    // new skill, they're meta-discussing skills, not invoking one. Skip
    // routing entirely so we don't show a picker for a request that is
    // explicitly about authoring code.
    const lower = userInput.toLowerCase();
    const metaSkillIntent = /\b(create|build|make|write|publish|design|develop|implement|scaffold)\b[^.]{0,80}\b(skill|plugin|extension|tool|integration)\b/.test(lower)
      || /\bnew skill\b/.test(lower);
    if (metaSkillIntent) {
      return { matches, top: matches[0], clearWinner: false, ambiguous: false, closeContenders: [] };
    }

    const top = matches[0];
    const second = matches[1];
    // Only consider matches above the floor as real contenders.
    const closeContenders = matches.filter(
      m => m.confidence >= ambiguityFloor && top.confidence - m.confidence < gap,
    );
    const clearWinner = top.confidence >= clearThreshold && (!second || top.confidence - second.confidence >= gap);
    const ambiguous = !clearWinner && closeContenders.length >= 2;
    return { matches, top, clearWinner, ambiguous, closeContenders };
  }

  /**
   * Match user input and return category-grouped results.
   */
  matchToBatches(userInput: string, threshold: number = 0.6): Array<{ category: string; categoryLabel: string; skills: MatchedSkill[] }> {
    const matched = this.match(userInput)
      .filter(m => m.confidence >= threshold);

    if (matched.length === 0) return [];

    const grouped = this.groupByCategory(matched);

    const categoryLabels: Record<string, string> = {
      web: 'Web & Research',
      social: 'Social Media',
      media: 'Media & Downloads',
      productivity: 'Productivity',
      system: 'System Administration',
      development: 'Development',
    };

    const batches: Array<{ category: string; categoryLabel: string; skills: MatchedSkill[] }> = [];

    for (const [category, skills] of grouped) {
      batches.push({
        category,
        categoryLabel: categoryLabels[category] || category.charAt(0).toUpperCase() + category.slice(1),
        skills: skills.sort((a, b) => b.confidence - a.confidence),
      });
    }

    // Sort batches by highest confidence skill in each batch
    batches.sort((a, b) => {
      const aMax = Math.max(...a.skills.map(s => s.confidence), 0);
      const bMax = Math.max(...b.skills.map(s => s.confidence), 0);
      return bMax - aMax;
    });

    return batches;
  }

  /**
   * Get the category label for display purposes.
   */
  getCategoryLabel(category: string): string {
    const labels: Record<string, string> = {
      web: 'Web & Research',
      social: 'Social Media',
      media: 'Media & Downloads',
      productivity: 'Productivity',
      system: 'System Administration',
      development: 'Development',
      uncategorized: 'Other',
    };
    return labels[category] || category.charAt(0).toUpperCase() + category.slice(1);
  }

  /**
   * Get all available categories with their skills.
   */
  getAllCategories(): Map<string, Array<{ name: string; description: string }>> {
    const categories = new Map<string, Array<{ name: string; description: string }>>();

    for (const [name, info] of this.skillMap.entries()) {
      const cats = info.categories && info.categories.length > 0
        ? info.categories
        : [info.category || 'uncategorized'];

      for (const cat of cats) {
        if (!categories.has(cat)) {
          categories.set(cat, []);
        }
        categories.get(cat)!.push({ name: info.name, description: info.description });
      }
    }

    return categories;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private addOrUpdateMatch(
    matches: Map<string, MatchedSkill>,
    skillName: string,
    confidence: number,
    matchedIntent?: string,
  ): void {
    const existing = matches.get(skillName);
    const info = this.skillMap.get(skillName);

    if (existing) {
      existing.confidence = Math.max(existing.confidence, confidence);
      if (matchedIntent && !existing.matchedIntent) {
        existing.matchedIntent = matchedIntent;
      }
    } else if (info) {
      matches.set(skillName, {
        name: info.name,
        description: info.description,
        category: info.category,
        categories: info.categories,
        intents: info.intents,
        tags: info.tags,
        confidence,
        matchedIntent,
      });
    }
  }
}
