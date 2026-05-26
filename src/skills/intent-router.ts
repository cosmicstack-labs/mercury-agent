import type { SkillDiscovery, SkillMeta, MatchedSkill } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * IntentRouter — matches user input against skill intents to route requests
 * to the right skill(s) automatically.
 */
export class IntentRouter {
  private intentIndex: Map<string, Array<{ skillName: string; intent: string }>> = new Map();
  private tagIndex: Map<string, string[]> = new Map();    // tag -> skill names
  private keywordIndex: Map<string, string[]> = new Map(); // keyword -> skill names
  private skillMap: Map<string, { name: string; description: string; category?: string; categories?: string[]; intents?: string[]; tags?: string[] }> = new Map();
  private initialized = false;

  /**
   * Build indexes from discovered skills.
   * Call this after every discovery/re-discovery.
   */
  buildIndex(skills: SkillDiscovery[]): void {
    this.intentIndex.clear();
    this.tagIndex.clear();
    this.keywordIndex.clear();
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

        // Also index individual words from the intent for fuzzy matching
        const words = normalized.split(/\s+/).filter(w => w.length > 2);
        for (const word of words) {
          if (!this.keywordIndex.has(word)) {
            this.keywordIndex.set(word, []);
          }
          if (!this.keywordIndex.get(word)!.includes(meta.name)) {
            this.keywordIndex.get(word)!.push(meta.name);
          }
        }
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

    // 1. Exact intent match (highest confidence)
    for (const [intent, skills] of this.intentIndex.entries()) {
      if (input.includes(intent) || intent.includes(input)) {
        for (const s of skills) {
          this.addOrUpdateMatch(matches, s.skillName, 0.95, intent);
        }
      }
    }

    // 2. Word overlap match (medium confidence)
    const inputWords = input.split(/\s+/).filter(w => w.length > 2);
    const inputBigrams = this.getBigrams(input);

    for (const [word, skillNames] of this.keywordIndex.entries()) {
      if (inputWords.includes(word)) {
        for (const name of skillNames) {
          const current = matches.get(name);
          const currentConf = current?.confidence ?? 0;
          this.addOrUpdateMatch(matches, name, Math.max(currentConf, 0.7), undefined);
        }
      }
    }

    // 3. Bigram similarity (lower confidence but catches paraphrases)
    for (const [word, skillNames] of this.keywordIndex.entries()) {
      const wordBigrams = this.getBigrams(word);
      const overlap = inputBigrams.filter(b => wordBigrams.includes(b)).length;
      const maxLen = Math.max(inputBigrams.length, wordBigrams.length);
      if (maxLen > 0 && overlap / maxLen > 0.3) {
        for (const name of skillNames) {
          const current = matches.get(name);
          const currentConf = current?.confidence ?? 0;
          this.addOrUpdateMatch(matches, name, Math.max(currentConf, 0.5), undefined);
        }
      }
    }

    // 4. Tag match
    for (const [tag, skillNames] of this.tagIndex.entries()) {
      if (input.includes(tag)) {
        for (const name of skillNames) {
          const current = matches.get(name);
          const currentConf = current?.confidence ?? 0;
          this.addOrUpdateMatch(matches, name, Math.max(currentConf, 0.8), undefined);
        }
      }
    }

    // 5. Description keyword match (lowest confidence)
    for (const [name, info] of this.skillMap.entries()) {
      if (matches.has(name)) continue; // already matched
      const desc = info.description.toLowerCase();
      const matchCount = inputWords.filter(w => desc.includes(w)).length;
      if (matchCount >= 2) {
        this.addOrUpdateMatch(matches, name, Math.min(0.5, 0.15 * matchCount), undefined);
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
   * Match user input and return category-grouped results.
   */
  matchToBatches(userInput: string, threshold: number = 0.4): Array<{ category: string; categoryLabel: string; skills: MatchedSkill[] }> {
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

  private getBigrams(text: string): string[] {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.push(`${words[i]} ${words[i + 1]}`);
    }
    return bigrams;
  }
}
