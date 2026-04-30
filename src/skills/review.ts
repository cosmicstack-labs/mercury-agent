/**
 * @fileoverview Skill Review System - Self-Improving Skills Implementation
 * 
 * Tracks task complexity and triggers skill review suggestions.
 * Based on Hermes-Agent's closed learning loop pattern.
 * 
 * Features:
 * - Tracks iterations since last skill action
 * - Triggers review after configurable interval
 * - Generates skill suggestions based on conversation history
 * 
 * Follows Mercury's principles:
 * - Token-conscious: lightweight tracking, async generation
 * - Self-documenting: clear function documentation
 * - Graceful degradation: handles provider failures gracefully
 */

import { generateText } from 'ai';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SkillLoader } from './loader.js';
import { logger } from '../utils/logger.js';

/** Configuration for skill review triggers */
export interface SkillReviewConfig {
  /** How often (in messages) to trigger skill review. Default: 10 */
  nudgeInterval: number;
  /** Minimum tool calls before suggesting a skill. Default: 5 */
  minToolCalls: number;
}

const DEFAULT_CONFIG: SkillReviewConfig = {
  nudgeInterval: 10,
  minToolCalls: 5,
};

/**
 * Prompt used to trigger skill review after complex tasks.
 * Follows Mercury's token-conscious principle - concise but comprehensive.
 */
const SKILL_REVIEW_PROMPT = `Review the conversation above and consider whether a skill should be saved or updated.

Guidelines:
1. SURVEY the existing skill landscape first. Call list_skills to see what you have. If anything looks potentially relevant, use the skill to see its instructions before deciding.
2. ONLY CREATE A NEW SKILL when no existing skill reasonably covers the class.
3. PREFER GENERALIZING AN EXISTING SKILL over creating a new one. If a skill already covers the class — even partially — update it (skill_manage action='patch') instead of creating a duplicate.
4. If you notice two existing skills that overlap, note it in your response for future cleanup.
5. If you used a skill and hit issues not covered by it, patch it immediately to include the pitfalls.

Consider creating/updating a skill when:
- A complex task succeeded (5+ tool calls)
- Errors were overcome through a specific approach
- A user-corrected approach worked better than your initial plan
- A non-trivial workflow was discovered
- User asked you to remember a procedure

Skip creating skills for:
- Simple one-off tasks
- Trivial greetings or acknowledgments
- Tasks that can be handled by existing skills

Good skill names: descriptive, lowercase, hyphenated (e.g., 'docker-debug', 'api-error-handling')
Good skill descriptions: clear about when to use this skill

Output format:
- If no skill needed: briefly explain why not
- If skill should be created/updated: describe what to do with skill_manage
- Always confirm with user before creating/deleting skills`;

/** System prompt for skill review generation */
const SKILL_REVIEW_SYSTEM = `You are a skill review assistant. Your job is to evaluate conversations and determine if any approach should become a reusable skill.

Be conservative — prefer updating existing skills over creating new ones. Only create when there's genuine value in capturing this workflow.
Consider whether the skill would help in future similar situations, not just this one.
Skills should have clear trigger conditions and specific steps, not generic advice.`;

/**
 * Tracks skill-related activity for triggering reviews.
 * Lightweight tracker that counts iterations since last skill action.
 */
export class SkillTracker {
  private iterationsSinceSkill = 0;
  private config: SkillReviewConfig;

