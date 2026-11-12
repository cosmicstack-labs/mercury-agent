/**
 * What the owner might want next: suggestions for a new chat.
 *
 * A new chat used to open on the same line for everyone. This keeps a small
 * pool of suggestions made from what Mercury already knows about the owner:
 *  - their profile (the reflection's brief), current goals and situations;
 *  - recent chats, and what was last asked in them;
 *  - scheduled tasks and recent artifacts;
 *  - the time of day and the day of the week.
 *
 * Lightweight by design:
 *  - The pool is refreshed at most every few hours (REFRESH_MS), and only
 *    when the owner was active since the last refresh. It takes one small
 *    call on the learning provider, from the heartbeat or lazily after a
 *    request — never on the request path.
 *  - Without a model (no budget, learning paused, a failed call) the pool
 *    comes from rules over the same signals, at no cost.
 *  - Not repetitive: each request takes the least recently shown items, so
 *    consecutive new chats show different ones. A used suggestion leaves the
 *    pool, and recent titles are passed to the model so it doesn't repeat them.
 *
 * The suggestions are only shown. Nothing runs until the owner picks one
 * and sends it, and the text they send is the prompt they saw.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseJsonLenient } from './json.js';
import { looksLikeSecret } from './text.js';
import { scanForInjection } from '../security/injection-scan.js';
import { logger } from '../utils/logger.js';

export type SuggestionKind = 'continue' | 'create' | 'plan' | 'check' | 'learn' | 'explore';
const KINDS = new Set<SuggestionKind>(['continue', 'create', 'plan', 'check', 'learn', 'explore']);

export interface Suggestion {
  id: string;
  /** A few words on the card: "Pick up the security review". */
  title: string;
  /** What is sent when picked, in the owner's voice. */
  prompt: string;
  /** Why it's suggested: "You were on this yesterday". */
  why?: string;
  kind: SuggestionKind;
  source: 'model' | 'rule';
  shown: number;
  lastShownAt?: number;
}

export interface SuggestionContext {
  ownerName: string;
  now: number;
  /** The reflection's brief: who the owner is. */
  about?: string;
  /** Live goals, projects and situations, as statements. */
  current: string[];
  /** Recent chats, newest first. */
  recent: Array<{ title: string; updatedAt: number; lastAsk?: string }>;
  schedules: string[];
  artifacts: string[];
  /** When the owner last did something (newest chat activity). */
  lastActivity: number;
}

interface State {
  generatedAt: number;
  /** The owner's activity the pool was made from: refresh only after newer activity. */
  basedOn: number;
  source: 'model' | 'rule';
  subtitle?: string;
  items: Suggestion[];
  /** Titles suggested or used lately, normalized: not suggested again soon. */
  history: string[];
}

