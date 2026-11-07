import { randomUUID } from 'node:crypto';

/**
 * One research run, watched from the outside: every search and every page
 * Mercury tried to read, and how each went. The owner sees this live
 * (phase, counts, which sources failed and why), the report ends with what
 * it couldn't cover, and a run cut short (a stop, the step budget, a
 * provider failure) still becomes a report written from what was read.
 *
 * Nothing here talks to a model or a channel; the agent feeds it tool steps
 * and reads snapshots.
 */

export type ResearchPhase = 'planning' | 'searching' | 'reading' | 'writing';
export type ResearchOutcome = 'done' | 'partial' | 'stopped' | 'failed' | 'cancelled';

export interface ResearchSource {
  url: string;
  domain: string;
  title?: string;
  status: 'read' | 'failed';
  /** Why it couldn't be read, in plain words ("blocked (HTTP 403)"). */
  reason?: string;
  /** The report links to it. */
  cited?: boolean;
  at: number;
}

export interface ResearchSearch {
  query: string;
  results: number;
  ok: boolean;
  reason?: string;
  at: number;
}

/** What screens get: the run as it stands. */
export interface ResearchSnapshot {
  runId: string;
  topic: string;
  state: 'running' | ResearchOutcome;
  phase: ResearchPhase;
  questions: string[];
  startedAt: number;
  endedAt?: number;
  steps: number;
  maxSteps: number;
  searches: number;
  failedSearches: number;
  read: number;
  failed: number;
  cited: number;
  sourceList: ResearchSource[];
  searchList: ResearchSearch[];
  /** Why it ended before a finished article, when it did. */
  cut?: string;
  /** The saved report (an artifact ref), once there is one. */
  report?: { id: string; name: string; path: string; size: number; kind: string; mime: string };
}

const MAX_SOURCES = 120;
const MAX_SEARCHES = 60;
/** Page text kept per source and in total, to write a report from if the run is cut short. */
const NOTE_PER_SOURCE = 4_000;
const NOTES_TOTAL = 80_000;

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.slice(0, 60); }
}

/**
 * Why a fetch_url result is a failure, or null when it's a page. fetch_url
 * reports failures as text ("HTTP 403 Forbidden for …", "… timed out …"),
 * never as an error, so every screen showed them as read.
 */
