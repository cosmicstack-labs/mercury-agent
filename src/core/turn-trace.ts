/**
 * What one turn thought and ran, in the order it happened: thinking blocks
 * and tool calls with their durations. Kept with the reply (session message
 * metadata `trace`) so a screen shows the same thought process after the
 * chat is reopened as it did live. Bounded: a long agentic turn keeps its
 * most recent steps and a capped amount of thinking text.
 */

export interface TraceReasoning {
  kind: 'reasoning';
  text: string;
  startedAt: number;
  endedAt?: number;
}

export interface TraceTool {
  kind: 'tool';
  id: string;
  /** "Read src/x.ts", "Run npm test". */
  title: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /** First line of the result (or the error). */
  summary?: string;
}

export type TraceItem = TraceReasoning | TraceTool;

export interface StoredTrace {
  startedAt: number;
  endedAt: number;
  items: TraceItem[];
}

const MAX_ITEMS = 150;
const MAX_REASONING_CHARS = 24_000;
const MAX_BLOCK_CHARS = 8_000;
const MAX_SUMMARY = 160;

export function toolSummary(result: unknown): string | undefined {
  if (result == null) return undefined;
  let text: string;
  if (typeof result === 'string') text = result;
  else if (result instanceof Error) text = result.message;
  else {
    try { text = JSON.stringify(result) ?? ''; } catch { text = String(result); }
  }
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  if (!line) return undefined;
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}

export class TurnTrace {
  private items: TraceItem[] = [];
  private reasoningChars = 0;
  private openReasoning: TraceReasoning | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  reasoning(delta: string): void {
    if (!delta) return;
    if (!this.openReasoning) {
      this.openReasoning = { kind: 'reasoning', text: '', startedAt: this.now() };
      this.push(this.openReasoning);
    }
    const room = Math.min(MAX_BLOCK_CHARS - this.openReasoning.text.length, MAX_REASONING_CHARS - this.reasoningChars);
    if (room <= 0) return;
    const piece = delta.slice(0, room);
    this.openReasoning.text += piece;
    this.reasoningChars += piece.length;
  }

  reasoningEnded(): void {
    if (this.openReasoning) this.openReasoning.endedAt = this.now();
    this.openReasoning = null;
  }

  toolStarted(id: string, title: string): void {
    this.reasoningEnded();
    if (this.items.some((item) => item.kind === 'tool' && item.id === id)) return;
    this.push({ kind: 'tool', id, title: title.replace(/^[^\p{L}\p{N}]+/u, '').trim() || title, status: 'running', startedAt: this.now() });
  }

  toolFinished(id: string, failed: boolean, durationMs: number | undefined, summary: string | undefined): void {
    const step = [...this.items].reverse().find((item): item is TraceTool => item.kind === 'tool' && item.id === id);
    if (!step) return;
    const endedAt = this.now();
    step.status = failed ? 'error' : 'done';
    step.endedAt = endedAt;
    step.durationMs = typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : endedAt - step.startedAt;
    if (summary) step.summary = summary;
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * The trace so far, without ending anything: running tools stay running,
   * thinking still streaming stays open. For a screen that comes back to a
   * chat whose reply is still being worked on.
   */
  peek(startedAt: number): StoredTrace {
    return { startedAt, endedAt: this.now(), items: this.items.map((item) => ({ ...item })) };
  }

  /** The trace to keep with the reply; undefined when the turn neither thought nor ran anything. */
  snapshot(startedAt: number): StoredTrace | undefined {
    this.reasoningEnded();
    const items = this.items.filter((item) => item.kind === 'tool' || item.text.trim());
    if (!items.length) return undefined;
    const endedAt = this.now();
    return {
      startedAt,
      endedAt,
      // Anything still marked running when the turn ended was cut off.
      items: items.map((item) => (item.kind === 'tool' && item.status === 'running'
        ? { ...item, status: 'error' as const, endedAt, durationMs: endedAt - item.startedAt, summary: item.summary ?? 'Stopped' }
        : { ...item })),
    };
  }

  private push(item: TraceItem): void {
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
  }
}
