import { refinePersona } from './persona-template.js';
import { randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, relative, resolve, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import type { Tool } from 'ai';
import type { MercuryConfig } from '../utils/config.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import { UserMemoryStore as UserMemoryStoreImpl } from '../memory/user-memory.js';
import { BotStore, BOT_JOURNAL_FILENAME, BOT_PERMISSIONS_FILENAME, isValidCronExpression } from './store.js';
import { BotJournal } from './journal.js';
import { BotQueue, idempotencyKeyFor, LEASE_SECONDS, type DurableBotJob } from './queue.js';
import { sweepSharedSandbox } from './retention.js';
import { proposeCrew } from './fleet-onboarding.js';
import { createBotCapabilityRegistry, filterBotTools } from './registry-factory.js';
import { createBotSendTool } from './tools/bot-send.js';
import { createBotDeliverTool } from './tools/bot-deliver.js';
import { createBotScheduleTool, type BotScheduler } from './tools/bot-schedule.js';
import { createFleetStatusTool } from './tools/fleet-status.js';
import { createBotSpawnTool } from './tools/bot-spawn.js';
import { runBotTurn, isTransientFailure, type BotTurnMail, type BotActivityEvent } from './bot-turn.js';
import { parsePersonaAccess, stripPersonaAccessSection } from './persona-access.js';
import { mergePathScopes } from './registry-factory.js';
import { synthesizeSkill, MIN_TOOLS_FOR_SYNTHESIS } from './skill-synthesis.js';
import { SkillLoader } from '../skills/loader.js';
import { logger } from '../utils/logger.js';
import type {
  BotLiveState,
  BotManifest,
  BotRunRecord,
  BotStatusSummary,
  BotTrigger,
} from './types.js';

export interface BotJob {
  id: string;
  botId: string;
  trigger: BotTrigger;
  prompt: string;
  /** Mailbox attribution — set for bot-to-bot deliveries. */
  fromBot?: string;
  /** Originating surface for completion delivery. */
  source?: { channelType: string; channelId: string };
  createdAt: number;
  attempts: number;
}

/**
 * Fleet delegation rule: a mailbox job WITH a prompt (fromBot set) is a TASK
 * dispatched by another bot — its result is returned to the sender's mailbox
 * on completion. Plain mail wakes (prompt '') never reply — no ping-pong.
 * Derived from the job itself, so it survives restarts with zero schema.
 */
function replyTargetFor(job: BotJob): string | undefined {
  return job.trigger === 'mailbox' && job.fromBot && job.prompt ? job.fromBot : undefined;
}

export interface BotSendResult {
  accepted: boolean;
  jobId?: string;
  reasonCode?: 'target_disabled' | 'target_unknown' | 'queue_full' | 'not_linked';
}

export interface BotManagerDeps {
  config: MercuryConfig;
  providers: ProviderRegistry;
  tokenBudget: TokenBudget;
  store?: BotStore;
  /** Durable job store; defaults to the SQLite→JSON backend at the bots root. */
  queue?: BotQueue;
  /** Per-bot memory factory (P0-5 wires the default: UserMemoryStore with bot:<id> key). */
  userMemoryFactory?: (botId: string, manifest: BotManifest) => UserMemoryStore | null;
  /** Global (native) skills root; default resolves to <botsRoot>/../skills (~/.mercury/skills). */
  skillsRoot?: string;
  /** Deliver turn output to the invoking surface (chat/telegram/api). */
  notify?: (channelType: string, channelId: string, message: string) => Promise<void>;
}

const MAX_TRANSIENT_ATTEMPTS = 3;
const MAILBOX_CAPACITY = 100;
/** Bot-thread result display cap — matches CLIChannel.MAX_MESSAGE_CHARS (64KB). */
const BOT_RESULT_DISPLAY_CAP = 64 * 1024;

/** Bare wake turn (`/bots run <id>` with no routine): the bot gets a real
 * turn with no task attached — it checks its mailbox and standing work. */
const WAKE_PROMPT = '[wake] You were triggered manually with no specific task attached. Check your mailbox and any pending work; act on whatever your persona or standing routines call for, otherwise reply with a one-line status.';

/** Structural subset of the main Scheduler the bot runtime needs. */
type BotSchedulerLike = {
  addDelayedTask(m: { id: string; description: string; prompt: string; delaySeconds?: number; executeAt?: string; botId?: string; createdAt: string }): void;
  addPersistedTask(m: { id: string; cron: string; description: string; prompt: string; botId?: string; createdAt: string }): void;
  persistSchedules(): void;
  getManifests(): Array<{ id: string; botId?: string }>;
  removeTask(id: string): void;
};

/**
 * Owns the bot fleet: per-bot job queues, isolated turn runtimes, mailboxes,
 * run journals, and live statuses. Bots never touch Agent.processQueue —
 * they run as independent coroutines in this manager (BOTS-ARCHITECTURE.md §2.2).
 */
export class BotManager {
  readonly store: BotStore;
  readonly queue: BotQueue;
  private readonly config: MercuryConfig;
  private readonly providers: ProviderRegistry;
  private readonly tokenBudget: TokenBudget;
  private readonly userMemoryFactory?: BotManagerDeps['userMemoryFactory'];
  private readonly skillsRoot?: BotManagerDeps['skillsRoot'];
  private notify?: BotManagerDeps['notify'];
  private alert?: (message: string) => Promise<void>;

  /** Deliver turn output to the invoking surface (wired by the Agent). */
  setNotify(cb: NonNullable<BotManagerDeps['notify']>): void {
    this.notify = cb;
  }

  /** Push needs-you events (permanent failure, budget pause) to the owner. */
  setAlert(cb: (message: string) => Promise<void>): void {
    this.alert = cb;
  }

  /** Wire the main Scheduler so bots can self-schedule (bot_schedule tool). */
  setScheduler(scheduler: BotSchedulerLike): void {
    this.scheduler = scheduler;
    // Runtime-created toolsets gain the tool on next invalidation; simplest
    // is to refresh all bot runtimes so every bot sees the new tool.
    for (const botId of [...this.registries.keys()]) this.invalidateRuntime(botId);
  }

  private async alertOwner(botId: string, message: string): Promise<void> {
    // Needs-you events (permanent failure, budget pause) live in the BOT'S
    // OWN thread — the main chat is never informed (§3.1). Remote owner
    // surfaces (signal/telegram/…) still get the heads-up via the alert
    // channel; the CLI is excluded there (agent wiring) because it would
    // print into whatever main session is open.
    if (this.notify) {
      await this.notify('cli', `bot:${botId}`, message).catch((e) =>
        logger.warn({ e, botId }, 'Bot alert to bot thread failed'));
    }
    if (this.alert) {
      await this.alert(message).catch((e) => logger.warn({ e, botId }, 'Bot alert send failed'));
    }
  }

  private queues: Map<string, BotJob[]> = new Map();
  private scheduler?: BotSchedulerLike;
  private mailboxes: Map<string, BotTurnMail[]> = new Map();
  private running: Map<string, Set<string>> = new Map(); // botId → running job ids
  private aborts: Map<string, AbortController> = new Map(); // job key → controller
  private registries: Map<string, { registry: CapabilityRegistry; tools: Record<string, Tool>; skillsPrompt: string; manifest: BotManifest; permsMtimeMs: number }> = new Map();
  private activity: Map<string, string> = new Map(); // botId → current activity
  private lastRun: Map<string, { at: number; state: BotRunRecord['state'] }> = new Map();
  private needsYou: Set<string> = new Set();
  private journals: Map<string, BotJournal> = new Map();
  private userMemories: Map<string, UserMemoryStore | null> = new Map();
  private disabled = new Set<string>();
  /** Bots stopped by the user (/bots stop) — their held jobs must not sneak
   * back in via the passive due-sweep; only /bots start (or a restart) resumes. */
  private held = new Set<string>();
  /** Per-bot daily token usage: botId → { day (UTC yyyy-mm-dd), tokens }. */
  private dailyTokens: Map<string, { day: string; tokens: number }> = new Map();
  private pausedForBudget = new Set<string>();
  /** Periodic due-sweep interval — cleared by dispose() (tests, shutdown). */
  private dueTimer?: ReturnType<typeof setInterval>;

  constructor(deps: BotManagerDeps) {
    this.config = deps.config;
    this.providers = deps.providers;
    this.tokenBudget = deps.tokenBudget;
    this.userMemoryFactory = deps.userMemoryFactory ?? ((botId, manifest) => {
      // Default: per-bot namespace in the shared second-brain DB.
      // scope 'none' = stateless bot. SQLite-less devices degrade to a
      // stateless bot until the sql.js/JSONL fallback lands (P1, §2.11).
      const scope = manifest.memory?.scope ?? 'own';
      if (scope === 'none') return null;
      try {
        return new UserMemoryStoreImpl(this.config, `bot:${botId}`);
      } catch (err: any) {
        logger.warn({ botId, err: err?.message }, 'Bot memory store unavailable (no native SQLite) — running stateless');
        return null;
      }
    });
    this.notify = deps.notify;
    this.store = deps.store ?? new BotStore();
    this.skillsRoot = deps.skillsRoot;
    this.queue = deps.queue ?? new BotQueue(this.store.botsRoot, this.config.bots?.retention?.dlqCap);
    // Resume work a crashed predecessor left behind: pending jobs (and
    // expired-lease claimed jobs) re-enter the in-memory queues. Durable
    // enqueue happens before any ack, so nothing was lost (§2.6).
    for (const job of this.queue.resumeJobs()) {
      if (this.store.exists(job.botId)) {
        const q = this.queues.get(job.botId) ?? [];
        this.queues.set(job.botId, q);
        q.push({
          id: job.id, botId: job.botId, trigger: job.trigger, prompt: job.prompt,
          fromBot: job.fromBot, source: job.source, createdAt: job.createdAt, attempts: job.attempts,
        });
        this.pump(job.botId);
      } else {
        this.queue.settle(job.id, 'dead', 'bot_removed');
      }
    }
    // Durable mailboxes survive restarts: rehydrate into the in-memory boxes.
    // The needs-you badge too: it lives on the newest journal row (set when a
    // run is DLQ'd or crashes, cleared by the next run's row), so the
    // in-memory set is only a cache of that — a restart must not clear an
    // escalation the owner has not seen.
    for (const m of this.store.list()) {
      const drained = this.queue.drainMail(m.id);
      if (drained.length > 0) this.mailboxes.set(m.id, drained);
      if (this.journalFor(m.id).read(m.id, 1)[0]?.needsYou) this.needsYou.add(m.id);
    }
    // A profile relocation (re-parent or fleet-layout migration) invalidates
    // the cached journal handle (it is bound to the old dir) and the bot's
    // compiled toolset.
    this.store.onRelocate = (botId) => {
      this.journals.delete(botId);
      this.invalidateRuntime(botId);
    };
    // Periodic due-sweep: retry-backoff jobs re-enter the in-memory queues
    // when their run_after elapses (also covers crash-restart backoffs).
    this.dueTimer = setInterval(() => this.resumeDueJobs(), 30_000);
    this.dueTimer.unref?.();
    // Retention janitor: on boot + once a day, cool down aged files in the
    // fleet-shared folder into the archive and expire the archive (disabled
    // entirely with `sandboxJanitor.enabled: false`).
    if (this.config.bots?.retention?.sandboxJanitor?.enabled !== false) {
      const janitorTimer = setInterval(() => this.sweepRetention(), 24 * 60 * 60 * 1000);
      janitorTimer.unref?.();
      setTimeout(() => this.sweepRetention(), 15_000);
    }
    // Real-time activity consumer registration happens via onBotActivity();
    // executeTurn feeds every registered listener AND the live `activity`
    // map (rendered by the /bots roster and fleet_status).
  }

  /**
   * Real-time bot activity bus. Every bot turn emits granular events
   * (turn-start, step, tool start/finish, turn-end); listeners render them —
   * the CLI bot-thread live region, the web feed, future dashboards. The
   * manager itself also mirrors the latest label into the `activity` map so
   * the roster goes live with no extra UI.
   */
  private activityListeners = new Set<(ev: BotActivityEvent) => void>();
  onBotActivity(listener: (ev: BotActivityEvent) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }
  private emitBotActivity(ev: BotActivityEvent): void {
    // Live roster label: keep the static job description until the first
    // step arrives, then follow the actual work. 'thinking' events are a
    // stream preview for threads, not a roster label — the label must stay
    // semantic (step/tool names), not the last 80 chars of reasoning.
    if (ev.kind !== 'turn-end' && ev.kind !== 'thinking') this.activity.set(ev.botId, ev.label);
    for (const listener of this.activityListeners) {
      try { listener(ev); } catch (err: any) {
        logger.warn({ botId: ev.botId, err: err?.message }, 'Bot activity listener failed');
      }
    }
  }

  /**
   * Pull due (backoff-elapsed) jobs from the durable queue into memory and
   * run them. This is the ONLY re-entry path for a retried/paused job: the
   * precise backoff timers call it too, instead of pushing a captured copy
   * of the job themselves. A timer that pushed its own copy raced the 30s
   * sweep — the sweep moved the job from the queue into `running`, the
   * timer saw an empty queue and pushed it again, and the job ran twice
   * (the second settle a silent no-op). Reading durable state here makes
   * re-entry idempotent: a running job is `claimed` (not due), a finished
   * one is gone, a queued one is skipped by id.
   */
  private resumeDueJobs(): void {
    const due = this.queue.dueJobs();
    for (const job of due) {
      if (this.disabled.has(job.botId) || this.held.has(job.botId)) continue;
      this.reenterJob(job);
    }
  }

  /** Re-enter a durable job into its bot's in-memory lane unless that id is
   * already queued OR running — a job id is never in both, and never twice. */
  private reenterJob(job: DurableBotJob): boolean {
    const q = this.queues.get(job.botId) ?? [];
    if (q.some(j => j.id === job.id) || this.running.get(job.botId)?.has(job.id)) return false;
    q.push({
      id: job.id, botId: job.botId, trigger: job.trigger, prompt: job.prompt,
      fromBot: job.fromBot, source: job.source, createdAt: job.createdAt, attempts: job.attempts,
    });
    this.queues.set(job.botId, q);
    this.pump(job.botId);
    return true;
  }

  /**
   * Fleet-wide concurrency cap: config override or a fixed default of 8.
   * NOT cpu-derived: a bot turn is a network-bound LLM call plus small tool
   * subprocesses — a cpus()-1 cap serialized whole fleets on small VMs
   * (4 vCPU → 3 concurrent turns) while doing nothing to protect a 16-core
   * box any more than a 1-core one. Providers' own rate limits and the
   * transient-retry machinery handle 429 pressure.
   */
  private fleetCap(): number {
    const configured = this.config.bots?.maxConcurrent ?? 0;
    if (configured > 0) return configured;
    return 8;
  }

  private journalFor(botId: string): BotJournal {
    let j = this.journals.get(botId);
    if (!j) {
      const manifest = this.store.get(botId);
      const retention = { ...(this.config.bots?.retention ?? {}), ...(manifest?.retention ?? {}) };
      j = new BotJournal(this.store.botDir(botId), retention.journalRotateBytes, retention.journalKeepRotations);
      this.journals.set(botId, j);
    }
    return j;
  }

  private getOrCreateJournal(botId: string): BotJournal {
    return this.journalFor(botId);
  }

  enqueue(botId: string, job: { trigger: BotTrigger; prompt: string; fromBot?: string; source?: { channelType: string; channelId: string }; attempts?: number }): { jobId: string; accepted: boolean; reasonCode?: string } {
    const manifest = this.store.get(botId);
    if (!manifest) return { jobId: '', accepted: false, reasonCode: 'target_unknown' };
    if (!manifest.enabled || this.disabled.has(botId)) return { jobId: '', accepted: false, reasonCode: 'target_disabled' };

    const queue = this.queues.get(botId) ?? [];
    this.queues.set(botId, queue);
    if (queue.length >= MAILBOX_CAPACITY) {
      return { jobId: '', accepted: false, reasonCode: 'queue_full' };
    }
    // Durable-before-ack: the job is persisted (idempotency-deduped) before
    // the caller hears "accepted" — a crash between ack and run loses nothing.
    const durable = this.queue.enqueue({
      id: randomUUID().slice(0, 8),
      botId,
      trigger: job.trigger,
      prompt: job.prompt,
      fromBot: job.fromBot,
      source: job.source,
      attempts: job.attempts ?? 0,
      createdAt: Date.now(),
      idempotencyKey: idempotencyKeyFor(botId, job.trigger, job.prompt, job.fromBot),
    });
    if (durable.duplicated) {
      return { jobId: durable.job.id, accepted: true };
    }
    const id = durable.job.id;
    queue.push({ id, botId, trigger: job.trigger, prompt: job.prompt, fromBot: job.fromBot, source: job.source, createdAt: durable.job.createdAt, attempts: durable.job.attempts });
    this.pump(botId);
    return { jobId: id, accepted: true };
  }

  /**
   * Fleet task dispatch: a delegated TASK from one bot to another (lead →
   * crew, crew → lead). Durable job with the task as the prompt — on
   * completion the result is returned to the sender's mailbox
   * (replyTargetFor), closing the delegation loop.
   */
  dispatchTask(targetBotId: string, fromBot: string, task: string): BotSendResult {
    const result = this.enqueue(targetBotId, { trigger: 'mailbox', prompt: task, fromBot });
    if (!result.accepted) return { accepted: false, reasonCode: result.reasonCode as BotSendResult['reasonCode'] };
    return { accepted: true, jobId: result.jobId };
  }

  /** Fire-and-forget mailbox delivery from another bot. */
  sendToBot(targetBotId: string, fromBot: string, content: string): BotSendResult {
    const manifest = this.store.get(targetBotId);
    if (!manifest) return { accepted: false, reasonCode: 'target_unknown' };
    if (!manifest.enabled || this.disabled.has(targetBotId)) return { accepted: false, reasonCode: 'target_disabled' };

    const box = this.mailboxes.get(targetBotId) ?? [];
    if (box.length >= MAILBOX_CAPACITY) {
      return { accepted: false, reasonCode: 'queue_full' };
    }
    // Durable-before-ack for handoffs too: a bot_send that returns "queued"
    // must survive a crash before the target's next turn drains it.
    this.queue.enqueueMail({ botId: targetBotId, from: fromBot, content, createdAt: Date.now() });
    box.push({ from: fromBot, content });
    this.mailboxes.set(targetBotId, box);

    // If the bot is idle (no running turn, empty job queue), wake it with a
    // mailbox-driven turn so mail is consumed promptly.
    const queue = this.queues.get(targetBotId) ?? [];
    const isRunning = (this.running.get(targetBotId)?.size ?? 0) > 0;
    let jobId: string | undefined;
    if (queue.length === 0 && !isRunning) {
      jobId = randomUUID().slice(0, 8);
      queue.push({ id: jobId, botId: targetBotId, trigger: 'mailbox', prompt: '', createdAt: Date.now(), attempts: 0 });
      this.queues.set(targetBotId, queue);
      this.pump(targetBotId);
    }
    return { accepted: true, jobId };
  }

  /** Poll-and-drain a bot's mailbox (turns); durable rows removed too. */
  drainMailbox(botId: string): BotTurnMail[] {
    const box = this.mailboxes.get(botId) ?? [];
    this.mailboxes.set(botId, []);
    this.queue.drainMail(botId);
    return box;
  }

  peekMailbox(botId: string): BotTurnMail[] {
    return [...(this.mailboxes.get(botId) ?? [])];
  }

  /** Kick the queue: start turns while slots (per-bot and fleet-wide) exist. */
  private pump(botId: string): void {
    const manifest = this.store.get(botId);
    if (!manifest?.enabled || this.disabled.has(botId)) return;
    const today = new Date().toISOString().slice(0, 10);
    const used = this.dailyTokens.get(botId);
    if (used && used.day !== today) {
      this.dailyTokens.delete(botId);
      this.pausedForBudget.delete(botId);
    }
    if (this.pausedForBudget.has(botId)) {
      this.activity.set(botId, 'Paused — daily token budget reached');
      return;
    }
    const queue = this.queues.get(botId) ?? [];
    const running = this.running.get(botId) ?? new Set();
    this.running.set(botId, running);

    const perBotCap = manifest.autonomy?.maxConcurrent ?? 1;

    while (queue.length > 0 && running.size < perBotCap && this.fleetRunningCount() < this.fleetCap()) {
      const job = queue.shift()!;
      void this.executeTurn(job);
    }
  }

  /** Hard daily budget stop: pause (resume next UTC day), never die. */
  private recordBotTokens(botId: string, manifest: BotManifest, tokens: number): void {
    const today = new Date().toISOString().slice(0, 10);
    const entry = this.dailyTokens.get(botId);
    const next = entry && entry.day === today ? entry.tokens + tokens : tokens;
    this.dailyTokens.set(botId, { day: today, tokens: next });
    const cap = manifest.autonomy?.dailyTokenBudget;
    if (cap && next >= cap) {
      this.pausedForBudget.add(botId);
      logger.warn({ botId, used: next, cap }, 'Bot daily token budget reached — pausing until next day');
      void this.alertOwner(botId, `🟡 **${manifest.name}** paused — daily token budget reached (${next} ≥ ${cap}). Resumes tomorrow; raise the cap in bot.yaml if this is too tight.`);
    }
  }

  private fleetRunningCount(): number {
    let total = 0;
    for (const s of this.running.values()) total += s.size;
    return total;
  }

  private async executeTurn(job: BotJob): Promise<void> {
    const { botId } = job;
    const running = this.running.get(botId) ?? new Set();
    this.running.set(botId, running);
    running.add(job.id);
    const controller = new AbortController();
    this.aborts.set(`${botId}:${job.id}`, controller);
    this.activity.set(botId, describeJob(job));

    const manifest = this.store.get(botId);
    if (!manifest) {
      running.delete(job.id);
      return;
    }

    // Lease heartbeat: a turn can outlive LEASE_SECONDS by minutes (long
    // provider calls). Without a heartbeat the 30s due-sweep requeues the
    // STILL-RUNNING job, a duplicate turn starts, and whichever settles
    // first makes the other's settle a silent no-op — the job vanishes
    // from the DLQ and /bots replay reports not_found. A live turn must
    // never expire its lease.
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      this.queue.claim(job.id, LEASE_SECONDS);
      heartbeat = setInterval(() => {
        try { this.queue.heartbeatLease(job.id, LEASE_SECONDS); } catch { /* best effort */ }
      }, (LEASE_SECONDS / 3) * 1000);
      heartbeat.unref?.();
      const turn = this.buildTurn(botId, manifest, job, controller.signal);
      const output = await runBotTurn({
        ...turn.input,
        jobId: job.id,
        onActivity: (ev) => this.emitBotActivity(ev),
      });
      turn.cleanup();

      // Decided up front so the journal row can carry the needs-you flag:
      // a failure that will retry is not an escalation; one headed for the
      // DLQ is (the flag is durable via the row — the constructor rehydrates
      // it from the newest journal row on restart).
      const willRetry = output.status === 'failed' && !!output.reasonCode
        && isTransientFailure(output.reasonCode) && job.attempts + 1 < MAX_TRANSIENT_ATTEMPTS;
      const record: BotRunRecord = {
        runId: job.id,
        botId,
        trigger: job.trigger,
        state: output.status === 'completed' ? 'completed' : output.status,
        startedAt: job.createdAt,
        durationMs: Date.now() - job.createdAt,
        tokensIn: output.tokensIn,
        tokensOut: output.tokensOut,
        summary: output.output.slice(0, 300),
        error: output.error,
        reasonCode: output.reasonCode,
        ...(output.status === 'failed' && !willRetry ? { needsYou: true } : {}),
      };
      this.journalFor(botId).append(record);
      this.lastRun.set(botId, { at: Date.now(), state: record.state });
      this.needsYou.delete(botId);
      this.recordBotTokens(botId, manifest, output.tokensIn + output.tokensOut);

      // Auto-skill synthesis (P2-3): a completed multi-step run is a
      // procedure worth keeping. Fire-and-forget, gated by config.
      if (
        output.status === 'completed'
        && output.toolsUsed.length >= MIN_TOOLS_FOR_SYNTHESIS
        && (this.config.bots as any)?.autoSkill?.enabled
      ) {
        void synthesizeSkill({
          botId,
          botName: manifest.name,
          prompt: job.prompt,
          output: output.output,
          toolsUsed: output.toolsUsed,
          provider: resolveProvider(this.providers, manifest),
          // The synthesized skill lands in the BOT'S OWN library (draft:true),
          // not the global root — it is that bot's learned procedure, usable
          // by it on the next run (runtime invalidated on success).
          skillsRoot: this.store.skillsDir(botId),
        }).then((synth) => { if (synth) this.invalidateRuntime(botId); })
          .catch((err) => logger.warn({ err, botId }, 'Skill synthesis failed'));
      }

      // Transient provider failures retry with backoff, bounded; permanent
      // failures go to the capped DLQ and stop (never silently re-queued — §2.6).
      // Retries requeue the SAME job in place (durable): no settle-then-
      // reenqueue window where a crash would lose the work.
      // Re-entry rides the due-sweep (resumeDueJobs) — the timer only makes
      // it precise; it never pushes a copy of the job itself (duplicate-run
      // race with the periodic sweep).
      if (willRetry) {
        const delay = Math.min(15000, 1000 * 2 ** job.attempts);
        this.queue.retry(job.id, job.attempts + 1, Date.now() + delay);
        logger.info({ botId, jobId: job.id, reasonCode: output.reasonCode, retryIn: delay }, 'Bot turn failed transiently — retrying in place');
        setTimeout(() => this.resumeDueJobs(), delay).unref?.();
      } else if (output.status === 'failed') {
        this.queue.settle(job.id, 'dead', output.reasonCode);
        this.needsYou.add(botId);
        logger.warn({ botId, jobId: job.id, reasonCode: output.reasonCode }, 'Bot turn failed permanently — moved to DLQ (replayable via /bots dlq)');
        await this.alertOwner(botId, `❌ **${manifest.name}** failed permanently [reason: ${output.reasonCode}] — replay with \`/bots replay ${botId} ${job.id}\``);
      } else if (output.status === 'paused') {
        // Step-budget pause: work continues next turn — same job requeues in
        // place (durable), no attempts bump.
        this.queue.retry(job.id, job.attempts, Date.now() + 2000);
        setTimeout(() => this.resumeDueJobs(), 2000).unref?.();
      } else {
        this.queue.settle(job.id, 'done');
      }

      // Deliver the outcome — the bot thread is the ONLY local surface
      // (BOTS-ARCHITECTURE §3.1): the FULL result lands in the BOT'S OWN
      // thread and the CLI session that asked is NOT notified at all — a
      // pointer into the main chat would leak into whatever session is open
      // days later (a routine or retry finishing inside a brand-new session
      // printed bot traffic into the user's regular chat/code). Remote
      // channels (Telegram/web) stay the exception: their user cannot open
      // bot threads, so the full result is delivered in that chat. Halts
      // report too (a stopped run must announce it stopped, §2.6).
      //
      // Mailbox turns deliver too UNLESS the result is addressed to another
      // bot (a delegated task — replyTargetFor routes it to the sender's
      // mailbox below, and the user must not see the internal crew→lead mail
      // twice). A lead's wake after crew results IS a mailbox trigger
      // (sendToBot), and its synthesis is the user-facing outcome of the
      // whole delegation — skipping every mailbox turn left it journaled
      // but never shown.
      if (this.notify && !replyTargetFor(job)) {
        const botThread = `bot:${botId}`;
        const icon = output.status === 'completed' ? '🤖' : output.status === 'failed' ? '❌' : output.status === 'halted' ? '⏹' : '⏸';
        // Full result, matched to the channel's per-message cap (64KB) — the
        // bot thread is the primary delivery surface, so results must arrive
        // complete (tables, code, lists), not sliced at a pointer-era 800.
        const body = output.output.length > BOT_RESULT_DISPLAY_CAP
          ? output.output.slice(0, BOT_RESULT_DISPLAY_CAP) + `\n\n[…output truncated at ${Math.round(BOT_RESULT_DISPLAY_CAP / 1024)}KB — full text in the run transcripts]`
          : output.output;
        const fullText = output.status === 'halted'
          ? `⏹ Run ${job.id} was stopped by you — no further output. It is recorded in \`/bots journal ${botId}\`.`
          : `${icon} (${job.trigger}): ${body}`;
        // 1. Full result → the bot's own thread, always.
        await this.notify('cli', botThread, fullText).catch((e) =>
          logger.warn({ e, botId }, 'Bot result deliver to bot thread failed'));
        // 2. Remote requesting surface only — no CLI pointer, no main-chat
        // traffic, ever.
        const sourceChannelType = job.source?.channelType ?? 'cli';
        const sourceChannelId = job.source?.channelId;
        if (sourceChannelId && sourceChannelId !== botThread && sourceChannelType !== 'cli') {
          await this.notify(sourceChannelType, sourceChannelId, fullText).catch((e) =>
            logger.warn({ e, botId }, 'Bot remote-channel result notify failed'));
        }
      }

      // Fleet delegation loop: a task dispatched by another bot reports its
      // result back to the sender's mailbox (attributed, plain mail — never a
      // task, so results can't ping-pong). Paused runs requeue and report
      // later; the failure/retry machinery above owns transient states.
      const replyTarget = replyTargetFor(job);
      if (replyTarget && (output.status === 'completed' || output.status === 'failed' || output.status === 'halted')) {
        const icon = output.status === 'completed' ? '✅' : output.status === 'failed' ? '❌' : '⏹';
        const reply = output.status === 'completed'
          ? `✅ Task complete (job ${job.id}):\n${output.output.slice(0, 4000)}`
          : output.status === 'failed'
            ? `❌ Task FAILED (job ${job.id})${output.reasonCode ? ` [reason: ${output.reasonCode}]` : ''}: ${(output.error ?? output.output).slice(0, 1000)}`
            : `⏹ Task halted (job ${job.id}) — it was stopped; see /bots journal ${botId}.`;
        const sent = this.sendToBot(replyTarget, botId, reply);
        if (!sent.accepted) {
          logger.warn({ botId, replyTarget, reason: sent.reasonCode }, 'Fleet result reply not delivered');
        }
      }
    } catch (err: any) {
      logger.error({ botId, jobId: job.id, err: err?.message }, 'Bot turn crashed');
      this.queue.settle(job.id, 'dead', 'unknown_error');
      this.needsYou.add(botId);
      void this.alertOwner(botId, `💥 **${botId}** run ${job.id} crashed: ${String(err?.message ?? err).slice(0, 150)} — see journal; replay from DLQ.`);
      this.journalFor(botId).append({
        runId: job.id,
        botId,
        trigger: job.trigger,
        state: 'failed',
        startedAt: job.createdAt,
        durationMs: Date.now() - job.createdAt,
        tokensIn: 0,
        tokensOut: 0,
        error: err?.message,
        reasonCode: 'unknown_error',
        needsYou: true,
      });
      this.needsYou.add(botId);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      running.delete(job.id);
      this.aborts.delete(`${botId}:${job.id}`);
      if (running.size === 0) this.activity.delete(botId);
      // Mail-arrival race: a reply (e.g. a crew's task result) delivered
      // while this turn ran can land AFTER the turn's last mailbox poll —
      // sendToBot saw the bot running and scheduled no wake. Without this,
      // the mail sits unconsumed and the bot idles forever. If mail is
      // pending and nothing is queued or running, schedule a wake turn.
      const manifestNow = this.store.get(botId);
      if (
        (this.running.get(botId)?.size ?? 0) === 0
        && (this.queues.get(botId)?.length ?? 0) === 0
        && this.peekMailbox(botId).length > 0
        && manifestNow?.enabled && !this.disabled.has(botId)
      ) {
        const q = this.queues.get(botId) ?? [];
        q.push({ id: randomUUID().slice(0, 8), botId, trigger: 'mailbox', prompt: '', createdAt: Date.now(), attempts: 0 });
        this.queues.set(botId, q);
        logger.info({ botId, pending: this.peekMailbox(botId).length }, 'Mail arrived mid-turn — scheduling a wake so it is consumed');
      }
      this.pump(botId);
    }
  }

  private userMemoryFor(botId: string, manifest: BotManifest): UserMemoryStore | null {
    if (this.userMemories.has(botId)) return this.userMemories.get(botId) ?? null;
    const factory = this.userMemoryFactory;
    if (!factory) return null;
    let store: UserMemoryStore | null = null;
    try {
      store = factory(botId, manifest);
    } catch (err: any) {
      // Memory is an enhancement, never a hard dependency — a store that
      // fails to build (e.g. no native SQLite) degrades to a stateless bot.
      logger.warn({ botId, err: err?.message }, 'Bot memory store build failed — running stateless');
    }
    this.userMemories.set(botId, store);
    return store;
  }

  private buildTurn(botId: string, manifest: BotManifest, job: BotJob, signal: AbortSignal): { input: Parameters<typeof runBotTurn>[0]; cleanup: () => void } {
    const { registry, tools, skillsPrompt } = this.getOrCreateRuntime(botId, manifest);
    const userMemory = this.userMemoryFor(botId, manifest);

    const mail: BotTurnMail[] = [];
    // Deliveries from other bots arrive via the mailbox; drain at turn start.
    const pending = this.drainMailbox(botId);
    mail.push(...pending);

    return {
      input: {
        manifest,
        trigger: job.trigger,
        prompt: job.prompt,
        persona: this.store.readPersona(botId),
        mail,
        pollMail: () => this.drainMailbox(botId),
        sandbox: { workspace: this.store.sandboxDir(botId), shared: this.store.sharedSandboxDir() },
        skillsPrompt,
        fleet: this.fleetContext(botId, manifest),
        capabilities: registry,
        tools,
        userMemory,
        provider: resolveProvider(this.providers, manifest),
        tokenBudget: this.tokenBudget,
        abortSignal: signal,
      },
      cleanup: () => { /* per-bot registries are persistent, nothing to restore */ },
    };
  }

  /** Fleet context for the turn prompt (undefined for solo bots). */
  private fleetContext(botId: string, manifest: BotManifest) {
    if (manifest.fleetRole === 'lead') {
      return {
        role: 'lead' as const,
        leadName: manifest.parent ? this.store.get(manifest.parent)?.name : undefined,
        crew: this.store.crewOf(botId).map(c => ({
          id: c.id,
          name: c.name,
          description: c.description,
          state: this.getStatusSummaries().find(s => s.id === c.id)?.state ?? 'idle',
        })),
        maxCrew: this.maxCrew(),
      };
    }
    if (manifest.parent) {
      return {
        role: 'crew' as const,
        leadName: this.store.get(manifest.parent)?.name,
        crew: [],
        maxCrew: 0,
      };
    }
    return undefined;
  }

  private getOrCreateRuntime(botId: string, manifest: BotManifest): { registry: CapabilityRegistry; tools: Record<string, Tool>; skillsPrompt: string } {
    // Staleness check: the toolset bakes in the manifest (tools.deny/allow,
    // fleetRole) and permissions.yaml (path scopes). Hand-edits to those files
    // must apply on the next turn — the manifest cache makes identity a
    // reliable change signal (same object unless the file changed on disk).
    const permsFile = join(this.store.botDir(botId), BOT_PERMISSIONS_FILENAME);
    let permsMtimeMs = 0;
    try { permsMtimeMs = statSync(permsFile).mtimeMs; } catch { /* no file yet */ }
    const cached = this.registries.get(botId);
    if (cached && cached.manifest === manifest && cached.permsMtimeMs === permsMtimeMs) {
      return cached as { registry: CapabilityRegistry; tools: Record<string, Tool>; skillsPrompt: string };
    }
    // Skill access: global (native) library + the bot's own skills dir
    // (auto-synthesized + hand-authored; own-dir names win on collision).
    // Default root = <botsRoot>/../skills — ~/.mercury/skills in production,
    // tmp-local in tests.
    let skillLoader: SkillLoader | undefined;
    let skillsPrompt = '';
    try {
      skillLoader = new SkillLoader(this.skillsRoot ?? resolve(this.store.botsRoot, '..', 'skills'), {
        extraDirs: [this.store.skillsDir(botId)],
        seedDefaults: false,
      });
      skillLoader.discover();
      skillsPrompt = skillLoader.getSkillSummariesText();
    } catch (err: any) {
      logger.warn({ botId, err: err?.message }, 'Bot skill loader unavailable — continuing without skills');
    }
    const registry = createBotCapabilityRegistry({
      botId,
      manifest,
      botDir: this.store.botDir(botId),
      // Single source of truth; also materializes fleet inheritance (a crew
      // without its own file gets its lead's copied in verbatim).
      permissions: this.store.ensurePermissions(botId),
      skillLoader,
      // Built-in work areas: private sandbox + fleet-shared folder (rw+x,
      // implicit — no permission ask).
      sandbox: { workspace: this.store.sandboxDir(botId), shared: this.store.sharedSandboxDir() },
      userMemory: this.userMemoryFor(botId, manifest),
      config: this.config,
    });
    // Filter FIRST (strips interactive/global-mutation tools and applies the
    // permissions.yaml tool gate), THEN add the bot-specific tools —
    // otherwise the filter would strip them again.
    const filtered = filterBotTools({ ...registry.getTools() }, manifest, this.store.ensurePermissions(botId));
    const effectiveRoster = this.effectiveRoster(botId, manifest);
    if (effectiveRoster.length > 0) {
      filtered.bot_send = createBotSendTool(this, botId, effectiveRoster) as Tool;
    }
    // bot_deliver: implicit lifecycle op — every bot can move a finished
    // artifact out of its writable roots into the owner-curated outputs zone
    // (exempt from the retention janitor).
    filtered.bot_deliver = createBotDeliverTool(this, botId) as Tool;
    // Fleet tools for leads: monitor the crew, spawn/retire within caps.
    if (manifest.fleetRole === 'lead') {
      filtered.fleet_status = createFleetStatusTool(this, botId);
      if (this.config.bots?.fleets?.allowLeadSpawn !== false) {
        const fleet = createBotSpawnTool(this, botId);
        filtered.bot_spawn = fleet.spawn;
        filtered.bot_retire = fleet.retire;
      }
    }
    // bot_schedule: bots can schedule their own future runs (durable,
    // capped) when the main scheduler is wired.
    if (this.scheduler) {
      filtered.bot_schedule = createBotScheduleTool(this.scheduler, botId);
    }
    this.registries.set(botId, { registry, tools: filtered, skillsPrompt, manifest, permsMtimeMs });
    return { registry, tools: filtered, skillsPrompt };
  }

  /**
   * Comms roster = explicit canMessage ∪ fleet relations (lead ↔ own crew).
   * Derived per registry build; excludes the bot itself.
   */
  private effectiveRoster(botId: string, manifest: BotManifest): string[] {
    const roster = new Set(manifest.comms?.canMessage ?? []);
    if (manifest.fleetRole === 'lead') {
      for (const crew of this.store.crewOf(botId)) roster.add(crew.id);
    }
    // A mid-level lead (crew of a parent AND lead of its own crew) talks both ways.
    if (manifest.parent) {
      roster.add(manifest.parent);
    }
    roster.delete(botId);
    return [...roster];
  }

  // ---- fleet management (shared by onboarding, lead tools, API) -----------

  /** Max crew per lead — CrewAI guidance: 3-6 for delegation accuracy. */
  maxCrew(): number {
    return this.config.bots?.fleets?.maxCrew ?? 6;
  }

  /** The bot's provider (public for fleet tools — persona building on spawn). */
  resolveProviderFor(botId: string): ReturnType<typeof resolveProvider> {
    const manifest = this.store.get(botId);
    return resolveProvider(this.providers, manifest ?? { id: botId, name: botId, enabled: true } as BotManifest);
  }

  /**
   * Add a crew member to a lead: validates the relationship, enforces the
   * crew cap, creates with fail-closed defaults + comms back to the lead.
   * Persona refinement (builder) is the caller's concern (async provider
   * call); addCrew writes the persona text it is given.
   */
  /** Promote a bot to fleet lead (the cockpit's "lead a fleet" paths). Idempotent. */
  promoteLead(botId: string): { ok: boolean } {
    const manifest = this.store.get(botId);
    if (!manifest) return { ok: false };
    if (manifest.fleetRole !== 'lead') {
      this.store.update(botId, m => { m.fleetRole = 'lead'; });
      this.invalidateRuntime(botId);
      logger.info({ botId }, 'Bot promoted to fleet lead');
    }
    return { ok: true };
  }

  /**
   * Fleet auto-build (the TUI onboarding's "auto" path, shared with the web
   * cockpit): one LLM call proposes 3-5 matched specialists, each created
   * through the standard addCrew path. DETACHED — the caller hears 202
   * immediately; per-member progress rides `hooks`, and failures degrade to
   * "lead with an empty crew" guidance, never an error state.
   */
  autoCrew(botId: string, hooks: { onMember?: (name: string, id: string) => void; onError?: (msg: string) => void; onDone?: (created: number) => void } = {}): void {
    void (async () => {
      try {
        const manifest = this.store.get(botId);
        if (!manifest) return;
        if (manifest.fleetRole !== 'lead') this.promoteLead(botId);
        const persona = this.store.readPersona(botId);
        const leadDescription = manifest.description ?? '';
        const proposals = await proposeCrew(manifest.name, leadDescription, persona, resolveProvider(this.providers, manifest), this.maxCrew());
        if (proposals.length === 0) {
          hooks.onError?.("Crew proposal unavailable (provider) — the lead has an empty crew. Add specialists yourself, or give the lead a task and tell it to hire its own crew (bot_spawn).");
          return;
        }
        let created = 0;
        for (const p of proposals) {
          const result = this.addCrew(botId, p);
          if (result.ok) {
            // A duplicate (already on the crew) is success without growth —
            // replayed builds converge instead of inflating the roster.
            if (!result.duplicate) {
              created++;
              hooks.onMember?.(p.name, result.manifest.id);
            }
          } else {
            hooks.onError?.(`Crew member ${p.name} (${p.id}): ${result.error}`);
          }
        }
        hooks.onDone?.(created);
      } catch (err: any) {
        hooks.onError?.(`Fleet auto-build failed: ${err?.message ?? err} — the lead has an empty crew; add specialists yourself later.`);
      }
    })();
  }

  addCrew(leadId: string, spec: { id: string; name: string; description?: string; persona?: string }): { ok: true; manifest: BotManifest; duplicate?: boolean } | { ok: false; error: string } {
    const lead = this.store.get(leadId);
    if (!lead) return { ok: false, error: `No bot "${leadId}"` };
    if (lead.fleetRole !== 'lead') {
      return { ok: false, error: `**${lead.name}** is not a fleet lead — promote it with \`/bots promote ${leadId}\` first` };
    }
    // Multi-level guard: no cycles, bounded depth (v1 supports 3 levels —
    // e.g. CEO → Engineering Lead → Backend). Walk the lead's parent chain.
    let ancestor: string | undefined = leadId;
    let depth = 0;
    const seen = new Set<string>();
    while (ancestor) {
      if (seen.has(ancestor)) return { ok: false, error: 'Fleet cycle detected in parent chain' };
      seen.add(ancestor);
      if (ancestor === spec.id.toLowerCase()) {
        return { ok: false, error: `Cannot add **${spec.id}** — it would become its own ancestor` };
      }
      ancestor = this.store.get(ancestor)?.parent;
      if (++depth > 3) return { ok: false, error: 'Fleet nesting is capped at 3 levels' };
    }
    // Replay-safety BEFORE the crew cap: a re-run "build the crew" turn
    // (durable job replayed after an interrupted session) re-derives its
    // specs through the LLM and can land on a DIFFERENT id for a specialist
    // the fleet already has — the id guard alone let the roster grow a
    // duplicate crew per replay. A spec matching an id or the normalized
    // NAME of a member already under THIS lead is already-staffed: success
    // without creation. Only foreign ids / names from another lead are an
    // error. Duplicates skip the cap check — a full fleet stays full.
    const id = spec.id.toLowerCase();
    let existing: BotManifest | null = this.store.exists(id) ? this.store.get(id) : null;
    if (!existing) {
      const nameKey = (spec.name ?? '').trim().toLowerCase();
      if (nameKey) {
        existing = this.store.crewOf(leadId).find(m => m.name.trim().toLowerCase() === nameKey) ?? null;
      }
    }
    if (existing) {
      if (existing.fleetRole === 'crew' && existing.parent === leadId) {
        return { ok: true, manifest: existing, duplicate: true };
      }
      return { ok: false, error: `Bot "${id}" already exists` };
    }
    const crew = this.store.crewOf(leadId);
    const cap = this.maxCrew();
    if (crew.length >= cap) {
      return { ok: false, error: `Fleet is at the crew cap (${crew.length}/${cap}) — retire a member first or raise BOTS_FLEET_MAX_CREW` };
    }
    const manifest = this.store.create({
      id,
      name: spec.name,
      description: spec.description,
      persona: spec.persona,
      manifest: { fleetRole: 'crew', parent: leadId, comms: { canMessage: [leadId] } },
    });
    // Inheritance at birth: the crew starts on its lead's permissions,
    // copied verbatim (its own file from now on — edits diverge it).
    this.store.ensurePermissions(manifest.id);
    this.invalidateRuntime(leadId); // lead's roster + fleet prompt change
    logger.info({ leadId, crewId: spec.id }, 'Crew member added to fleet');
    return { ok: true, manifest };
  }

  /**
   * Background persona refinement — bot_spawn used to await refinePersona
   * (up to two serial LLM calls) inside the lead's TOOL EXECUTION, stalling
   * the lead's turn once per spawned crew member. The member starts on the
   * lead-written persona immediately and the refined file overwrites it
   * whenever it lands; every later turn picks it up (buildTurn re-reads the
   * persona file, so no runtime invalidation is required). Failure keeps the
   * raw persona — refinePersona's own contract.
   */
  schedulePersonaRefinement(botId: string, name: string, rawPersona: string): void {
    const manifest = this.store.get(botId);
    if (!manifest) return;
    const provider = resolveProvider(this.providers, manifest);
    void refinePersona(rawPersona, name, provider)
      .then((refined) => {
        if (!refined) return;
        try {
          this.store.writePersona(botId, refined);
          logger.info({ botId }, 'Background persona refinement landed');
        } catch (err: any) {
          logger.warn({ botId, err: err?.message }, 'Background persona write failed');
        }
      })
      .catch((err) => logger.warn({ botId, err: err?.message }, 'Background persona refinement failed'));
  }

  /** Remove a crew member (lead's own child only) and record it on the lead. */
  async removeCrew(leadId: string, crewId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const crew = this.store.get(crewId);
    if (!crew) return { ok: false, error: `No bot "${crewId}"` };
    if (crew.parent !== leadId) return { ok: false, error: `**${crewId}** is not crew of **${leadId}**` };
    await this.delete(crewId);
    this.invalidateRuntime(leadId);
    this.journalFor(leadId).append({
      runId: randomUUID().slice(0, 8),
      botId: leadId,
      trigger: 'chat',
      state: 'completed',
      startedAt: Date.now(),
      durationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      summary: `Retired crew member "${crew.name}" (${crewId})`,
    });
    logger.info({ leadId, crewId }, 'Crew member retired');
    return { ok: true };
  }

  invalidateRuntime(botId: string): void {
    this.registries.delete(botId);
  }

  /**
   * Full lifecycle delete: halt, purge durable queue state (jobs/mail/DLQ),
   * remove scheduler routines (zombie cron would fire forever), drop the
   * profile dir, and clear every in-memory cache — so a re-created bot with
   * the same id starts clean (no stale mail or resurrected routines).
   */
  async delete(botId: string): Promise<void> {
    await this.halt(botId);
    // Fleet cascade: deleting a lead deletes its crew — recursively (a crew
    // member may itself be a mid-level lead). Each member gets the FULL
    // lifecycle delete (halt, purge queue/mail/DLQ, remove routines) because
    // those live outside the profile dir and would otherwise outlive the bot.
    // The filesystem half is free: crew profiles nest inside the lead's dir,
    // so the lead's store.delete() removes the whole tree — which is also why
    // this cascades BEFORE the lead's own profile is wiped below.
    if (this.store.isLead(botId)) {
      for (const crew of this.store.crewOf(botId)) {
        logger.info({ leadId: botId, crewId: crew.id }, 'Fleet lead deleted — cascading to crew member');
        await this.delete(crew.id);
      }
    }
    // Scheduler routines (bot:<id>:*) — both bot.yaml routines and
    // bot_schedule self-created ones; they must never fire again.
    if (this.scheduler) {
      for (const m of this.scheduler.getManifests()) {
        if (m.botId === botId) this.scheduler.removeTask(m.id);
      }
      this.scheduler.persistSchedules();
    }
    this.queue.purgeBot(botId);
    this.store.delete(botId);
    this.registries.delete(botId);
    this.journals.delete(botId);
    this.userMemories.delete(botId);
    this.queues.delete(botId);
    this.mailboxes.delete(botId);
    this.dailyTokens.delete(botId);
    this.activity.delete(botId);
    this.lastRun.delete(botId);
    this.needsYou.delete(botId);
    this.pausedForBudget.delete(botId);
    this.held.delete(botId);
    logger.info({ botId }, 'Bot deleted: queue/mail/DLQ purged, routines removed');
  }

  /**
   * One-shot fleet layout migration (startup, before routines register):
   * the physical layout must mirror the manifest hierarchy — crew profiles
   * nested under their lead's dir — so the delete cascade can never leave a
   * crew behind. Two rules, both idempotent:
   *  1. A crew bot whose lead no longer exists is cascade-deleted (it
   *     outlived its lead only because a pre-cascade delete created it).
   *  2. An existing crew profile still flat at the root moves under its
   *     lead's directory (onRelocate refreshes journals/runtime caches).
   */
  async migrateFleetLayout(): Promise<void> {
    for (const m of this.store.list()) {
      if (!m.parent) continue;
      if (this.store.exists(m.parent)) {
        this.store.relocateToParent(m);
      } else {
        logger.warn({ botId: m.id, parent: m.parent }, 'Crew bot outlived its lead — cascading the deletion');
        await this.delete(m.id);
      }
    }
  }

  /**
   * Permission consolidation to a SINGLE source of truth (startup): every
   * bot ends with exactly one permissions.yaml and a persona that carries
   * character only.
   *  1. Inheritance backfill: a crew without its own file gets its lead's
   *     copied verbatim; a solo without one gets the fail-closed default.
   *  2. Legacy bot.yaml tools block → permissions.yaml (the manifest copy
   *     stays as a readable fallback but no longer decides anything).
   *  3. Persona `## Access` grants → merged into permissions.yaml paths,
   *     then stripped from the persona file (permissions never live there).
   */
  async migratePermissions(): Promise<void> {
    for (const m of this.store.list()) {
      try {
        const perms = this.store.ensurePermissions(m.id);
        // 2. Legacy tool gate out of bot.yaml.
        const legacyTools = m.tools;
        if (legacyTools && ((legacyTools.allow?.length ?? 0) > 0 || (legacyTools.deny?.length ?? 0) > 0) && !perms.tools) {
          this.store.writePermissions(m.id, { ...this.store.readPermissions(m.id), tools: legacyTools });
          logger.info({ botId: m.id }, 'Migrated bot.yaml tools gate into permissions.yaml (single source of truth)');
        }
        // 3. Persona Access grants out of the persona.
        const persona = this.store.readPersona(m.id);
        const grants = parsePersonaAccess(persona);
        if (grants.length > 0) {
          const current = this.store.readPermissions(m.id);
          this.store.writePermissions(m.id, { ...current, paths: mergePathScopes(current.paths, grants) });
          this.store.writePersona(m.id, stripPersonaAccessSection(persona));
          logger.info({ botId: m.id, grants: grants.length }, 'Migrated persona Access grants into permissions.yaml; persona is character-only now');
        }
      } catch (err: any) {
        logger.warn({ botId: m.id, err: err?.message }, 'Permission migration failed for bot — leaving as-is');
      }
    }
  }

  /**
   * Register every enabled bot's cron routines with the main Scheduler
   * (manifest id `bot:<botId>:<name>`). Bot runs fire on the cron lane and
   * route to the bot lane, never through Agent.processQueue. Idempotent:
   * the Scheduler replaces existing tasks by id.
   */
  registerRoutines(scheduler: { addPersistedTask(m: any): void }): void {
    let count = 0;
    for (const manifest of this.store.list()) {
      if (!manifest.enabled) continue;
      for (const routine of manifest.schedules ?? []) {
        if (!isValidCronExpression(routine.cron)) {
          logger.warn({ botId: manifest.id, cron: routine.cron }, 'Invalid cron expression — routine skipped');
          continue;
        }
        scheduler.addPersistedTask({
          id: `bot:${manifest.id}:${routine.name}`,
          cron: routine.cron,
          description: routine.name,
          prompt: routine.prompt,
          botId: manifest.id,
          createdAt: new Date().toISOString(),
        });
        count++;
      }
    }
    if (count > 0) {
      logger.info({ routines: count }, 'Bot routines registered');
    }
  }

  // ---- control plane -------------------------------------------------------

  async halt(botId: string, jobId?: string): Promise<boolean> {
    const running = this.running.get(botId);
    const hadRunning = !!running && running.size > 0;
    for (const id of running ?? []) {
      if (jobId && id !== jobId) continue;
      this.aborts.get(`${botId}:${id}`)?.abort();
    }
    // Queued-but-not-started jobs leave the in-memory lane; their durable rows
    // stay pending, so /bots start (or a restart) can resume them — stop never
    // silently destroys queued work (§2.7 control plane).
    this.queues.set(botId, jobId ? (this.queues.get(botId) ?? []).filter(j => j.id !== jobId) : []);
    return hadRunning;
  }

  async haltAll(): Promise<void> {
    for (const [botId] of this.running) {
      await this.halt(botId);
    }
  }

  /**
   * User-facing stop: abort the running turn(s) AND hold queued work. Held
   * jobs stay durable-pending (survive a restart); the passive due-sweep
   * skips held bots, so nothing resumes until /bots start. Explicit new
   * triggers (send/mail/cron) still work — the bot is stopped, not disabled.
   * FLEET: stopping a lead stops its crew too — recursively (a crew member
   * may be a mid-level lead). Every stopped member's jobs are held the same
   * durable way; /bots start on the lead resumes the whole subtree.
   */
  async stop(botId: string): Promise<{ halted: boolean; heldJobs: number; crewStopped: number }> {
    let heldJobs = (this.queues.get(botId) ?? []).length;
    let halted = await this.halt(botId);
    this.held.add(botId);
    let crewStopped = 0;
    if (this.store.isLead(botId)) {
      for (const crew of this.store.crewOf(botId)) {
        const r = await this.stop(crew.id);
        halted = halted || r.halted;
        heldJobs += r.heldJobs;
        crewStopped += 1 + r.crewStopped;
      }
    }
    if (heldJobs > 0) {
      logger.info({ botId, heldJobs, crewStopped }, 'Bot stopped — queued jobs held (resumable via /bots start)');
    }
    return { halted, heldJobs, crewStopped };
  }

  /**
   * User-facing resume (the counterpart of stop): clear the stop-hold,
   * re-enter held/pending durable jobs, and kick the queue. A disabled bot
   * is enabled first — "start" is unambiguous. Safe on an already-running bot.
   * FLEET: starting a lead resumes its crew subtree too (recursively) —
   * except crew the user individually disabled, which stay off.
   */
  start(botId: string): { resumed: number } {
    const manifest = this.store.get(botId);
    if (!manifest) throw new Error(`Bot "${botId}" does not exist`);
    this.held.delete(botId);
    let resumed = this.rehydratePending(botId);
    if (!manifest.enabled || this.disabled.has(botId)) {
      this.setEnabled(botId, true); // persists enabled + pumps
    } else {
      this.pump(botId);
    }
    if (this.store.isLead(botId)) {
      for (const crew of this.store.crewOf(botId)) {
        const m = this.store.get(crew.id);
        if (!m?.enabled || this.disabled.has(crew.id)) continue; // explicitly disabled crew stay off
        this.held.delete(crew.id);
        resumed += this.rehydratePending(crew.id);
        this.pump(crew.id);
        resumed += this.start(crew.id).resumed;
      }
    }
    return { resumed };
  }

  /** Pull durable pending jobs for a bot back into the in-memory queue. */
  private rehydratePending(botId: string): number {
    const pending = this.queue.pendingJobs(botId);
    if (pending.length === 0) return 0;
    const q = this.queues.get(botId) ?? [];
    const running = this.running.get(botId) ?? new Set();
    let added = 0;
    for (const job of pending) {
      if (q.some(j => j.id === job.id) || running.has(job.id)) continue;
      q.push({
        id: job.id, botId, trigger: job.trigger, prompt: job.prompt,
        fromBot: job.fromBot, source: job.source, createdAt: job.createdAt, attempts: job.attempts,
      });
      added++;
    }
    if (added > 0) {
      this.queues.set(botId, q);
      logger.info({ botId, resumed: added }, 'Re-entered pending bot jobs (explicit resume)');
    }
    return added;
  }

  /** Fire a bot's configured routine immediately, or send a bare wake turn. */
  runNow(botId: string, routineName?: string): { accepted: boolean; jobId?: string; reasonCode?: string } {
    const manifest = this.store.get(botId);
    if (!manifest) return { accepted: false, reasonCode: 'target_unknown' };
    if (routineName) {
      const routine = (manifest.schedules ?? []).find(r => r.name.toLowerCase() === routineName.toLowerCase());
      if (!routine) return { accepted: false, reasonCode: 'routine_unknown' };
      return this.enqueue(botId, { trigger: 'cron', prompt: routine.prompt });
    }
    return this.enqueue(botId, { trigger: 'chat', prompt: WAKE_PROMPT });
  }

  setEnabled(botId: string, enabled: boolean): void {
    if (enabled) {
      this.disabled.delete(botId);
      this.store.setEnabled(botId, true);
      this.pump(botId);
    } else {
      this.disabled.add(botId);
      void this.halt(botId);
      this.store.setEnabled(botId, false);
    }
    this.invalidateRuntime(botId);
  }

  // ---- observation ---------------------------------------------------------

  getStatusSummaries(): BotStatusSummary[] {
    return this.store.list().map((m) => {
      const running = this.running.get(m.id);
      const queue = this.queues.get(m.id) ?? [];
      const last = this.lastRun.get(m.id);
      let state: BotLiveState = 'idle';
      if (!m.enabled || this.disabled.has(m.id)) state = 'disabled';
      else if (this.pausedForBudget.has(m.id)) state = 'paused';
      else if ((running?.size ?? 0) > 0) state = 'running';
      else if (queue.length > 0) state = 'queued';
      return {
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        state,
        activity: this.activity.get(m.id),
        lastRunAt: last?.at,
        lastRunState: last?.state,
        needsYou: this.needsYou.has(m.id),
        fleetRole: m.fleetRole,
        parent: m.parent,
        crewWorking: m.fleetRole === 'lead'
          ? this.store.crewOf(m.id).filter(c => (this.running.get(c.id)?.size ?? 0) > 0).length
          : undefined,
      };
    });
  }

  getJournal(botId: string, limit = 20): BotRunRecord[] {
    return this.journalFor(botId).read(botId, limit);
  }

  getDlq(botId?: string): DurableBotJob[] {
    return this.queue.listDlq(botId);
  }

  /** Re-run a dead-lettered job: remove it from the DLQ and re-enqueue fresh. */
  replayDlq(botId: string, jobId: string): { accepted: boolean; jobId?: string; reasonCode?: string } {
    // Look up WITHOUT removing first: a bot-id mismatch must not destroy the
    // DLQ entry (the old remove-then-check permanently deleted real work and
    // then reported not_found).
    const entry = this.queue.peekDlq(jobId);
    if (!entry || entry.botId !== botId) return { accepted: false, reasonCode: 'not_found' };
    this.queue.removeFromDlq(jobId);
    return this.enqueue(botId, {
      trigger: entry.trigger,
      prompt: entry.prompt,
      fromBot: entry.fromBot,
      source: entry.source,
      attempts: 0,
    });
  }

  getStorage(): Array<{ id: string; bytes: number; journalBytes: number }> {
    return this.store.usage();
  }

  getQueuedCount(botId: string): number {
    return (this.queues.get(botId) ?? []).length;
  }

  /** Resolve a bot by id or case-insensitive name (for @mention routing). */
  resolveBotId(nameOrId: string): string | null {
    const needle = nameOrId.toLowerCase();
    for (const m of this.store.list()) {
      if (m.id === needle || m.name.toLowerCase() === needle) return m.id;
    }
    return null;
  }

  /**
   * Compact bots section for the MAIN agent's system prompt: without it the
   * conversational agent is blind to the bot fleet — it cannot answer "what
   * do my bots do" or hand a task to the right specialist. Kept to a few
   * lines per bot so the token cost stays trivial.
   */
  getSystemPromptSection(): string {
    const summaries = this.store.list();
    if (summaries.length === 0) {
      // Empty fleet: no prompt section at all — zero-bots users must see
      // zero prompt/token drift (review A1).
      return '';
    }
    const lines: string[] = [
      '\n\nMercury Bots — the user maintains these persistent specialist agents (each has its own persona, model, memory, and permissions; they run OUTSIDE this conversation):',
    ];
    for (const m of summaries) {
      const state = this.running.get(m.id)?.size ? 'running' : ((this.queues.get(m.id)?.length ?? 0) > 0 ? 'queued' : (m.enabled ? 'idle' : 'disabled'));
      const desc = m.description ? ` — ${m.description}` : '';
      const fleetTag = m.fleetRole === 'lead' ? ' [fleet lead 👑]' : m.fleetRole === 'crew' ? ` [crew of ${m.parent}]` : '';
      lines.push(`- **${m.name}** (\`${m.id}\`)${desc}${fleetTag} [${state}]`);
    }
    lines.push(`Bot control (never route bot work through this main conversation):
- \`/bot <id> <message>\` or \`@<id> <message>\` — dispatch a task to a bot; the result lands ONLY in the bot's own thread (\`/bots open <id>\`), never in this chat.
- \`/bots open <id>\` — open the bot's own chat; \`/bots\` — roster with live states.
- \`/bots create <id> "Name" "Description"\` — onboard; \`/bots persona <id> <text>\` — set its character.
- \`/bots export <id> [path]\` — shareable bundle (manifests + personas + permissions + skills; a lead's bundle carries its whole crew); \`/bots import <path>\` — recreate bots from a bundle (imported bots start disabled). Sandbox, journals, and .env never travel.
- \`/bots journal <id>\` — recent runs; \`/bots dlq\` — failed jobs (replayable); \`/bots stop|start|enable|disable <id>\`; \`/bots run <id> [routine]\` — fire a routine now (or a bare wake).
- Bots share data through the fleet-shared folder (\`${this.store.sharedSandboxDir()}\`); each also has a private sandbox next to its persona. Their outputs land in their own threads.
- The dispatch_bot tool lets you hand a task to a bot mid-conversation and continue talking; the result is delivered when the bot finishes.`);
    return lines.join('\n');
  }

  /**
   * Release timers and native queue handles. Idempotent — safe to call twice.
   * Teardown MUST run this before deleting the bots root: on Windows an open
   * SQLite handle keeps queue.db locked and its directory impossible to
   * remove (EBUSY). Wired into the process shutdown and every test teardown.
   */
  dispose(): void {
    if (this.dueTimer) {
      clearInterval(this.dueTimer);
      this.dueTimer = undefined;
    }
    this.queue.close();
  }

  /**
   * bot_deliver: move a finished artifact out of the bot's writable areas
   * (its private sandbox or the fleet-shared folder) into the owner-curated
   * `outputs/<botId>/` zone — exempt from the retention janitor. Only files
   * from the bot's OWN writable roots travel (containment is enforced); the
   * source is removed on success (a move, not a copy — the shared surface
   * stays lean by construction).
   */
  deliver(botId: string, filePath: string, rename?: string): { accepted: boolean; path?: string; reasonCode?: string } {
    if (!this.store.get(botId)) return { accepted: false, reasonCode: 'target_unknown' };
    const candidate = resolve(filePath.replace(/^~(?=$|\/|\\)/, process.env.HOME || '~'));
    const allowedBases = [this.store.sharedSandboxDir(), this.store.sandboxDir(botId)];
    const inside = allowedBases.some((base) => {
      const rel = relative(resolve(base), candidate);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    });
    if (!inside || !existsSync(candidate) || !statSync(candidate).isFile()) {
      return { accepted: false, reasonCode: 'outside_sandbox' };
    }
    const outputsDir = join(this.store.outputsDir(), botId);
    mkdirSync(outputsDir, { recursive: true });
    // Default name keeps the FULL basename — the extension is part of the
    // artifact (a report.md stayed .md; the stem-only default silently
    // stripped it). `saveAs` is honored as written; dedupe inserts the -N
    // before whatever extension remains.
    const ext = extname(rename || basename(candidate));
    const stem = basename(rename || basename(candidate), ext);
    const requested = (stem)
      .replace(/[ <>:"/\\|?*]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'output';
    const finalExt = ext;
    let dest = join(outputsDir, `${requested}${finalExt}`);
    for (let i = 2; existsSync(dest); i++) {
      dest = join(outputsDir, `${requested}-${i}${finalExt}`);
    }
    try {
      renameSync(candidate, dest);
    } catch {
      // Cross-device fallback: copy then remove the source.
      try {
        copyFileSync(candidate, dest);
        unlinkSync(candidate);
      } catch {
        return { accepted: false, reasonCode: 'move_failed' };
      }
    }
    logger.info({ botId, dest }, 'Bot delivered a final artifact');
    // The deliverable moment is the event the owner reacts to: broadcast it
    // on the activity bus so the CLI bot-thread region, the /bots roster and
    // the web SSE feed all announce the artifact live.
    this.emitBotActivity({
      botId,
      jobId: '',
      kind: 'tool',
      label: `Delivered ${basename(dest, extname(dest))}${extname(dest)}`,
      detail: dest,
      stepIndex: 0,
      elapsedMs: 0,
      status: 'done',
    });
    return { accepted: true, path: dest };
  }

  /**
   * Owner-curated deliverables (bot_deliver → outputs/<botId>/). Read-only
   * views for the web cockpit: list with newest first; read (text preview,
   * 64KB cap) and deletes are containment-guarded — nothing outside the
   * bot's own outputs zone is addressable.
   */
  listDeliverables(botId?: string): Array<{ botId: string; name: string; bytes: number; mtimeMs: number }> {
    const root = this.store.outputsDir();
    if (!existsSync(root)) return [];
    const bots = botId
      ? [botId]
      : readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    const out: Array<{ botId: string; name: string; bytes: number; mtimeMs: number }> = [];
    for (const bot of bots) {
      const dir = join(root, bot);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name)) {
        try {
          const stat = statSync(join(dir, name));
          out.push({ botId: bot, name, bytes: stat.size, mtimeMs: stat.mtimeMs });
        } catch { /* raced a concurrent delete — skip */ }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** Contained path resolution for deliverable access; null when it escapes. Public for the web API's byte-exact download route. */
  deliverableFile(botId: string, name: string): string | null {
    const dir = join(this.store.outputsDir(), botId);
    const candidate = resolve(dir, name);
    const rel = relative(dir, candidate);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    return candidate;
  }

  readDeliverable(botId: string, name: string, maxBytes = 64 * 1024): { found: boolean; preview?: string; truncated?: boolean } {
    const file = this.deliverableFile(botId, name);
    if (!file || !existsSync(file)) return { found: false };
    const buf = readFileSync(file);
    return {
      found: true,
      preview: buf.subarray(0, maxBytes).toString('utf-8'),
      truncated: buf.length > maxBytes,
    };
  }

  deleteDeliverable(botId: string, name: string): { ok: boolean } {
    const file = this.deliverableFile(botId, name);
    if (!file || !existsSync(file)) return { ok: false };
    unlinkSync(file);
    return { ok: true };
  }

  /**
   * Retention janitor sweep: files in the fleet-shared folder cool down into
   * `_shared/.archive/<yyyy-mm>/` past the hot window, and the archive
   * expires after the archive window — the working surface stays small while
   * an incorrectly aged-out file stays recoverable for a month.
   */
  sweepRetention(): void {
    const sandbox = this.config.bots?.retention?.sandboxJanitor;
    if (sandbox?.enabled === false) return;
    const result = sweepSharedSandbox(this.store.botsRoot, {
      hotDays: sandbox?.hotDays ?? 7,
      archiveDays: sandbox?.archiveDays ?? 30,
    });
    const touched = result.moved.length + result.deleted.length;
    if (touched > 0 || result.errors.length > 0) {
      logger.info(
        { moved: result.moved.length, deleted: result.deleted.length, kept: result.kept, errors: result.errors },
        'Sandbox retention sweep',
      );
    }
  }
}

function resolveProvider(providers: ProviderRegistry, manifest: BotManifest) {
  const requested = manifest.model?.provider;
  const provider = requested ? providers.get(requested) : undefined;
  if (provider) return provider;
  if (requested) {
    logger.warn({ botId: manifest.id, requested }, 'Bot provider not registered — falling back to default');
  }
  return providers.getDefault();
}

function describeJob(job: BotJob): string {
  switch (job.trigger) {
    case 'chat': return job.prompt ? `Responding: ${job.prompt.slice(0, 60)}` : 'Responding';
    case 'mailbox': return job.fromBot ? `Handling message from ${job.fromBot}` : 'Handling mailbox';
    case 'cron': return `Scheduled routine: ${job.prompt.slice(0, 60)}`;
    default: return `Handling ${job.trigger} request`;
  }
}

// Re-exported for the /bots storage view.
export { BOT_JOURNAL_FILENAME };