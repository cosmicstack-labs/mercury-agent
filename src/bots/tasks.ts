import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Durable fleet tasks (ADR-021). A task is a typed unit of delegated work:
 * who asked, who does it, the goal, the acceptance, a deadline, and — once
 * done — a typed result (outcome, deliverables, summary). Tasks are grouped
 * in batches so a lead that fans out N tasks is woken ONCE with a digest
 * when the batch completes (or its deadline passes), instead of N times
 * with N free-text mails.
 *
 * Storage is one JSON file next to the queue (atomic tmp+rename): task
 * volume is small, and it works on every device the JSON queue works on.
 */

export type BotTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'halted' | 'cancelled';

export interface BotTaskResult {
  outcome: string;
  summary: string;
  deliverables: string[];
  reasonCode?: string;
}

export interface BotTask {
  id: string;
  batchId: string;
  /** The bot that asked (a lead), or 'owner' for tasks created by a person. */
  requester: string;
  assignee: string;
  goal: string;
  acceptance?: string;
  /** Pipeline stage name when the task belongs to a pipeline run. */
  stage?: string;
  pipeline?: { runId: string; index: number; total: number; input: string; final: boolean };
  status: BotTaskStatus;
  jobId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: BotTaskResult;
}

export interface BotBatch {
  id: string;
  requester: string;
  label?: string;
  /** all = one wake when every task is settled; each = a wake per task. */
  wakeWhen: 'all' | 'each';
  createdAt: number;
  deadlineAt?: number;
  /** The requester has been woken for this batch (complete or deadline). */
  notifiedAt?: number;
}

interface TaskFile {
  batches: BotBatch[];
  tasks: BotTask[];
}

export const TASKS_FILE = 'tasks.json';
/** Settled tasks older than this are dropped from the file (the journal keeps the run). */
const RETAIN_SETTLED_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL: ReadonlySet<BotTaskStatus> = new Set(['done', 'failed', 'halted', 'cancelled']);

export function isTerminalTask(status: BotTaskStatus): boolean {
  return TERMINAL.has(status);
}

export class BotTaskStore {
  private readonly file: string;
  private data: TaskFile;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, TASKS_FILE);
    this.data = this.read();
  }

  private read(): TaskFile {
    if (!existsSync(this.file)) return { batches: [], tasks: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<TaskFile>;
      return { batches: parsed.batches ?? [], tasks: parsed.tasks ?? [] };
    } catch {
      return { batches: [], tasks: [] };
    }
  }

  private flush(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data), 'utf-8');
    renameSync(tmp, this.file);
  }

  createBatch(input: { requester: string; label?: string; wakeWhen?: 'all' | 'each'; deadlineAt?: number }): BotBatch {
    const batch: BotBatch = {
      id: randomUUID().slice(0, 8),
      requester: input.requester,
      label: input.label,
      wakeWhen: input.wakeWhen ?? 'all',
      createdAt: Date.now(),
      deadlineAt: input.deadlineAt,
    };
    this.data.batches.push(batch);
    this.flush();
    return batch;
  }

  /**
   * Create a task, or return the open task that already covers the same
   * goal for the same assignee (a lead re-running a delegation turn after a
   * restart must not double-dispatch).
   */
  createTask(input: Omit<BotTask, 'id' | 'status' | 'createdAt'>): { task: BotTask; duplicated: boolean } {
    const dup = this.data.tasks.find(t => t.requester === input.requester && t.assignee === input.assignee && t.goal === input.goal && !isTerminalTask(t.status));
    if (dup) return { task: dup, duplicated: true };
    const task: BotTask = { ...input, id: randomUUID().slice(0, 8), status: 'queued', createdAt: Date.now() };
    this.data.tasks.push(task);
    this.flush();
    return { task, duplicated: false };
  }

  get(taskId: string): BotTask | null {
    return this.data.tasks.find(t => t.id === taskId) ?? null;
  }

  byJob(jobId: string): BotTask | null {
    return this.data.tasks.find(t => t.jobId === jobId && !isTerminalTask(t.status)) ?? null;
  }

  batch(batchId: string): BotBatch | null {
    return this.data.batches.find(b => b.id === batchId) ?? null;
  }

  tasksInBatch(batchId: string): BotTask[] {
    return this.data.tasks.filter(t => t.batchId === batchId);
  }

  /** Open (unsettled) tasks, optionally for one requester or one assignee. */
  open(filter: { requester?: string; assignee?: string } = {}): BotTask[] {
    return this.data.tasks.filter(t => !isTerminalTask(t.status)
      && (!filter.requester || t.requester === filter.requester)
      && (!filter.assignee || t.assignee === filter.assignee));
  }

  /** Most recent tasks for a requester, newest first (open and settled). */
  recent(requester: string, limit = 20): BotTask[] {
    return this.data.tasks.filter(t => t.requester === requester).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  update(taskId: string, patch: Partial<BotTask>): BotTask | null {
    const task = this.get(taskId);
    if (!task) return null;
    Object.assign(task, patch);
    this.flush();
    return task;
  }

  markBatchNotified(batchId: string): void {
    const batch = this.batch(batchId);
    if (batch) {
      batch.notifiedAt = Date.now();
      this.flush();
    }
  }

  /** Batches whose deadline has passed with open tasks and no wake yet. */
  overdueBatches(now = Date.now()): BotBatch[] {
    return this.data.batches.filter(b => b.deadlineAt !== undefined && b.deadlineAt <= now && !b.notifiedAt
      && this.tasksInBatch(b.id).some(t => !isTerminalTask(t.status)));
  }

  /** Drop settled tasks (and empty batches) older than the retention window. */
  prune(now = Date.now()): number {
    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter(t => !isTerminalTask(t.status) || (t.completedAt ?? t.createdAt) > now - RETAIN_SETTLED_MS);
    const live = new Set(this.data.tasks.map(t => t.batchId));
    this.data.batches = this.data.batches.filter(b => live.has(b.id) || b.createdAt > now - RETAIN_SETTLED_MS);
    if (this.data.tasks.length !== before) this.flush();
    return before - this.data.tasks.length;
  }

  /** Remove every task a bot asked for or was assigned (delete lifecycle). */
  purgeBot(botId: string): void {
    this.data.tasks = this.data.tasks.filter(t => t.requester !== botId && t.assignee !== botId);
    this.data.batches = this.data.batches.filter(b => b.requester !== botId);
    this.flush();
  }
}

