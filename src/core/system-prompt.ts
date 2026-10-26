/**
 * System prompt assembly, extracted from Agent so it can be read and tested
 * on its own. The agent gathers the inputs (identity, skills, bots, modes,
 * budget, memory summary, tool names, GitHub config) and this module turns
 * them into the prompt text. Everything here is the STABLE prefix of a turn;
 * per-turn context (retrieved memory, loop warnings) goes into the volatile
 * system block built in Agent.handleMessage — the token budget included,
 * since it changes on every turn.
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
  saverSuffix: string;
  cwd: string;
  now: Date;
  platform: string;
  timezone: string;
  /** Second Brain summary, or null when Second Brain is disabled. */
  memorySummary: { total: number; learningPaused: boolean } | null;
  /**
   * The owner brief (ADR-026): "About {owner}" and "How to work with {owner}",
   * built from the belief store and regenerated only when beliefs change so
   * the cached prefix holds. Null/undefined when nothing is held yet.
   */
  ownerSections?: { about: string; howToWork: string } | null;
  /** The owner's name for the brief headings; defaults to "the owner". */
  ownerName?: string;
  toolNames: readonly string[];
  github: { defaultOwner?: string; defaultRepo?: string; username?: string };
}

export const GITHUB_TOOL_NAMES = ['create_pr', 'review_pr', 'list_issues', 'create_issue', 'github_api'] as const;

export const TOOL_USAGE_GUIDELINES = `**Tool Usage Guidelines:**
- Create or change a single file with write_file, create_file or edit_file. Never write a file through run_command with echo/cat/tee/heredoc, and never write a generator script just to emit one file you could write directly.
- Use run_command for building, testing, installing dependencies, running the project, git, and for real work on data: converting formats, processing many files, extracting, transforming, downloading.
- Pick the strongest tool for the job before doing anything by hand. For conversions and bulk work (EPUB/PDF/DOCX/HTML to Markdown, images, audio/video, CSV/JSON, renaming or reorganising many files) use an established CLI or library — pandoc, ffmpeg, ImageMagick, jq, a Python package such as ebooklib, markdownify or pypdf — through run_command, or one short script that handles every file in one run. Never read and rewrite many files one by one yourself.
- Not sure what the best tool is? Spend one web_search finding out. Check it is installed (e.g. \`command -v pandoc\`, \`python3 -c "import ebooklib"\`) and install it or fall back to the next best option.
- After a bulk or conversion step, check the output (count the files, open a sample) before saying it is done.`;

/**
 * How to work in plain chat (programming mode off). Mercury Code has its
 * own contract (programming-mode.ts); without this, chat answered tasks as
 * a narrator: no plan, the slowest tool, and no check of the result.
 * Stable text: it is part of the cached prompt prefix.
 */
export const CHAT_WORK_CONTRACT = `**How you work:**
- When the user asks for something to be done, do it with your tools; don't describe how they could do it.
- First work out the end result they want, then the fastest reliable way to get there (an existing command, library or service beats manual steps).
- For tasks with several steps, keep a short plan with update_plan and work through it.
- Report what you did and what you checked, briefly. If something failed or you could not confirm it, say so plainly.
- Need the user to decide before you go on — yes or no, or which of a few options? Ask with ask_user, so they pick with the arrow keys instead of typing an answer. Only a question that needs free text (a name, a path, a date) is asked in words.
- Plain questions and conversation don't need tools: just answer.`;

/**
 * Self-made skills (ADR-027): shown only when create_skill is available, i.e.
 * in the owner's own interactive sessions, never for bots or members.
 */
export const SELF_MADE_SKILLS_GUIDE = `**Skills you make yourself:**
- Before a task with many steps, check the skills list for one that fits and use it.
- If none fits and you would do the same procedure again for other inputs (a recurring report, a conversion pipeline, a deploy, a site or device you operate), plan it as a procedure first: inputs, steps, checks. Do the task. Once it actually worked, save the procedure with create_skill — exact commands, tools, paths, the pitfalls you hit — and tell the owner in one line.
- Never make a skill for a one-off, for something one tool call does, for anything you did not verify end-to-end, or with credentials inside. Improve an existing self-made skill (same name) rather than adding a near-duplicate.
- Self-made skills are listed under "Self-made" and count as unverified until used again: follow them, but trust the result, not the text, and fix the skill when a step fails.`;

export function selfMadeSkillsSection(toolNames: readonly string[]): string {
  return toolNames.includes('create_skill') ? SELF_MADE_SKILLS_GUIDE : '';
}

/**
 * Token budget line for the per-turn (volatile) system block. It changes on
 * every turn, so it must never sit in the stable prompt: there it broke the
 * provider's prefix cache for the tool schemas and everything after it,
 * and the whole ~12K-token prompt was re-read on every request.
 */
export function budgetContext(statusText: string, usagePercentage: number): string {
  return usagePercentage > 70 ? `${statusText}\nBe concise to conserve tokens.` : statusText;
}

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

/**
 * What Mercury believes about its owner and how to work with them, right
 * after the identity so it reads as part of who Mercury is. Empty when there
 * is nothing held: a bare heading would only invite the model to invent.
 */
export function ownerSection(sections: SystemPromptInputs['ownerSections'], ownerName = 'the owner'): string {
  if (!sections) return '';
  const about = sections.about.trim();
  const how = sections.howToWork.trim();
  if (!about && !how) return '';
  const name = ownerName.trim() || 'the owner';
  const parts: string[] = [];
  if (about) parts.push(`## About ${name}\n\nWhat you know about ${name} from past conversations (stated facts are plain; "seems" marks what you inferred and have not confirmed):\n${about}`);
  if (how) parts.push(`## How to work with ${name}\n\nLearned from how ${name} works with you; follow these unless ${name} says otherwise in the moment:\n${how}`);
  return parts.join('\n\n');
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
  const owner = ownerSection(i.ownerSections, i.ownerName);
  if (owner) sections.push(owner);
  if (i.skillContext) sections.push(i.skillContext);
  let prompt = sections.join('\n\n');
  if (i.botSection) prompt += i.botSection;
  if (i.programmingSuffix) prompt += i.programmingSuffix;
  else prompt += '\n\n' + CHAT_WORK_CONTRACT;
  if (i.researchSuffix) prompt += i.researchSuffix;
  if (i.saverSuffix) prompt += i.saverSuffix;
  prompt += '\n\n' + environmentSection(i.now, i.timezone, i.platform, i.cwd);
  prompt += '\n\n' + TOOL_USAGE_GUIDELINES;
  const selfMade = selfMadeSkillsSection(i.toolNames);
  if (selfMade) prompt += '\n\n' + selfMade;
  prompt += '\n\n' + memorySection(i.memorySummary);
  const tweet = tweetNotifierSection(i.skillContext);
  if (tweet) prompt += '\n\n' + tweet;
  const github = githubSection(i.toolNames, i.github);
  if (github) prompt += '\n\n' + github;
  return prompt;
}
