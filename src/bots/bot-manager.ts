import { cpus } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Tool } from 'ai';
import type { MercuryConfig } from '../utils/config.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import { UserMemoryStore as UserMemoryStoreImpl } from '../memory/user-memory.js';
import { BotStore, BOT_JOURNAL_FILENAME, isValidCronExpression } from './store.js';
import { BotJournal } from './journal.js';
import { BotQueue, idempotencyKeyFor, LEASE_SECONDS, type DurableBotJob } from './queue.js';
import { createBotCapabilityRegistry, filterBotTools } from './registry-factory.js';
import { createBotSendTool } from './tools/bot-send.js';
import { createBotScheduleTool, type BotScheduler } from './tools/bot-schedule.js';
import { runBotTurn, isTransientFailure, type BotTurnMail } from './bot-turn.js';
import { synthesizeSkill, MIN_TOOLS_FOR_SYNTHESIS } from './skill-synthesis.js';
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
  /** Deliver turn output to the invoking surface (chat/telegram/api). */
  notify?: (channelType: string, channelId: string, message: string) => Promise<void>;
}

const MAX_TRANSIENT_ATTEMPTS = 3;
const MAILBOX_CAPACITY = 100;

/** Structural subset of the main Scheduler the bot runtime needs. */
type BotSchedulerLike = {
  addDelayedTask(m: { id: string; description: string; prompt: string; delaySeconds?: number; executeAt?: string; botId?: string; createdAt: string }): void;
  addPersistedTask(m: { id: string; cron: string; description: string; prompt: string; botId?: string; createdAt: string }): void;
  persistSchedules(): void;
  getManifests(): Array<{ id: string; botId?: string }>;
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
    if (!this.alert) return;
    await this.alert(message).catch((e) => logger.warn({ e, botId }, 'Bot alert send failed'));
  }

  private queues: Map<string, BotJob[]> = new Map();
  private scheduler?: BotSchedulerLike;
  private mailboxes: Map<string, BotTurnMail[]> = new Map();
  private running: Map<string, Set<string>> = new Map(); // botId → running job ids
  private aborts: Map<string, AbortController> = new Map(); // job key → controller
  private registries: Map<string, { registry: CapabilityRegistry; tools: Record<string, Tool> }> = new Map();
  private activity: Map<string, string> = new Map(); // botId → current activity
  private lastRun: Map<string, { at: number; state: BotRunRecord['state'] }> = new Map();
  private needsYou: Set<string> = new Set();
  private journals: Map<string, BotJournal> = new Map();
  private userMemories: Map<string, UserMemoryStore | null> = new Map();
  private disabled = new Set<string>();
  /** Per-bot daily token usage: botId → { day (UTC yyyy-mm-dd), tokens }. */
  private dailyTokens: Map<string, { day: string; tokens: number }> = new Map();
  private pausedForBudget = new Set<string>();

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
    for (const m of this.store.list()) {
      const drained = this.queue.drainMail(m.id);
      if (drained.length > 0) this.mailboxes.set(m.id, drained);
    }
    // Periodic due-sweep: retry-backoff jobs re-enter the in-memory queues
    // when their run_after elapses (also covers crash-restart backoffs).
    const dueTimer = setInterval(() => this.resumeDueJobs(), 30_000);
    dueTimer.unref?.();
  }

  /** Pull due (backoff-elapsed) jobs from the durable queue into memory and run them. */
  private resumeDueJobs(): void {
    const due = this.queue.dueJobs();
    for (const job of due) {
      if (this.disabled.has(job.botId)) continue;
      const running = this.running.get(job.botId)?.size ?? 0;
      const q = this.queues.get(job.botId) ?? [];
      const alreadyQueued = q.some(j => j.id === job.id);
      if (!alreadyQueued && running === 0) {
        q.push({
          id: job.id, botId: job.botId, trigger: job.trigger, prompt: job.prompt,
          fromBot: job.fromBot, source: job.source, createdAt: job.createdAt, attempts: job.attempts,
        });
        this.queues.set(job.botId, q);
        this.pump(job.botId);
      }
    }
  }

  /** Fleet-wide concurrency cap: config override or clamp(2, cpus-1). */
  private fleetCap(): number {
    const configured = this.config.bots?.maxConcurrent ?? 0;
    if (configured > 0) return configured;
    return Math.max(2, Math.min(cpus().length - 1, 8));
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

    try {
      this.queue.claim(job.id, LEASE_SECONDS);
      const turn = this.buildTurn(botId, manifest, job, controller.signal);
      const output = await runBotTurn(turn.input);
      turn.cleanup();

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
        }).catch((err) => logger.warn({ err, botId }, 'Skill synthesis failed'));
      }

      // Transient provider failures retry with backoff, bounded; permanent
      // failures go to the capped DLQ and stop (never silently re-queued — §2.6).
      // Retries requeue the SAME job in place (durable): no settle-then-
      // reenqueue window where a crash would lose the work.
      if (output.status === 'failed' && output.reasonCode && isTransientFailure(output.reasonCode) && job.attempts + 1 < MAX_TRANSIENT_ATTEMPTS) {
        const delay = Math.min(15000, 1000 * 2 ** job.attempts);
        this.queue.retry(job.id, job.attempts + 1, Date.now() + delay);
        logger.info({ botId, jobId: job.id, reasonCode: output.reasonCode, retryIn: delay }, 'Bot turn failed transiently — retrying in place');
        setTimeout(() => {
          const q = this.queues.get(botId) ?? [];
          if (!q.some(j => j.id === job.id)) {
            q.push({ ...job, attempts: job.attempts + 1 });
            this.queues.set(botId, q);
            this.pump(botId);
          }
        }, delay).unref?.();
      } else if (output.status === 'failed') {
        this.queue.settle(job.id, 'dead', output.reasonCode);
        this.needsYou.add(botId);
        logger.warn({ botId, jobId: job.id, reasonCode: output.reasonCode }, 'Bot turn failed permanently — moved to DLQ (replayable via /bots dlq)');
        await this.alertOwner(botId, `❌ **${manifest.name}** failed permanently [reason: ${output.reasonCode}] — replay with \`/bots replay ${botId} ${job.id}\``);
      } else if (output.status === 'paused') {
        // Step-budget pause: work continues next turn — same job requeues in
        // place (durable), no attempts bump.
        this.queue.retry(job.id, job.attempts, Date.now() + 2000);
        setTimeout(() => {
          const q = this.queues.get(botId) ?? [];
          if (!q.some(j => j.id === job.id)) {
            q.push({ ...job });
            this.queues.set(botId, q);
            this.pump(botId);
          }
        }, 2000).unref?.();
      } else {
        this.queue.settle(job.id, 'done');
      }

      // Deliver the outcome — Hermes/OpenClaw model (BOTS-ARCHITECTURE §3.1):
      // the FULL result always lands in the BOT'S OWN thread; the session
      // that asked for it gets only a one-line pointer. Remote channels
      // (Telegram/web) are the exception — the user cannot open bot threads
      // from there, so the full result is delivered in that chat. Halts
      // report too (a stopped run must announce it stopped, §2.6).
      if (this.notify && job.trigger !== 'mailbox') {
        const botThread = `bot:${botId}`;
        const icon = output.status === 'completed' ? '🤖' : output.status === 'failed' ? '❌' : output.status === 'halted' ? '⏹' : '⏸';
        const fullText = output.status === 'halted'
          ? `⏹ Run ${job.id} was stopped by you — no further output. It is recorded in \`/bots journal ${botId}\`.`
          : `${icon} (${job.trigger}): ${output.output.slice(0, 800)}`;
        // 1. Full result → the bot's own thread, always.
        await this.notify('cli', botThread, fullText).catch((e) =>
          logger.warn({ e, botId }, 'Bot result deliver to bot thread failed'));
        // 2. Requesting surface: pointer line for TUI sessions; full result
        // for remote channels (their user can't open bot threads).
        const sourceChannelType = job.source?.channelType ?? 'cli';
        const sourceChannelId = job.source?.channelId;
        if (sourceChannelId && sourceChannelId !== botThread) {
          if (sourceChannelType === 'cli') {
            const pointer = output.status === 'completed'
              ? `🤖 **${manifest.name}** finished its task — full result in its chat (\`/bots open ${botId}\`).`
              : `🤖 **${manifest.name}** run ended (${output.status}) — details in \`/bots open ${botId}\`.`;
            await this.notify('cli', sourceChannelId, pointer).catch((e) =>
              logger.warn({ e, botId }, 'Bot pointer notify failed'));
          } else {
            await this.notify(sourceChannelType, sourceChannelId, fullText).catch((e) =>
              logger.warn({ e, botId }, 'Bot remote-channel result notify failed'));
          }
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
      });
      this.needsYou.add(botId);
    } finally {
      running.delete(job.id);
      this.aborts.delete(`${botId}:${job.id}`);
      if (running.size === 0) this.activity.delete(botId);
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
    const { registry, tools } = this.getOrCreateRuntime(botId, manifest);
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

  private getOrCreateRuntime(botId: string, manifest: BotManifest): { registry: CapabilityRegistry; tools: Record<string, Tool> } {
    const cached = this.registries.get(botId);
    if (cached) return cached;
    const registry = createBotCapabilityRegistry({
      botId,
      manifest,
      botDir: this.store.botDir(botId),
      permissions: this.store.readPermissions(botId),
      userMemory: this.userMemoryFor(botId, manifest),
      config: this.config,
    });
    // Filter FIRST (strips interactive/global-mutation tools and applies the
    // manifest allow/deny), THEN add the bot-specific tools — otherwise the
    // filter would strip them again.
    const filtered = filterBotTools({ ...registry.getTools() }, manifest) as Record<string, Tool>;
    if ((manifest.comms?.canMessage ?? []).length > 0) {
      filtered.bot_send = createBotSendTool(this, botId, manifest.comms?.canMessage ?? []);
    }
    // bot_schedule: bots can schedule their own future runs (durable,
    // capped) when the main scheduler is wired.
    if (this.scheduler) {
      filtered.bot_schedule = createBotScheduleTool(this.scheduler, botId);
    }
    this.registries.set(botId, { registry, tools: filtered });
    return { registry, tools: filtered };
  }

  invalidateRuntime(botId: string): void {
    this.registries.delete(botId);
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
    if (!running || running.size === 0) return false;
    for (const id of running) {
      if (jobId && id !== jobId) continue;
      this.aborts.get(`${botId}:${id}`)?.abort();
    }
    this.queues.set(botId, jobId ? (this.queues.get(botId) ?? []).filter(j => j.id !== jobId) : []);
    return true;
  }

  async haltAll(): Promise<void> {
    for (const [botId] of this.running) {
      await this.halt(botId);
    }
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
    const entry = this.queue.removeFromDlq(jobId);
    if (!entry || entry.botId !== botId) return { accepted: false, reasonCode: 'not_found' };
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
      return '\n\nMercury Bots: no bots configured. The user can create one with `/bots create <id> "Name" "Description"`.';
    }
    const lines: string[] = [
      '\n\nMercury Bots — the user maintains these persistent specialist agents (each has its own persona, model, memory, and permissions; they run OUTSIDE this conversation):',
    ];
    for (const m of summaries) {
      const state = this.running.get(m.id)?.size ? 'running' : ((this.queues.get(m.id)?.length ?? 0) > 0 ? 'queued' : (m.enabled ? 'idle' : 'disabled'));
      const desc = m.description ? ` — ${m.description}` : '';
      lines.push(`- **${m.name}** (\`${m.id}\`)${desc} [${state}]`);
    }
    lines.push(`Bot control (never route bot work through this main conversation):
- \`/bot <id> <message>\` or \`@<id> <message>\` — dispatch a task to a bot; its reply arrives in this chat when done.
- \`/bots open <id>\` — open the bot's own chat; \`/bots\` — roster with live states.
- \`/bots create <id> "Name" "Description"\` — onboard; \`/bots persona <id> <text>\` — set its character.
- \`/bots journal <id>\` — recent runs; \`/bots dlq\` — failed jobs (replayable); \`/bots stop|enable|disable <id>\`.
- The dispatch_bot tool lets you hand a task to a bot mid-conversation and continue talking; the result is delivered when the bot finishes.`);
    return lines.join('\n');
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