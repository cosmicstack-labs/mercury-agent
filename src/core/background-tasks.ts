import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { getMercuryHome } from '../utils/config.js';

export type BgTaskType = 'shell' | 'agent';
export type BgTaskStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export interface BackgroundTask {
  id: string;
  type: BgTaskType;
  command?: string;
  task?: string;
  cwd: string;
  status: BgTaskStatus;
  pid?: number;
  agentId?: string;
  startedAt: number;
  completedAt?: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timeoutMs: number;
}

export interface BackgroundTaskSummary {
  id: string;
  type: BgTaskType;
  command?: string;
  task?: string;
  status: BgTaskStatus;
  startedAt: number;
  completedAt?: number;
  exitCode: number | null;
  outputPreview: string;
  runningMs?: number;
}

const MAX_OUTPUT = 1024 * 1024;
const MAX_TASKS = 20;
const PRUNE_AGE_MS = 60 * 60 * 1000;
const SIGTERM_GRACE_MS = 3000;
const MAX_PREVIEW = 200;
const DEFAULT_SHELL_TIMEOUT_MS = 0;
const BG_TASKS_FILE = 'background-tasks.json';

let taskCounter = 0;

const ADJECTIVES = [
  'swift', 'calm', 'bold', 'warm', 'cool', 'keen', 'neat', 'wise',
  'fair', 'glad', 'blue', 'gold', 'soft', 'wild', 'deep', 'pure',
  'slim', 'tall', 'kind', 'fast', 'red', 'dark', 'pale', 'loud',
  'thin', 'rich', 'raw', 'dry', 'old', 'new', 'big', 'low',
  'shy', 'dim', 'hot', 'icy', 'odd', 'tan', 'apt', 'fit',
  'lax', 'coy', 'sly', 'wry', 'zen', 'deft', 'grim', 'snug',
];

const NOUNS = [
  'fox', 'owl', 'elk', 'ant', 'bee', 'cat', 'dog', 'ram',
  'jay', 'cod', 'eel', 'yak', 'bat', 'hen', 'ape', 'gnu',
  'oak', 'elm', 'ash', 'bay', 'fir', 'ivy', 'gem', 'ore',
  'sun', 'moon', 'star', 'wave', 'wind', 'rain', 'snow', 'bolt',
  'flame', 'spark', 'leaf', 'seed', 'root', 'vine', 'reef', 'cove',
  'peak', 'vale', 'dune', 'isle', 'pond', 'brook', 'dale', 'mesa',
];

const usedIds = new Set<string>();

function nextId(): string {
  taskCounter += 1;
  // Try up to 10 times to find a unique combo
  for (let attempt = 0; attempt < 10; attempt++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const id = `${adj}-${noun}`;
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  // Fallback: append counter
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const id = `${adj}-${noun}-${taskCounter}`;
  usedIds.add(id);
  return id;
}

function tailTruncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(str.length - maxLen);
}

export type TaskCompleteCallback = (task: BackgroundTask) => void;

