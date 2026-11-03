import { logger } from '../utils/logger.js';

import { ResearchRun, type ResearchSnapshot } from './research-run.js';

export type ResearchModeState = 'off' | 'on';

/**
 * Research is one run, not a sticky mode. "On" means the next message in the
 * chat that asked (or any chat, when none was named) is researched; when that
 * run ends — finished, cut short, stopped — research is off again, so the
 * follow-up "thanks" isn't a 225-step research pass in every chat.
 */
export class ResearchMode {
  private state: ResearchModeState = 'off';
  private topic: string | null = null;
  /** The chat it was switched on for; null = whichever message comes next. */
  private armedFor: string | null = null;
  private planFirst = false;
  private run: ResearchRun | null = null;
  /** The last run in each chat, for Continue / Retry and screens that open later. */
  private lastRuns = new Map<string, ResearchRun>();

  getState(): ResearchModeState {
    return this.run ? 'on' : this.state;
  }

  isActive(): boolean {
    return this.state === 'on' || this.run !== null;
  }

  setOn(topic?: string, opts: { sessionId?: string; planFirst?: boolean } = {}): void {
    this.state = 'on';
    this.topic = topic || null;
    this.armedFor = opts.sessionId ?? null;
    this.planFirst = !!opts.planFirst;
    logger.info({ topic: this.topic, sessionId: this.armedFor, planFirst: this.planFirst }, 'Research mode: on');
  }

  /** Off for the next message; a run already going finishes (Stop ends it). */
  setOff(): void {
    this.state = 'off';
    this.topic = null;
    this.armedFor = null;
    this.planFirst = false;
    logger.info('Research mode: off');
  }

  toggle(): ResearchModeState {
    if (this.state === 'off') this.setOn();
    else this.setOff();
    logger.info({ state: this.state }, 'Research mode toggled');
    return this.state;
  }

  /** Is research switched on for this chat's next message? */
  armedForSession(sessionId: string): boolean {
    return this.state === 'on' && (this.armedFor === null || this.armedFor === sessionId);
  }

  isPlanFirst(): boolean {
    return this.planFirst;
  }

  /** The message that starts the run arrived: research it. */
  beginRun(sessionId: string, content: string, maxSteps: number): ResearchRun {
    const run = new ResearchRun(this.topic || content.trim().slice(0, 160), sessionId, maxSteps, this.planFirst);
    this.state = 'off';
    this.armedFor = null;
    this.planFirst = false;
    this.run = run;
    this.lastRuns.set(sessionId, run);
    if (this.lastRuns.size > 50) this.lastRuns.delete(this.lastRuns.keys().next().value as string);
    logger.info({ runId: run.id, sessionId, topic: run.topic }, 'Research run started');
    return run;
  }

  currentRun(): ResearchRun | null {
    return this.run;
  }

  /** The run for this chat: the one going, else its last one. */
  runFor(sessionId: string): ResearchRun | null {
    if (this.run?.sessionId === sessionId) return this.run;
    return this.lastRuns.get(sessionId) ?? null;
  }

  /** What a screen opening this chat should show. */
  stateFor(sessionId: string): { armed: boolean; planFirst: boolean; topic: string | null; run: ResearchSnapshot | null } {
    const run = this.runFor(sessionId);
    return { armed: this.armedForSession(sessionId), planFirst: this.planFirst, topic: this.topic, run: run ? run.snapshot() : null };
  }

  /** The run's turn is over (however it ended). Research is off again. */
  endRun(): void {
    if (!this.run) return;
    if (this.run.outcome === 'running') this.run.end('done');
    logger.info({ runId: this.run.id, outcome: this.run.outcome }, 'Research run ended');
    this.run = null;
    this.topic = null;
  }

  setTopic(topic: string): void {
    this.topic = topic;
  }

  getTopic(): string | null {
    return this.run?.topic ?? this.topic;
  }

  getStatusText(): string {
    if (this.run) return `Research: running | Topic: ${this.run.topic}`;
    if (this.state === 'off') return 'Research mode: Off';
    let text = 'Research mode: On (for your next message)';
    if (this.topic) text += ` | Topic: ${this.topic}`;
    return text;
  }

  /**
   * Multiplier applied to the per-task tool-call cap while a research run is going.
   * Research requires many fetch/search iterations; keep the hard cap but raise it.
   */
  getMaxStepsMultiplier(): number {
    return this.run ? 3 : 1;
  }

  /**
   * Multiplier applied to the foreground stall timeout while a research run is going.
   * Research tasks run long by design; do not abort them as stalled.
   */
  getStallMsMultiplier(): number {
    return this.run ? 4 : 1;
  }

  getSystemPromptSuffix(): string {
    if (!this.run) return '';

    let suffix = '\n\n**RESEARCH MODE IS ACTIVE**';

    suffix += '\nMode: RESEARCH';
    suffix += '\nYou are performing deep research for the user. Your job is to produce a thorough, well-structured research article, not a quick chat answer.';
    suffix += '\n\nResearch workflow:';
    suffix += this.run.questions.length
      ? `\n1. The owner approved this plan. Call update_plan once with exactly these steps, then mark each one active and done as you cover it:\n${this.run.questions.map((q, i) => `   ${i + 1}. ${q}`).join('\n')}`
      : '\n1. Break the question into 3-6 sub-questions. Call update_plan with them as steps, and mark each one active and done as you cover it — the owner watches that list.';
    suffix += '\n2. ALWAYS use web_search and fetch_url to gather real, current information from the web. Do not rely on memory or prior knowledge for facts, dates, or news — verify everything live.';
    suffix += '\n3. Build a visual plan while researching. Actively inspect source pages for relevant photos, diagrams, charts, maps, or infographics and preserve their original direct image URLs.';
    suffix += '\n4. Cross-check claims across multiple sources. Prefer primary sources, official statements, and reputable outlets.';
    suffix += '\n5. Take as many tool steps as the research genuinely requires — do not stop early. Long-running research is expected and will not be killed.';
    suffix += '\n6. After gathering sources, synthesize a single comprehensive research article in rich markdown.';
    suffix += '\n\nOutput format — produce ONE research article as rich markdown:';
    suffix += '\n- Start with a `# Title` reflecting the research question.';
    suffix += '\n- Include a short TL;DR summary near the top.';
    suffix += '\n- Use `##` section headings for sub-topics.';
    suffix += '\n- Cite sources inline as markdown links, e.g. "[according to NOAA](https://...)".';
    suffix += '\n- Include 2-4 editorially relevant images when credible sources provide them: one strong lead image near the top and additional visuals beside the sections they support.';
    suffix += '\n- Embed images as `![specific descriptive alt text](https://direct-image-url)` using the original public image URL, not a webpage URL, search-result thumbnail, local file, or invented URL.';
    suffix += '\n- Prefer informative visuals over decoration. Do not repeat an image, and omit only when diligent source review finds no safe, relevant public image.';
    suffix += '\n- Include a `## Sources` section at the end listing all URLs consulted.';
    suffix += '\n- Write the whole article in your final reply, not in a file: Mercury saves your reply as the report file itself. Do not create or write a file for it, and do not reply with only a summary.';
    suffix += '\n- Between tool calls, say nothing (no "Let me search…"); the owner sees each step live.';
    suffix += '\n- When a source fails (blocked, timed out, not found), try another source for the same point; do not retry the same URL more than once. Mercury lists failed sources for the owner itself, so do not add your own list of them.';
    suffix += '\n\nIf the conversation already holds an earlier report on this topic, build on it: keep what it established and extend or correct it.';

    suffix += `\n\nResearch topic: ${this.run.topic}`;

    return suffix;
  }
}
