import { logger } from '../utils/logger.js';

export type ResearchModeState = 'off' | 'on';

export class ResearchMode {
  private state: ResearchModeState = 'off';
  private topic: string | null = null;

  getState(): ResearchModeState {
    return this.state;
  }

  isActive(): boolean {
    return this.state === 'on';
  }

  setOn(topic?: string): void {
    this.state = 'on';
    this.topic = topic || null;
    logger.info({ topic: this.topic }, 'Research mode: on');
  }

  setOff(): void {
    this.state = 'off';
    this.topic = null;
    logger.info('Research mode: off');
  }

  toggle(): ResearchModeState {
    if (this.state === 'off') {
      this.state = 'on';
    } else {
      this.state = 'off';
      this.topic = null;
    }
    logger.info({ state: this.state }, 'Research mode toggled');
    return this.state;
  }

  setTopic(topic: string): void {
    this.topic = topic;
  }

  getTopic(): string | null {
    return this.topic;
  }

  getStatusText(): string {
    if (this.state === 'off') return 'Research mode: Off';
    let text = 'Research mode: On';
    if (this.topic) text += ` | Topic: ${this.topic}`;
    return text;
  }

  /**
   * Multiplier applied to the per-task tool-call cap while research mode is active.
   * Research requires many fetch/search iterations; keep the hard cap but raise it.
   */
  getMaxStepsMultiplier(): number {
    return this.state === 'on' ? 3 : 1;
  }

  /**
   * Multiplier applied to the foreground stall timeout while research mode is active.
   * Research tasks run long by design; do not abort them as stalled.
   */
  getStallMsMultiplier(): number {
    return this.state === 'on' ? 4 : 1;
  }

  getSystemPromptSuffix(): string {
    if (this.state === 'off') return '';

    let suffix = '\n\n**RESEARCH MODE IS ACTIVE**';

    suffix += '\nMode: RESEARCH';
    suffix += '\nYou are performing deep research for the user. Your job is to produce a thorough, well-structured research article, not a quick chat answer.';
    suffix += '\n\nResearch workflow:';
    suffix += '\n1. Break the question into sub-questions and plan which sources to consult.';
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
    suffix += '\n- The final markdown is treated as the research artifact and will be rendered as a full article on Mercury Cloud.';
    suffix += '\n\nIf the user asks a follow-up in the same thread, treat it as a refinement of this research: reuse the context, gather more if needed, and update or extend the article accordingly. If something is unclear, ask a short clarifying question before spending a long research pass.';

    if (this.topic) {
      suffix += `\n\nResearch topic: ${this.topic}`;
    }

    return suffix;
  }
}