  /**
   * Create a new SkillTracker
   * @param config - Optional configuration overrides
   */
  constructor(config: Partial<SkillReviewConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Called when skill_manage is used (create, edit, patch, delete, etc.)
   */
  recordSkillAction(): void {
    this.iterationsSinceSkill = 0;
    logger.debug('Skill action recorded, counter reset');
  }

  /**
   * Called after each message/turn processed.
   */
  recordIteration(): void {
    this.iterationsSinceSkill++;
  }

  /**
   * Check if we should trigger a skill review.
   * @returns True if review should be triggered
   */
  shouldTriggerReview(): boolean {
    return this.iterationsSinceSkill >= this.config.nudgeInterval;
  }

  /**
   * Get current iteration count.
   * @returns Number of iterations since last skill action
   */
  getIterationCount(): number {
    return this.iterationsSinceSkill;
  }

  /**
   * Reset the counter (after a review or skill action).
   */
  reset(): void {
    this.iterationsSinceSkill = 0;
  }

  /**
   * Update configuration.
   * @param config - Configuration overrides
   */
  updateConfig(config: Partial<SkillReviewConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Build a skill review prompt from conversation history.
 * @param recentMessages - Recent conversation messages
 * @returns Formatted prompt for skill review
 */
export function buildSkillReviewPrompt(
  recentMessages: Array<{ role: string; content: string }>
): string {
  const conversationText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n\n');

  return `Recent conversation:\n${conversationText}\n\n${SKILL_REVIEW_PROMPT}`;
}

/**
 * Trigger a skill review asynchronously.
 * Uses the default provider to generate a review suggestion.
 * 
 * @param providers - Provider registry for LLM access
 * @param _skillLoader - Skill loader (for future use)
 * @param recentMessages - Recent conversation messages
 * @returns Review suggestion or null if no skill suggested
 */
export async function triggerSkillReview(
  providers: ProviderRegistry,
  _skillLoader: SkillLoader,
  recentMessages: Array<{ role: string; content: string }>
): Promise<string | null> {
  try {
    const provider = providers.getDefault();
    
    const result = await generateText({
      model: provider.getModelInstance(),
      system: SKILL_REVIEW_SYSTEM,
      messages: [
        ...recentMessages.slice(-10).map(m => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
        })),
        { role: 'user' as const, content: SKILL_REVIEW_PROMPT },
      ],
      maxOutputTokens: 800,
    });

    const review = result.text.trim();
    
    if (review && !review.toLowerCase().includes('no skill needed') && 
        !review.toLowerCase().includes('no new skill')) {
      logger.info({ review: review.slice(0, 200) }, 'Skill review generated suggestion');
      return review;
    }

    logger.debug('Skill review: no new skill suggested');
    return null;
  } catch (err) {
    logger.warn({ err }, 'Skill review generation failed');
    return null;
  }
}

/**
 * Check if a conversation is complex enough to warrant skill review.
 * @param messages - Conversation messages
 * @param minToolCalls - Minimum tool calls to consider complex
 * @returns True if conversation is worth reviewing
 */
export function isConversationWorthReviewing(
  messages: Array<{ role: string; content: string }>,
  minToolCalls = 5
): boolean {
  // Count tool-related patterns in messages
  let toolCallCount = 0;
  for (const msg of messages) {
    // Look for patterns indicating tool usage
    const patterns = [
      /\[Using:\s*\w+/g,           // [Using: toolname]
      /tool.*call/i,               // tool call patterns
      /executes?|running|calling/i, // execution language
    ];
    
    for (const pattern of patterns) {
      const matches = msg.content.match(pattern);
      if (matches) {
        toolCallCount += matches.length;
      }
    }
  }

  return toolCallCount >= minToolCalls;
}

/**
 * Generate a good skill name from task description.
 * @param task - Task description
 * @returns Suggested skill name
 */
export function suggestSkillName(task: string): string {
  // Convert to lowercase, replace spaces with hyphens
  let name = task.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);

  // Remove common words
  const stopWords = ['how', 'to', 'the', 'a', 'an', 'for', 'and', 'with'];
  name = name
    .split('-')
    .filter(w => !stopWords.includes(w))
    .join('-');

  return name || 'unnamed-skill';
}

/**
 * Generate a skill description from task context.
 * @param context - Task context
 * @returns Suggested skill description
 */
export function suggestSkillDescription(context: string): string {
  // Extract first meaningful sentence or phrase
  const sentences = context.split(/[.!?]/);
  const firstMeaningful = sentences.find(s => s.trim().length > 20);
  
  if (firstMeaningful) {
    return firstMeaningful.trim().slice(0, 200);
  }
  
  return context.slice(0, 200);
}