export const REFRESH_MS = 6 * 3_600_000;
const POOL = 10;
const HISTORY = 60;
const MAX_TOKENS = 1200;

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function ago(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Titles that say nothing about the chat. */
const BLAND = /^(new chat|untitled|chat|hello|hi|hey|test|voice call.*)$/i;

/** Suggestions from rules over the same signals: no model, no cost. */
export function ruleSuggestions(ctx: SuggestionContext): Array<Omit<Suggestion, 'id' | 'shown'>> {
  const out: Array<Omit<Suggestion, 'id' | 'shown'>> = [];
  const d = new Date(ctx.now);
  const hour = d.getHours();
  const day = d.getDay();

  for (const r of ctx.recent.filter((x) => !BLAND.test(x.title.trim()) && ctx.now - x.updatedAt < 14 * 86_400_000).slice(0, 3)) {
    out.push({
      title: clip(`Pick up “${r.title}”`, 60),
      prompt: `Let's pick up our chat “${r.title}”. Where did we leave it, and what's the next step?`,
      why: `You were on this ${ago(ctx.now - r.updatedAt)}`,
      kind: 'continue', source: 'rule',
    });
  }
  for (const g of ctx.current.slice(0, 2)) {
    out.push({ title: clip(`Next step: ${g}`, 60), prompt: `Help me make progress on this: ${g}. What's the most useful next step?`, why: 'Something you’re working towards', kind: 'plan', source: 'rule' });
  }
  if (day === 1 && hour < 14) out.push({ title: 'Plan my week', prompt: 'Help me plan this week: what should I focus on, given what I’m working on?', kind: 'plan', source: 'rule' });
  else if (day === 5 && hour >= 12) out.push({ title: 'Look back on my week', prompt: 'Help me look back on this week: what got done, what’s still open, and what to carry over.', kind: 'check', source: 'rule' });
  else if (hour >= 5 && hour < 12) out.push({ title: 'Plan my day', prompt: 'Help me plan today: what should I focus on first?', kind: 'plan', source: 'rule' });
  else if (hour >= 17) out.push({ title: 'Wrap up my day', prompt: 'Help me wrap up today: what did I get done, and what should I pick up tomorrow?', kind: 'check', source: 'rule' });
  if (ctx.schedules.length) out.push({ title: 'Review my scheduled tasks', prompt: 'List my scheduled tasks and tell me if any look stale or need changing.', why: `${ctx.schedules.length} scheduled`, kind: 'check', source: 'rule' });
  if (ctx.artifacts.length) out.push({ title: 'What did you make for me lately?', prompt: 'Show me what you made for me recently, and what each one was for.', kind: 'check', source: 'rule' });
  out.push(
    { title: 'Teach me something new', prompt: 'Teach me something useful I probably don’t know, related to what I work on. Keep it short.', kind: 'learn', source: 'rule' },
    { title: 'Make an image', prompt: 'Make an image of ', kind: 'create', source: 'rule' },
    { title: 'Research a topic', prompt: 'Research this and give me a short, sourced summary: ', kind: 'explore', source: 'rule' },
  );
  return out;
}

export const SUGGEST_SYSTEM = `You suggest what the owner of a personal AI agent (Mercury) might want to ask it next, shown as cards when they open a new chat.

Rules:
- Specific to this owner: grounded in their recent chats, goals, schedules and work. Nothing generic like "Ask me anything".
- Varied: a mix of continuing something, starting something, planning, checking on something, learning. At most 3 that continue a recent chat.
- "title": at most 48 characters, starts with a verb, plain words.
- "prompt": the full message the owner would send, in their voice (first person), self-contained (it starts a new chat, so name what it refers to). Under 300 characters.
- "why": at most 70 characters, the evidence ("You were on this yesterday", "Your launch is Friday").
- "kind": one of continue, create, plan, check, learn, explore.
- Never repeat or rephrase anything in AVOID.
- No secrets, passwords or private details of other people.
- "subtitle": one short line under the greeting, at most 70 characters, said by the agent to the owner in the first person about what they're up to ("Want to finish the YC deck today?", "I've got your 9am digest covered"). Warm and plain, no name, no exclamation marks.

Output only JSON: {"subtitle": "...", "items": [{"title","prompt","why","kind"}, …]} with ${POOL} items.`;

export function buildSuggestPrompt(ctx: SuggestionContext, avoid: string[]): string {
  const d = new Date(ctx.now);
  const lines = [
    `Owner: ${ctx.ownerName}. Now: ${d.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.`,
    '',
    'ABOUT THE OWNER',
    ctx.about ? clip(ctx.about, 1500) : '(not known yet)',
    '',
    'CURRENT GOALS, PROJECTS AND SITUATIONS',
    ...(ctx.current.length ? ctx.current.map((c) => `- ${clip(c, 160)}`) : ['- none known']),
    '',
    'RECENT CHATS (newest first)',
    ...(ctx.recent.length ? ctx.recent.map((r) => `- "${clip(r.title, 80)}" (${ago(ctx.now - r.updatedAt)})${r.lastAsk ? ` — last asked: ${clip(r.lastAsk.replace(/\s+/g, ' '), 160)}` : ''}`) : ['- none']),
    '',
    'SCHEDULED TASKS',
    ...(ctx.schedules.length ? ctx.schedules.slice(0, 8).map((s) => `- ${clip(s, 100)}`) : ['- none']),
    '',
    'RECENT ARTIFACTS',
    ...(ctx.artifacts.length ? ctx.artifacts.slice(0, 8).map((a) => `- ${a}`) : ['- none']),
    '',
    'AVOID (suggested lately)',
    ...(avoid.length ? avoid.slice(-30).map((a) => `- ${a}`) : ['- nothing']),
  ];
  return lines.join('\n');
}

/** One line under the greeting: whole, never cut mid-word — the first sentence when it runs long, else nothing. */
export function fitLine(text: string, max = 90): string | undefined {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  if (t.length <= max) return t;
  const first = t.match(/^.+?[.?](?=\s|$)/)?.[0];
  return first && first.length <= max ? first : undefined;
}

/** The model's answer, checked: titles and prompts within bounds, nothing secret-looking or instruction-like. */
export function parseSuggestions(text: string): { subtitle?: string; items: Array<Omit<Suggestion, 'id' | 'shown'>> } | null {
  const raw = parseJsonLenient(text) as { subtitle?: unknown; items?: unknown } | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
  const items: Array<Omit<Suggestion, 'id' | 'shown'>> = [];
  for (const r of raw.items as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue;
    const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : '';
    const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
    if (title.length < 3 || title.length > 70 || prompt.length < 5 || prompt.length > 600) continue;
    if (looksLikeSecret(prompt) || scanForInjection(prompt).suspicious) continue;
    const kind = typeof r.kind === 'string' && KINDS.has(r.kind as SuggestionKind) ? (r.kind as SuggestionKind) : 'explore';
    const why = typeof r.why === 'string' && r.why.trim() ? clip(r.why.trim(), 80) : undefined;
    items.push({ title, prompt, kind, source: 'model', ...(why ? { why } : {}) });
    if (items.length >= POOL) break;
  }
  if (!items.length) return null;
  const subtitle = typeof raw.subtitle === 'string' ? fitLine(raw.subtitle) : undefined;
  return { items, ...(subtitle ? { subtitle } : {}) };
}

export interface SuggestionDeps {
  /** Where the pool is kept (~/.mercury/suggestions.json). */
  file: string;
  gather: () => SuggestionContext;
  /** The owner's name, for the greeting (cheap: read on every pick). */
  ownerName: () => string;
  /** One model call, or null when the model may not be used now (budget, learning paused). */
  generate: (() => ((system: string, prompt: string, maxOutputTokens: number) => Promise<string>) | null);
}

export interface SuggestionPick {
  greeting: string;
  subtitle?: string;
  items: Array<Pick<Suggestion, 'id' | 'title' | 'prompt' | 'why' | 'kind'>>;
  generatedAt: number;
}

function greetingFor(name: string, now: number): string {
  const h = new Date(now).getHours();
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = name.trim().split(/\s+/)[0];
  return first && first !== 'the' ? `${part}, ${first}` : part;
}

export class SuggestionEngine {
  private state: State | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: SuggestionDeps) {}

  private load(): State {
    if (this.state) return this.state;
    try {
      if (existsSync(this.deps.file)) {
        const s = JSON.parse(readFileSync(this.deps.file, 'utf-8')) as State;
        if (Array.isArray(s.items)) return (this.state = { ...s, history: Array.isArray(s.history) ? s.history : [] });
      }
    } catch (err) {
      logger.debug({ err }, 'Suggestions file unreadable; starting over');
    }
    return (this.state = { generatedAt: 0, basedOn: 0, source: 'rule', items: [], history: [] });
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.load()), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tmp, this.deps.file);
    } catch (err) {
      logger.debug({ err }, 'Suggestions not saved');
    }
  }

  private fill(items: Array<Omit<Suggestion, 'id' | 'shown'>>, recentTitles: Set<string>): Suggestion[] {
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (const i of items) {
      const key = norm(i.title);
      if (seen.has(key) || recentTitles.has(key)) continue;
      seen.add(key);
      out.push({ ...i, id: randomUUID().slice(0, 12), shown: 0 });
    }
    return out;
  }

  /** Due for a refresh: never made, made from a model too long ago with the owner active since, or nearly used up. */
  shouldRefresh(now = Date.now(), lastActivity?: number): boolean {
    const s = this.load();
    if (!s.generatedAt || s.items.length < 4) return true;
    if (now - s.generatedAt < REFRESH_MS) return s.source === 'rule' && now - s.generatedAt > 30 * 60_000 && (lastActivity ?? 0) > s.basedOn;
    return (lastActivity ?? Infinity) > s.basedOn;
  }

  /** Remake the pool: the model when it may be used, else rules. Once at a time. */
  refresh(now = Date.now()): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh(now).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doRefresh(now: number): Promise<void> {
    const ctx = this.deps.gather();
    const s = this.load();
    const history = new Set(s.history);
    const generate = this.deps.generate();
    let made: ReturnType<typeof parseSuggestions> = null;
    if (generate) {
      try {
        made = parseSuggestions(await generate(SUGGEST_SYSTEM, buildSuggestPrompt(ctx, s.history), MAX_TOKENS));
        if (!made) logger.debug('Suggestions: model answer unusable; using rules');
      } catch (err) {
        logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Suggestions: model call failed; using rules');
      }
    }
    // The model's, topped up with rules (so there are always enough); recent titles left out.
    const fromRules = ruleSuggestions(ctx);
    let items = this.fill([...(made?.items ?? []), ...fromRules], history);
    // Rules that keep coming back (they're few) are still better than an empty screen.
    if (items.length < 4) items = this.fill([...(made?.items ?? []), ...fromRules], new Set());
    this.state = {
      generatedAt: now,
      basedOn: ctx.lastActivity,
      source: made ? 'model' : 'rule',
      ...(made?.subtitle ? { subtitle: made.subtitle } : {}),
      items: items.slice(0, POOL + 3),
      history: s.history,
    };
    this.save();
    logger.info({ source: this.state.source, items: this.state.items.length }, 'Suggestions refreshed');
  }

  /**
   * `n` suggestions for a new chat: the least recently shown first, so each
   * new chat shows different ones. Marks them shown and remembers their
   * titles so the next refresh doesn't make them again.
   */
  pick(n = 4, now = Date.now()): SuggestionPick {
    const s = this.load();
    if (!s.items.length) {
      // First run: rules now, at no cost; the heartbeat (or the caller) refreshes properly.
      const ctx = this.deps.gather();
      s.items = this.fill(ruleSuggestions(ctx), new Set());
      s.source = 'rule';
    }
    const ranked = [...s.items].sort((a, b) => (a.lastShownAt ?? 0) - (b.lastShownAt ?? 0) || a.shown - b.shown || (a.source === b.source ? 0 : a.source === 'model' ? -1 : 1));
    const chosen = ranked.slice(0, Math.max(1, Math.min(n, 8)));
    for (const c of chosen) {
      c.shown++;
      c.lastShownAt = now;
      const key = norm(c.title);
      if (!s.history.includes(key)) s.history.push(key);
    }
    if (s.history.length > HISTORY) s.history = s.history.slice(-HISTORY);
    this.save();
    return {
      greeting: greetingFor(this.deps.ownerName(), now),
      ...(s.subtitle ? { subtitle: s.subtitle } : {}),
      items: chosen.map(({ id, title, prompt, why, kind }) => ({ id, title, prompt, kind, ...(why ? { why } : {}) })),
      generatedAt: s.generatedAt,
    };
  }

  /** The owner picked one: it leaves the pool. */
  used(id: string): boolean {
    const s = this.load();
    const i = s.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    s.items.splice(i, 1);
    this.save();
    return true;
  }
}
