/**
 * System prompt assembly, extracted from Agent so it can be read and tested
 * on its own. The agent gathers the inputs (identity, skills, bots, modes,
 * budget, memory summary, tool names, GitHub config) and this module turns
 * them into the prompt text. Everything here is the STABLE prefix of a turn;
 * per-turn context (retrieved memory, loop warnings) goes into the volatile
 * system block built in Agent.handleMessage.
 */

export interface SystemPromptInputs {
  /** Soul + guardrails + persona, from Identity.getSystemPrompt(). */
  identityPrompt: string;
  /** Installed skill summaries, from CapabilityRegistry.getSkillContext(). */
  skillContext: string;
  /** Mercury Bots roster section, or '' when bots are not enabled. */
  botSection: string;
  programmingSuffix: string;
  researchSuffix: string;
  budgetStatus: string;
  budgetUsagePercentage: number;
  saverSuffix: string;
  cwd: string;
  now: Date;
  platform: string;
  timezone: string;
  /** Second Brain summary, or null when Second Brain is disabled. */
  memorySummary: { total: number; learningPaused: boolean } | null;
  toolNames: readonly string[];
  github: { defaultOwner?: string; defaultRepo?: string; username?: string };
}

export const GITHUB_TOOL_NAMES = ['create_pr', 'review_pr', 'list_issues', 'create_issue', 'github_api'] as const;

export const TOOL_USAGE_GUIDELINES = `**Tool Usage Guidelines:**
- Use write_file, create_file, and edit_file tools DIRECTLY to create and modify files. Do NOT create intermediary scripts (Python, bash, Node.js) whose sole purpose is to generate other files — you have native file tools for this.
- Use run_command for: building, testing, installing dependencies, running the project, git operations, and other system tasks that require a shell.
- Do NOT use run_command with echo/cat/tee/heredoc to write files. Use write_file or create_file instead.
- Do NOT create one-time-use helper scripts. If the user asks you to create a file, create it directly with create_file or write_file.
- When creating multiple files, call create_file or write_file for each one individually. Do not batch them into a script.`;

/** Date at day resolution and time at hour resolution: the prompt is cached as a prefix. */
export function environmentSection(now: Date, timezone: string, platform: string, cwd: string): string {
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone });
  // Hour resolution on purpose: a minute-precise clock changed the system
  // prompt every turn and defeated prompt caching for the ~10K-token
  // prefix that follows. Tools report exact timestamps when it matters.
  const timeStr = `about ${now.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: timezone })}`;
  return `Environment:\n- Date: ${dateStr}, ${timeStr} (${timezone})\n- Platform: ${platform}\n- Working directory: ${cwd}`;
}

export function memorySection(summary: SystemPromptInputs['memorySummary']): string {
  if (!summary) return 'Second Brain is DISABLED. Basic long-term memory (text search over facts) is still active.';
  let text = `Second Brain (SQLite-backed long-term memory) is ENABLED. You have ${summary.total} persistent memories about this user.`;
  text += `\nMemory types: identity, preference, goal, project, habit, decision, constraint, relationship, episode, reflection.`;
  text += `\n\nCRITICAL — Memory storage rules:`;
  text += `\n- ALL persistent user knowledge lives in the Second Brain SQLite database — this is the single source of truth.`;
  text += `\n- NEVER use create_file, write_file, edit_file, or any file tool to store memories, notes, facts, preferences, or brain data. Files are for code and documents, not for knowledge storage.`;
  text += `\n- New memories are extracted AUTOMATICALLY after each conversation turn. You do not need to ask the user if they want to save something.`;
  text += `\n- When the user explicitly asks you to "save/remember/note/keep this," use the save_memory tool to store it directly — no follow-up questions needed.`;
  text += `\n- When you need to actively recall something beyond auto-injected context (e.g. "do you remember...", "what do I know about..."), use the search_memory tool.`;
  text += `\n- Relevant memories are auto-injected before each message. You can reference them naturally (e.g. "I remember you prefer TypeScript").`;
  text += `\n- Users can manage memory with: /memory (overview, search, pause learning, clear).`;
  if (summary.learningPaused) {
    text += `\n\nLearning is currently PAUSED — no new memories will be extracted or saved until resumed.`;
  }
  return text;
}