export function fetchFailure(result: string): string | null {
  const t = result.trim();
  const http = /^HTTP (\d{3})\b/.exec(t);
  if (http) {
    const code = Number(http[1]);
    if (code === 401 || code === 402 || code === 403) return `blocked or behind a login (HTTP ${code})`;
    if (code === 404 || code === 410) return `page not found (HTTP ${code})`;
    if (code === 429) return 'rate-limited (HTTP 429)';
    if (code >= 500) return `the site had an error (HTTP ${code})`;
    return `HTTP ${code}`;
  }
  if (/^Request to .* timed out/i.test(t)) return 'timed out after 30 s';
  if (/^Error fetching /i.test(t)) return t.replace(/^Error fetching \S+:\s*/i, '').slice(0, 120) || 'could not connect';
  if (/^Error:/i.test(t)) return t.replace(/^Error:\s*/i, '').slice(0, 120);
  if (/^(blocked|denied)\b/i.test(t)) return t.slice(0, 120);
  if (t.length < 200 && !/https?:\/\//.test(t)) return 'almost no readable text (needs a browser or a login)';
  return null;
}

/** Is a step summary a failure? The same rules every screen should use. */
export function stepFailure(tool: string, result: string): string | null {
  const t = result.trim();
  if (tool === 'fetch_url' && /^(HTTP [45]\d\d\b|Request to .* timed out|Error fetching )/i.test(t)) return fetchFailure(t);
  if (/^(error|failed|denied|blocked)\b/i.test(t)) return t.replace(/^error:\s*/i, '').slice(0, 160);
  return null;
}

function titleFromPage(text: string): string | undefined {
  const h = /^#\s+(.+)$/m.exec(text) ?? /<title>([^<]{3,160})<\/title>/i.exec(text);
  return h ? h[1].trim().slice(0, 140) : undefined;
}

export class ResearchRun {
  readonly id = randomUUID().slice(0, 12);
  readonly startedAt = Date.now();
  phase: ResearchPhase = 'searching';
  questions: string[] = [];
  steps = 0;
  /** The owner asked to stop searching and write the report now. */
  finishRequested = false;
  /** This run made (or was given) the plan checklist, so its end may close it. */
  planned = false;
  outcome: 'running' | ResearchOutcome = 'running';
  endedAt?: number;
  cut?: string;
  report?: ResearchSnapshot['report'];
  private sources = new Map<string, ResearchSource>();
  private searchList: ResearchSearch[] = [];
  private notes = new Map<string, string>();
  private notesSize = 0;
  /** A markdown article the model saved to a file during the run (some do, despite being asked not to). */
  writtenArticle?: { path: string; content: string };

  constructor(
    readonly topic: string,
    readonly sessionId: string,
    readonly maxSteps: number,
    readonly planFirst = false,
  ) {
    if (planFirst) this.phase = 'planning';
  }

  /** One finished tool call. */
  observe(tool: string, input: unknown, result: unknown): void {
    this.steps++;
    const args = (input ?? {}) as Record<string, unknown>;
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    if (tool === 'update_plan') {
      this.planned = true;
      return;
    }
    if (tool === 'web_search') {
      this.phase = 'searching';
      const query = typeof args.query === 'string' ? args.query : '';
      const failed = /^Error:/i.test(text.trim());
      const results = failed ? 0 : new Set(text.match(/https?:\/\/[^\s)\]>"']+/g) ?? []).size;
      const reason = failed ? text.replace(/^Error:\s*(web search found nothing:\s*)?/i, '').split('. Tell the owner')[0].slice(0, 200) : undefined;
      this.searchList.push({ query: query.slice(0, 200), results, ok: !failed, ...(reason ? { reason } : {}), at: Date.now() });
      if (this.searchList.length > MAX_SEARCHES) this.searchList.shift();
      return;
    }
    if ((tool === 'write_file' || tool === 'create_file') && typeof args.path === 'string' && /\.(md|markdown)$/i.test(args.path)) {
      const content = typeof args.content === 'string' ? args.content : '';
      if (content.length > 800 && !/^(Error|⚠)/.test(text.trim()) && content.length > (this.writtenArticle?.content.length ?? 0)) {
        this.writtenArticle = { path: args.path, content };
      }
      return;
    }
    if (tool === 'fetch_url') {
      this.phase = 'reading';
      const url = typeof args.url === 'string' ? args.url : '';
      if (!url) return;
      const reason = fetchFailure(text);
      const prev = this.sources.get(url);
      // A page read once stays read; a retry that worked replaces a failure.
      if (prev?.status === 'read' && reason) return;
      this.sources.set(url, {
        url, domain: domainOf(url), status: reason ? 'failed' : 'read',
        ...(reason ? { reason } : { title: titleFromPage(text) }), at: Date.now(),
      });
      if (this.sources.size > MAX_SOURCES) this.sources.delete(this.sources.keys().next().value as string);
      if (!reason) this.keepNote(url, text);
    }
  }

  private keepNote(url: string, text: string): void {
    if (this.notesSize >= NOTES_TOTAL || this.notes.has(url)) return;
    const note = text.slice(0, Math.min(NOTE_PER_SOURCE, NOTES_TOTAL - this.notesSize));
    this.notes.set(url, note);
    this.notesSize += note.length;
  }

  /** The model started writing the answer. */
  writing(): void {
    this.phase = 'writing';
  }

  setQuestions(questions: string[]): void {
    this.questions = questions.map((q) => q.trim()).filter(Boolean).slice(0, 8);
  }

  readCount(): number {
    return [...this.sources.values()].filter((s) => s.status === 'read').length;
  }

  failedSources(): ResearchSource[] {
    return [...this.sources.values()].filter((s) => s.status === 'failed');
  }

  failedSearches(): ResearchSearch[] {
    return this.searchList.filter((s) => !s.ok);
  }

  /** Mark the sources the report links to. */
  markCited(report: string): void {
    for (const s of this.sources.values()) {
      if (s.status === 'read' && report.includes(s.url.replace(/[#?].*$/, ''))) s.cited = true;
    }
  }

  /** What was read, for writing a report without the conversation. */
  notesText(): string {
    return [...this.notes.entries()].map(([url, text]) => `### Source: ${url}\n${text}`).join('\n\n');
  }

  end(outcome: ResearchOutcome, cut?: string): void {
    if (this.outcome !== 'running') return;
    this.outcome = outcome;
    this.endedAt = Date.now();
    if (cut) this.cut = cut;
  }

  snapshot(): ResearchSnapshot {
    const list = [...this.sources.values()];
    return {
      runId: this.id,
      topic: this.topic,
      state: this.outcome,
      phase: this.phase,
      questions: this.questions,
      startedAt: this.startedAt,
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      steps: this.steps,
      maxSteps: this.maxSteps,
      searches: this.searchList.length,
      failedSearches: this.failedSearches().length,
      read: list.filter((s) => s.status === 'read').length,
      failed: list.filter((s) => s.status === 'failed').length,
      cited: list.filter((s) => s.cited).length,
      sourceList: list.slice(-80),
      searchList: this.searchList.slice(-30),
      ...(this.cut ? { cut: this.cut } : {}),
      ...(this.report ? { report: this.report } : {}),
    };
  }
}

/**
 * "Coverage & gaps": what the report couldn't cover and why. Always added
 * to a report written after a cut; added to a finished one only when
 * something failed, so a clean report stays clean.
 */
export function coverageSection(run: ResearchRun, opts: { cut?: string; unanswered?: string[] } = {}): string {
  const failed = run.failedSources();
  const failedSearches = run.failedSearches();
  const unanswered = opts.unanswered ?? [];
  if (!opts.cut && failed.length === 0 && failedSearches.length === 0 && unanswered.length === 0) return '';
  const lines: string[] = ['## Coverage & gaps', ''];
  const read = run.readCount();
  if (opts.cut) lines.push(`This report is incomplete: the research stopped early because ${opts.cut}. It is written from the ${read} source${read === 1 ? '' : 's'} read before that.`, '');
  if (unanswered.length) {
    lines.push('**Not covered yet:**');
    for (const q of unanswered.slice(0, 8)) lines.push(`- ${q}`);
    lines.push('');
  }
  if (failed.length) {
    lines.push(`**Sources that couldn't be read (${failed.length}):**`);
    for (const s of failed.slice(0, 20)) lines.push(`- [${s.domain}](${s.url}): ${s.reason ?? 'failed'}`);
    if (failed.length > 20) lines.push(`- …and ${failed.length - 20} more`);
    lines.push('');
  }
  if (failedSearches.length) {
    lines.push(`**Searches that found nothing (${failedSearches.length}):**`);
    for (const s of failedSearches.slice(0, 8)) lines.push(`- “${s.query}”${s.reason ? `: ${s.reason}` : ''}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** The sources list saved with the report file: everything consulted, and how it went. */
export function sourcesAppendix(run: ResearchRun): string {
  const s = run.snapshot();
  if (!s.sourceList.length) return '';
  const lines = ['## All sources consulted', ''];
  for (const src of s.sourceList) {
    const mark = src.status === 'failed' ? `✗ ${src.reason ?? 'failed'}` : src.cited ? '✓ cited' : '· read';
    lines.push(`- ${mark} · [${src.title ?? src.domain}](${src.url})`);
  }
  return lines.join('\n');
}

const WRITING_STEP = /^(synthesi[sz]e|write|compile|draft|summari[sz]e|produce|create|assemble|finali[sz]e)\b/i;

/**
 * The checklist when a run ends. Models tick the research steps as they go
 * but rarely the last one ("Write the report"), so a finished run left the
 * checklist stuck on it. Finished: every step is done. A report written after
 * a cut: the writing step is done, the questions it didn't reach stay open.
 * Stopped or failed: left as it was. Null = nothing to change.
 */
export function closePlan<T extends { label: string; status: 'pending' | 'active' | 'done' }>(steps: T[], outcome: ResearchOutcome | 'running'): T[] | null {
  if (!steps.length) return null;
  let next: T[];
  if (outcome === 'done') next = steps.map((s) => ({ ...s, status: 'done' as const }));
  else if (outcome === 'partial') next = steps.map((s) => (WRITING_STEP.test(s.label.trim()) ? { ...s, status: 'done' as const } : s.status === 'active' ? { ...s, status: 'pending' as const } : s));
  else return null;
  return next.some((s, i) => s.status !== steps[i].status) ? next : null;
}

/** Plan steps the model hasn't marked done: what the report doesn't cover yet. */
export function unansweredFrom(plan: Array<{ label: string; status: string }> | undefined): string[] {
  // "Write the report" steps are the writing, not a question the report misses.
  return (plan ?? []).filter((s) => s.status !== 'done' && !WRITING_STEP.test(s.label.trim())).map((s) => s.label);
}

/**
 * The report to keep: the article itself. A reply usually is the article;
 * some models save it to a file and reply with a summary, and a reply can
 * open with the narration of earlier steps ("Let me search…"), which the
 * file doesn't need.
 */
export function reportBody(reply: string, written?: { content: string }): string {
  const fromHeading = (t: string): string => {
    const at = t.search(/^#\s+\S/m);
    return at > 0 ? t.slice(at) : t;
  };
  const body = fromHeading(reply.trim());
  if (written && written.content.trim().length > body.length * 1.5) return fromHeading(written.content.trim());
  return body;
}

export function reportFileName(topic: string, at = Date.now()): string {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const slug = topic.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 50).replace(/-$/, '') || 'research';
  return `${stamp}-${slug}.md`;
}

/** The sub-questions a plan-first run proposes, from the model's lines. */
export function parsePlanLines(text: string): string[] {
  return text.split('\n')
    // Headings and preambles ("# Sub-questions for …", "Here is the plan:") aren't questions.
    .filter((l) => !/^\s*#/.test(l) && !/:\s*$/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').trim())
    .filter((l) => l.length >= 6 && l.length <= 200)
    .slice(0, 7);
}

export const RESEARCH_PLAN_SYSTEM = `You plan a research report. Given the owner's question, write 3 to 6 sub-questions that together answer it fully, one per line, no numbering, no preamble. Each is short and specific, and checkable against sources on the web.`;

export const RESEARCH_WRITE_SYSTEM = `You write a research report from source notes. Use ONLY what the notes say; never add facts from memory. Rich markdown: a "# Title", a short TL;DR, "##" sections, inline links to the sources ("[according to …](url)"), and a "## Sources" list at the end. Where the notes don't cover something, say so plainly instead of guessing.`;