/** The prompt a crew bot receives for a task: typed, self-contained, with the previous stage's hand-off. */
export function renderTaskPrompt(task: BotTask, requesterName: string, previous?: BotTaskResult): string {
  const lines = [`Task ${task.id} from ${requesterName}${task.stage ? ` — pipeline stage "${task.stage}"${task.pipeline ? ` (${task.pipeline.index + 1}/${task.pipeline.total})` : ''}` : ''}:`, '', task.goal];
  if (task.acceptance) lines.push('', `Done means: ${task.acceptance}`);
  if (previous) {
    lines.push('', 'Hand-off from the previous stage:');
    if (previous.deliverables.length > 0) lines.push(...previous.deliverables.map(p => `- file: ${p}`));
    if (previous.summary) lines.push(`- summary: ${previous.summary.slice(0, 1500)}`);
  }
  lines.push('', 'When finished, deliver your result with bot_deliver (a file) and summarise it in your reply. Your reply and deliverables are returned to the requester automatically.');
  return lines.join('\n');
}

/** The digest a requester is woken with when a batch settles (or runs late). */
export function renderBatchDigest(batch: BotBatch, tasks: BotTask[], botName: (id: string) => string): string {
  const open = tasks.filter(t => !isTerminalTask(t.status));
  const head = batch.label ? `Batch "${batch.label}"` : 'Delegated work';
  const lines = [open.length === 0 ? `${head} is complete (${tasks.length} task${tasks.length === 1 ? '' : 's'}):` : `${head}: ${tasks.length - open.length} of ${tasks.length} tasks done, ${open.length} still running past the deadline:`];
  for (const t of tasks) {
    const icon = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'cancelled' ? '🚫' : t.status === 'halted' ? '⏹' : '⏳';
    const r = t.result;
    lines.push('', `${icon} ${botName(t.assignee)} — task ${t.id}${t.stage ? ` (${t.stage})` : ''}: ${t.status}${r?.outcome ? ` · ${r.outcome}` : ''}${r?.reasonCode ? ` [${r.reasonCode}]` : ''}`);
    for (const d of r?.deliverables ?? []) lines.push(`   📁 ${d}`);
    if (r?.summary) lines.push(`   ${r.summary.slice(0, 1200).replace(/\n+/g, '\n   ')}`);
  }
  return lines.join('\n');
}
