import { randomUUID } from 'node:crypto';

/**
 * Bots asking the owner mid-run (Bots 2.0). A bot that needs something
 * outside its grants — a command, a file outside its folders — waits here
 * for the owner's answer, for a while: nobody answering in time is a "no",
 * the same as a bot that never asked. Pending questions live only as long as
 * the run that asked; a restart ends the run and so the question.
 */

export type BotApprovalAnswer = 'yes' | 'always' | 'no';

export interface BotApproval {
  id: string;
  botId: string;
  botName: string;
  /** The job (run) that asked. */
  runId: string;
  /** What it wants to do, as the permission layer said it ("Run command: …", "Write to file: …"). */
  prompt: string;
  at: number;
  expiresAt: number;
}

type Event = { type: 'new' | 'settled'; approval: BotApproval; answer?: BotApprovalAnswer; by?: 'owner' | 'timeout' };

export class BotApprovals {
  private pending = new Map<string, { approval: BotApproval; resolve: (a: BotApprovalAnswer) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(e: Event) => void>();

  onChange(listener: (e: Event) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Ask and wait. Resolves the owner's answer, or "no" after `waitMs`. */
  ask(input: Omit<BotApproval, 'id' | 'at' | 'expiresAt'>, waitMs: number): { approval: BotApproval; answer: Promise<BotApprovalAnswer> } {
    const at = Date.now();
    const approval: BotApproval = { ...input, id: randomUUID().slice(0, 12), at, expiresAt: at + waitMs };
    const answer = new Promise<BotApprovalAnswer>((resolve) => {
      const timer = setTimeout(() => this.settle(approval.id, 'no', 'timeout'), waitMs);
      timer.unref?.();
      this.pending.set(approval.id, { approval, resolve, timer });
    });
    this.emit({ type: 'new', approval });
    return { approval, answer };
  }

  /** The owner's answer. False when the question is gone (answered, timed out, run ended). */
  answer(id: string, answer: BotApprovalAnswer): boolean {
    return this.settle(id, answer, 'owner');
  }

  /** A run ended (finished, halted, crashed): its open questions are moot. */
  cancelRun(runId: string): void {
    for (const [id, p] of this.pending) if (p.approval.runId === runId) this.settle(id, 'no', 'timeout');
  }

  list(botId?: string): BotApproval[] {
    return [...this.pending.values()].map((p) => p.approval).filter((a) => !botId || a.botId === botId).sort((a, b) => a.at - b.at);
  }

  private settle(id: string, answer: BotApprovalAnswer, by: 'owner' | 'timeout'): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(answer);
    this.emit({ type: 'settled', approval: p.approval, answer, by });
    return true;
  }

  private emit(e: Event): void {
    for (const l of this.listeners) {
      try { l(e); } catch { /* a listener's problem */ }
    }
  }
}

/** Commands whose "always" must never widen to the whole family: they can run anything. */
const NEVER_GENERALISE = new Set(['sudo', 'su', 'sh', 'bash', 'zsh', 'fish', 'dash', 'env', 'xargs', 'eval', 'exec', 'nohup', 'time', 'nice', 'doas', 'pwsh', 'powershell', 'cmd', 'node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun']);

/**
 * What "always" adds to the bot's own permissions for this question: a command
 * pattern for its allow list, or a path grant. Null when it can't be made
 * durable (the owner's yes still applies to this run).
 */
export function durableGrant(prompt: string): { command: string } | { path: string; write: boolean } | null {
  const cmd = /^Run command: ([\s\S]+)$/.exec(prompt);
  if (cmd) {
    const command = cmd[1].trim();
    // A chain or pipeline is approved exactly as written, never as a family.
    if (/[;&|`$<>]/.test(command)) return { command };
    const base = command.split(/\s+/)[0] ?? '';
    if (!base || NEVER_GENERALISE.has(base.replace(/^.*\//, ''))) return { command };
    return { command: `${base} *` };
  }
  const file = /^(Write to file|Read file): (.+)$/.exec(prompt);
  if (file) return { path: file[2].trim(), write: file[1] === 'Write to file' };
  return null;
}