export function tweetNotifierSection(skillContext: string): string {
  if (!skillContext.includes('tweet-notifier')) return '';
  return `**Tweet Notification System Available** — The tweet-notifier skill is installed.
When you need to schedule tweets, manage approvals, or notify founders/supporters:
1. Use the \`use_skill\` tool to invoke the \`tweet-notifier\` skill for detailed instructions
2. The skill provides templates for scheduling tweets, notifying founders (via send_message), and alerting supporters (approved Telegram users)
3. Key tools used by this system: schedule_task (for timing), send_message (for notifications to Telegram), save_memory (for tweet state tracking), search_memory (for checking existing tweets)
4. Supporters are all approved Telegram users — send_message will reach them
5. The founder (Optimus Prime) receives notifications via send_message (Telegram)`;
}

export function githubSection(toolNames: readonly string[], github: SystemPromptInputs['github']): string {
  if (!GITHUB_TOOL_NAMES.some((t) => toolNames.includes(t))) return '';
  let hint = 'GitHub companion is active.';
  if (github.defaultOwner && github.defaultRepo) {
    hint += ` Default repo: ${github.defaultOwner}/${github.defaultRepo}. Use this when the user doesn't specify a repo.`;
  }
  hint += `

Available GitHub tools and when to use them:
- git_add, git_commit, git_push: LOCAL git operations (stage, commit, push to a remote you have SSH/auth access to). All commits include "Co-authored-by: Mercury <mercury@cosmicstack.org>".
- create_pr: Create a pull request on GitHub. The head branch must already exist on the remote.
- review_pr: Get PR details and optionally post a review comment.
- list_issues, create_issue: Browse and file issues.
- github_api: Raw GitHub API access. IMPORTANT USE CASES:
  - Push files directly to GitHub via PUT /repos/{owner}/{repo}/contents/{path} when git push fails due to auth. The body must include "message" and "content" (base64-encoded file content). This creates a commit on GitHub with Mercury as co-author.
  - Delete files via DELETE /repos/{owner}/{repo}/contents/{path} with a "message" and "sha" in the body.
  - Any other GitHub API operation not covered by the other tools.

When the user asks to "push to GitHub" or "upload files" and git push fails, use github_api with PUT /repos/{owner}/{repo}/contents/{path} to push content directly through the API. This bypasses local git entirely.

Always specify owner and repo parameters on GitHub tools. The user's GitHub username is ${github.username || 'not set'}.'`;
  return hint;
}

/** Assemble the stable system prompt. Section order is part of the cache key; keep it stable. */
export function buildSystemPrompt(i: SystemPromptInputs): string {
  const sections: string[] = [i.identityPrompt];
  if (i.skillContext) sections.push(i.skillContext);
  let prompt = sections.join('\n\n');
  if (i.botSection) prompt += i.botSection;
  if (i.programmingSuffix) prompt += i.programmingSuffix;
  if (i.researchSuffix) prompt += i.researchSuffix;
  prompt += '\n\n' + i.budgetStatus;
  if (i.budgetUsagePercentage > 70) prompt += '\nBe concise to conserve tokens.';
  if (i.saverSuffix) prompt += i.saverSuffix;
  prompt += '\n\n' + environmentSection(i.now, i.timezone, i.platform, i.cwd);
  prompt += '\n\n' + TOOL_USAGE_GUIDELINES;
  prompt += '\n\n' + memorySection(i.memorySummary);
  const tweet = tweetNotifierSection(i.skillContext);
  if (tweet) prompt += '\n\n' + tweet;
  const github = githubSection(i.toolNames, i.github);
  if (github) prompt += '\n\n' + github;
  return prompt;
}