export class BackgroundTaskManager {
  private tasks: Map<string, BackgroundTask> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private timeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private sigkillTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onCompleteCallbacks: Map<string, TaskCompleteCallback> = new Map();
  private globalOnComplete?: TaskCompleteCallback;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.load();
    this.pruneInterval = setInterval(() => this.prune(), 5 * 60 * 1000);
  }

  destroy(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    for (const [id, child] of this.processes) {
      try { child.kill('SIGTERM'); } catch {}
    }
    for (const [, t] of this.timeouts) {
      clearTimeout(t);
    }
    for (const [, t] of this.sigkillTimeouts) {
      clearTimeout(t);
    }
    this.save();
  }

  onGlobalComplete(cb: TaskCompleteCallback): void {
    this.globalOnComplete = cb;
  }

  spawnShell(command: string, cwd: string, timeoutMs: number = DEFAULT_SHELL_TIMEOUT_MS): string {
    this.enforceTaskLimit();

    const id = nextId();
    const task: BackgroundTask = {
      id,
      type: 'shell',
      command,
      cwd,
      status: 'running',
      pid: undefined,
      startedAt: Date.now(),
      exitCode: null,
      stdout: '',
      stderr: '',
      timeoutMs,
    };
    this.tasks.set(id, task);
    this.save();

    try {
      const child = spawn(command, [], {
        cwd,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      task.pid = child.pid ?? undefined;
      this.processes.set(id, child);

      child.stdout?.on('data', (chunk: Buffer) => {
        task.stdout += chunk.toString();
        if (task.stdout.length > MAX_OUTPUT) {
          task.stdout = tailTruncate(task.stdout, MAX_OUTPUT);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        task.stderr += chunk.toString();
        if (task.stderr.length > MAX_OUTPUT) {
          task.stderr = tailTruncate(task.stderr, MAX_OUTPUT);
        }
      });

      child.on('error', (err) => {
        task.stderr += `\nProcess error: ${err.message}`;
        this.completeTask(id, null, 'failed');
      });

      child.on('exit', (code) => {
        this.completeTask(id, code, code === 0 ? 'completed' : 'failed');
      });

      if (timeoutMs > 0) {
        const timeout = setTimeout(() => {
          this.killTask(id, 'SIGTERM');
          const sigkillTimeout = setTimeout(() => {
            this.killTask(id, 'SIGKILL');
          }, SIGTERM_GRACE_MS);
          this.sigkillTimeouts.set(id, sigkillTimeout);

          if (task.status === 'running') {
            task.status = 'timed_out';
            this.completeTask(id, null, 'timed_out');
          }
        }, timeoutMs);
        this.timeouts.set(id, timeout);
      }

      logger.info({ taskId: id, command, cwd }, 'Background shell task started');
    } catch (err: any) {
      task.status = 'failed';
      task.stderr = `Failed to spawn: ${err.message}`;
      task.completedAt = Date.now();
      task.exitCode = null;
    }

    return id;
  }

  spawnAgent(taskDescription: string, cwd: string, agentId: string): string {
    this.enforceTaskLimit();

    const id = nextId();
    const task: BackgroundTask = {
      id,
      type: 'agent',
      task: taskDescription,
      cwd,
      status: 'running',
      agentId,
      startedAt: Date.now(),
      exitCode: null,
      stdout: '',
      stderr: '',
      timeoutMs: 0,
    };
    this.tasks.set(id, task);
    this.save();
    logger.info({ taskId: id, agentId, task: taskDescription }, 'Background agent task started');
    return id;
  }

  updateAgentProgress(bgTaskId: string, progress: string): void {
    const task = this.tasks.get(bgTaskId);
    if (!task || task.type !== 'agent') return;
    task.stdout += progress + '\n';
    if (task.stdout.length > MAX_OUTPUT) {
      task.stdout = tailTruncate(task.stdout, MAX_OUTPUT);
    }
    this.save();
  }

  completeAgentTask(bgTaskId: string, exitCode: number | null, status: BgTaskStatus, output?: string): void {
    const task = this.tasks.get(bgTaskId);
    if (!task) return;
    if (output) {
      task.stdout = output;
    }
    this.completeTask(bgTaskId, exitCode, status);
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== 'running') return false;

    if (task.type === 'shell') {
      this.killTask(taskId, 'SIGTERM');
      const sigkill = setTimeout(() => {
        this.killTask(taskId, 'SIGKILL');
      }, SIGTERM_GRACE_MS);
      this.sigkillTimeouts.set(taskId, sigkill);
    }

    task.status = 'cancelled';
    task.completedAt = Date.now();
    task.exitCode = null;
    this.clearTimeouts(taskId);
    this.notifyComplete(task);
    this.save();
    logger.info({ taskId }, 'Background task cancelled');
    return true;
  }

  cancelAll(): number {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (task.status === 'running') {
        if (task.type === 'shell') {
          this.killTask(id, 'SIGTERM');
          const sigkill = setTimeout(() => {
            this.killTask(id, 'SIGKILL');
          }, SIGTERM_GRACE_MS);
          this.sigkillTimeouts.set(id, sigkill);
        }
        task.status = 'cancelled';
        task.completedAt = Date.now();
        task.exitCode = null;
        this.clearTimeouts(id);
        this.notifyComplete(task);
        count++;
      }
    }
    if (count > 0) this.save();
    logger.info({ count }, 'All background tasks cancelled');
    return count;
  }

  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  getSummary(taskId: string): BackgroundTaskSummary | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return this.toSummary(task);
  }

  getAll(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  getAllSummaries(): BackgroundTaskSummary[] {
    return [...this.tasks.values()].map(this.toSummary);
  }

  getRunning(): BackgroundTask[] {
    return [...this.tasks.values()].filter(t => t.status === 'running');
  }

  getRunningSummaries(): BackgroundTaskSummary[] {
    return this.getRunning().map(this.toSummary);
  }

  registerComplete(taskId: string, cb: TaskCompleteCallback): void {
    this.onCompleteCallbacks.set(taskId, cb);
  }

  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, task] of this.tasks) {
      if (task.status === 'running') continue;
      if (task.completedAt && (now - task.completedAt) > PRUNE_AGE_MS) {
        this.tasks.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.save();
      logger.info({ pruned }, 'Pruned completed background tasks');
    }
    return pruned;
  }

  clearCompleted(): number {
    let cleared = 0;
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running') {
        this.tasks.delete(id);
        cleared++;
      }
    }
    if (cleared > 0) this.save();
    return cleared;
  }

  getByAgentId(agentId: string): BackgroundTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.agentId === agentId) return task;
    }
    return undefined;
  }

  private completeTask(id: string, exitCode: number | null, status: BgTaskStatus): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status !== 'running' && task.status !== 'timed_out') return;

    task.exitCode = exitCode;
    task.status = status;
    task.completedAt = Date.now();
    this.clearTimeouts(id);
    this.processes.delete(id);

    logger.info({ taskId: id, status, exitCode }, 'Background task completed');
    this.notifyComplete(task);
    this.save();
  }

  private notifyComplete(task: BackgroundTask): void {
    const cb = this.onCompleteCallbacks.get(task.id);
    if (cb) {
      try { cb(task); } catch {}
      this.onCompleteCallbacks.delete(task.id);
    }
    if (this.globalOnComplete) {
      try { this.globalOnComplete(task); } catch {}
    }
  }

  private killTask(id: string, signal: NodeJS.Signals): void {
    const child = this.processes.get(id);
    if (child) {
      try { child.kill(signal); } catch {}
    }
  }

  private clearTimeouts(id: string): void {
    const t = this.timeouts.get(id);
    if (t) { clearTimeout(t); this.timeouts.delete(id); }
    const s = this.sigkillTimeouts.get(id);
    if (s) { clearTimeout(s); this.sigkillTimeouts.delete(id); }
  }

  private enforceTaskLimit(): void {
    const completed = [...this.tasks.values()]
      .filter(t => t.status !== 'running')
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

    while (this.tasks.size >= MAX_TASKS && completed.length > 0) {
      const oldest = completed.shift();
      if (oldest) {
        this.tasks.delete(oldest.id);
      }
    }
    this.save();
  }

  private load(): void {
    const filePath = this.getFilePath();
    if (!existsSync(filePath)) return;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as BackgroundTask[];
      this.tasks.clear();

      for (const task of parsed) {
        if (!task?.id) continue;
        if (task.status === 'running') {
          task.status = 'failed';
          task.completedAt = Date.now();
          task.stderr = `${task.stderr}\nRecovered after restart: task was running when process exited.`.trim();
        }
        this.tasks.set(task.id, task);
        usedIds.add(task.id);
      }

      logger.info({ count: this.tasks.size }, 'Background tasks loaded');
    } catch (err) {
      logger.warn({ err }, 'Failed to load background tasks');
      this.tasks.clear();
    }
  }

  private save(): void {
    try {
      const dir = join(getMercuryHome(), 'memory');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.getFilePath(), JSON.stringify([...this.tasks.values()], null, 2), 'utf-8');
    } catch (err) {
      logger.warn({ err }, 'Failed to save background tasks');
    }
  }

  private getFilePath(): string {
    return join(getMercuryHome(), 'memory', BG_TASKS_FILE);
  }

  private toSummary(task: BackgroundTask): BackgroundTaskSummary {
    const combined = task.stdout + '\n' + task.stderr;
    const preview = combined.trim().slice(-MAX_PREVIEW);
    return {
      id: task.id,
      type: task.type,
      command: task.command,
      task: task.task,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      exitCode: task.exitCode,
      outputPreview: preview,
      runningMs: task.status === 'running' ? Date.now() - task.startedAt : undefined,
    };
  }
}
