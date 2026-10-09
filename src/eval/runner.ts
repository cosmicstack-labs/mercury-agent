/**
 * runScenario — drive the REAL agent loop with a fixture.
 *
 * Construction mirrors src/index.ts (Agent + ProviderRegistry +
 * CapabilityRegistry + SessionRepository + memory stores) with three
 * substitutions only:
 *   - providers are ScriptedProviders (MockLanguageModelV3 playback),
 *   - the channel is a RecordingChannel behind a minimal channel registry
 *     (the real ChannelRegistry always starts the Ink CLI),
 *   - tool `execute` returns the fixture's recorded result when one exists.
 * Messages enter through the channel → registry → Agent.enqueueMessage →
 * processQueue → handleMessage, the production path.
 */
import './env.js';
import { freshHome } from './env.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { vi } from 'vitest';
import type { Tool } from 'ai';
import { Agent } from '../core/agent.js';
import { CapabilityRegistry, type ChatCommandContext } from '../capabilities/registry.js';
import { ProviderRegistry } from '../providers/registry.js';
import { Identity } from '../soul/identity.js';
import { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import { TokenBudget } from '../utils/tokens.js';
import { Scheduler } from '../core/scheduler.js';
import { SessionRepository } from '../sessions/repository.js';
import type { SessionMessage } from '../sessions/types.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';
import { STEPS_PAUSED_BANNER, VERIFICATION_FAILED_BANNER, WORK_NOT_STARTED_BANNER } from '../core/completion-verdict.js';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { PauseKind, ScenarioFixture, ScenarioTurn, ScriptedProviderSpec, TurnExpectations } from './fixture.js';
import { promptText, ScriptPlayer, type ProviderCallRecord } from './script-player.js';
import { ScriptedProvider } from './scripted-provider.js';
import { EvalChannelRegistry, RecordingChannel, type ChannelEvent } from './recording-channel.js';

export interface ToolCallRecord {
  id: string;
  tool: string;
  input: unknown;
  output: unknown;
  /** true = fixture-recorded output; false = the real tool ran. */
  recorded: boolean;
}

export interface GuardDecisions {
  /** Execute-mode narration guard rounds (toolChoice forced). */
  forcedActionRounds: number;
  wakeUpCalls: number;
  verificationRounds: number;
  stepBudgetContinuations: number;
  /** Model calls the loop forced to start with a tool (toolChoice: required). */
  forcedToolChoiceCalls: number;
  pause: PauseKind | null;
  /** "⚠ provider: … switching to …" / "served by" lines. */
  providerNotices: string[];
}

export interface StepTiming {
  index: number;
  provider: string;
  /** ms since the message was injected. */
  startMs: number;
  /** Until the next model call starts (or delivery): model + tool time. */
  durationMs: number;
  error?: string;
}

export interface PhaseTimings {
  /** Inject → first provider call: history, memory, prompt build. */
  promptBuildMs: number;
  steps: StepTiming[];
  /** Last model call start → final persistent delivery. */
  deliveryMs: number;
  totalMs: number;
}

export interface TurnResult {
  message: string;
  /** Last persistent message of the turn (answer, pause or failure). */
  finalText: string;
  /** Persistent messages, in order. */
  delivered: string[];
  /** Status-card / ephemeral lines. */
  notices: string[];
  events: ChannelEvent[];
  prompts: Array<{ question: string; answer?: boolean }>;
  providerCalls: ProviderCallRecord[];
  toolCalls: ToolCallRecord[];
  guard: GuardDecisions;
  timings: PhaseTimings;
  /** Session entries written during this turn. */
  sessionEntries: SessionMessage[];
  tokens: { input: number; output: number; cached: number };
  usedProvider: string | null;
  traceId: string | null;
  scriptExhausted: boolean;
  /** Expectation failures (empty = pass). */
  failures: string[];
}

export interface ScenarioResult {
  name: string;
  turns: TurnResult[];
  failures: string[];
  /** Kept for post-hoc inspection (e.g. renderTrace); disposed already. */
  sessions: SessionRepository;
  workDir: string;
}

export interface RunOptions {
  /** Fake setTimeout/setInterval for the run (default true): heartbeats, the
   * memory guard, stall watchdog and provider deadlines never fire mid-turn. */
  fakeTimers?: boolean;
}

const DEFAULT_TURN_TIMEOUT_MS = 15_000;
const clock = (): number => performance.now();

class EvalCapabilityRegistry extends CapabilityRegistry {
  player?: ScriptPlayer;
  readonly toolLog: ToolCallRecord[] = [];
  private readonly wrapped = new WeakMap<Tool, Tool>();

  private wrapAll(tools: Record<string, Tool>): Record<string, Tool> {
    const out: Record<string, Tool> = {};
    for (const [name, base] of Object.entries(tools)) out[name] = this.wrap(name, base);
    return out;
  }

  private wrap(name: string, base: Tool): Tool {
    const cached = this.wrapped.get(base);
    if (cached) return cached;
    const realExecute = base.execute;
    const wrapped = {
      ...base,
      execute: async (input: unknown, options: { toolCallId: string }) => {
        const scripted = this.player?.recordedResult(options.toolCallId);
        if (scripted && scripted.result !== undefined) {
          this.toolLog.push({ id: options.toolCallId, tool: name, input, output: scripted.result, recorded: true });
          return scripted.result;
        }
        const output = realExecute ? await (realExecute as any)(input, options) : undefined;
        this.toolLog.push({ id: options.toolCallId, tool: name, input, output, recorded: false });
        return output;
      },
    } as Tool;
    this.wrapped.set(base, wrapped);
    return wrapped;
  }

  override getTools(): Record<string, Tool> {
    return this.wrapAll(super.getTools());
  }

  override getPlanTools(): Record<string, Tool> {
    return this.wrapAll(super.getPlanTools());
  }
}

function buildConfig(providers: ScriptedProviderSpec[]): MercuryConfig {
  const config = getDefaultConfig();
  // Never let a developer's env keys register a live provider.
  for (const value of Object.values(config.providers)) {
    if (value && typeof value === 'object' && 'enabled' in value) (value as { enabled: boolean }).enabled = false;
  }
  (config.providers as { default: string }).default = providers[0].name;
  config.cloud.enabled = false;
  config.channels.telegram.streaming = true;
  config.tokens.dailyBudget = 100_000_000;
  return config;
}

function chatCommandContext(config: MercuryConfig, budget: TokenBudget, caps: CapabilityRegistry): ChatCommandContext {
  return {
    toolNames: () => caps.getToolNames(),
    skillNames: () => [],
    config: () => config,
    tokenBudget: () => budget,
    manual: () => 'Mercury eval manual',
    memorySummary: () => ({ total: 0 } as any),
    memoryRecent: () => [],
    memorySearch: () => [],
    memorySetLearningPaused: () => {},
    memoryClear: () => 0,
    memoryGetSubconscious: () => [],
    memoryIsShareLearning: () => false,
    memorySetShareLearning: () => {},
  };
}

const MARKERS = {
  forcedActionRounds: '[SYSTEM: EXECUTE-MODE GUARD]',
  wakeUpCalls: '[SYSTEM: WAKE-UP CALL]',
  verificationRounds: '[SYSTEM: EXECUTE-MODE VERIFICATION]',
  stepBudgetContinuations: '[SYSTEM: STEP BUDGET]',
} as const;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

function pauseKind(delivered: string[]): PauseKind | null {
  for (const text of [...delivered].reverse()) {
    if (text.includes(STEPS_PAUSED_BANNER)) return 'steps';
    if (text.includes(WORK_NOT_STARTED_BANNER)) return 'work-not-started';
    if (text.includes(VERIFICATION_FAILED_BANNER)) return 'verification-failed';
  }
  return null;
}

export class EvalHarness {
  readonly channel: RecordingChannel;
  readonly providers: ScriptedProvider[];
  readonly workDir: string;
  private seq = 0;

  private constructor(
    readonly fixture: ScenarioFixture,
    readonly agent: Agent,
    readonly sessions: SessionRepository,
    readonly capabilities: EvalCapabilityRegistry,
    readonly providerRegistry: ProviderRegistry,
    readonly player: ScriptPlayer,
    channel: RecordingChannel,
    providers: ScriptedProvider[],
    workDir: string,
    private readonly fake: boolean,
  ) {
    this.channel = channel;
    this.providers = providers;
    this.workDir = workDir;
    capabilities.player = this.player;
  }

  get channelType(): ChannelType {
    return this.channel.type;
  }

  get channelId(): string {
    return this.fixture.channel?.id ?? 'eval-chat';
  }

  static async create(fixture: ScenarioFixture, options: RunOptions = {}): Promise<EvalHarness> {
    const fake = options.fakeTimers !== false;
    if (fake) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const home = freshHome(fixture.name);
    const workDir = join(home, 'work');
    mkdirSync(workDir, { recursive: true });

    const specs = fixture.providers?.length ? fixture.providers : [{ name: 'scripted' }];
    const config = buildConfig(specs);
    const player = new ScriptPlayer(clock);
    const providerRegistry = await ProviderRegistry.create(config);
    const scripted = specs.map((spec) => new ScriptedProvider(spec, player));
    for (const p of scripted) providerRegistry.set(p.name, p);
    providerRegistry.setDefault(specs[0].name);

    const tokenBudget = new TokenBudget(config);
    const scheduler = new Scheduler(config);
    const sessions = new SessionRepository();
    const capabilities = new EvalCapabilityRegistry(undefined, scheduler, tokenBudget);
    capabilities.registerAll();
    capabilities.setCwd(workDir);
    capabilities.permissions.addTempScope(workDir, true, true);
    capabilities.permissions.setAutoApproveAll(true);
    capabilities.setChatCommandContext(chatCommandContext(config, tokenBudget, capabilities));

    const type = fixture.channel?.type ?? 'telegram';
    const channel = new RecordingChannel(type, fixture.channel?.style ?? 'messaging', clock);
    const registry = new EvalChannelRegistry();
    registry.register(type, channel);
    if (fixture.channel?.streaming === false) config.channels.telegram.streaming = false;

    const agent = new Agent(
      config,
      providerRegistry,
      new Identity(),
      new ShortTermMemory(config),
      new LongTermMemory(config),
      new EpisodicMemory(config),
      null,
      registry as unknown as ChannelRegistry,
      tokenBudget,
      capabilities,
      scheduler,
      sessions,
    );
    const mode = fixture.programmingMode ?? 'off';
    if (mode === 'execute') agent.programmingMode.setExecute();
    else if (mode === 'plan') agent.programmingMode.setPlan();

    await agent.birth();
    await agent.wake();

    const harness = new EvalHarness(fixture, agent, sessions, capabilities, providerRegistry, player, channel, scripted, workDir, fake);
    harness.seedHistory();
    return harness;
  }

  private seedHistory(): void {
    const history = this.fixture.history ?? [];
    if (history.length === 0) return;
    const session = this.sessions.getOrCreateBound(this.channelType, this.channelId);
    for (const entry of history) {
      this.sessions.appendMessage(session.id, { role: entry.role, kind: entry.kind ?? 'message', content: entry.content });
    }
  }

  private sessionMessages(): SessionMessage[] {
    return this.sessions.getByBinding(this.channelType, this.channelId)?.messages ?? [];
  }

  async runTurn(turn: ScenarioTurn): Promise<TurnResult> {
    this.player.load(turn);
    this.capabilities.toolLog.length = 0;
    this.channel.continueAnswer = turn.askToContinue ?? false;
    const eventStart = this.channel.events.length;
    const sessionStart = this.sessionMessages().length;
    const msg: ChannelMessage = {
      id: `eval-${this.fixture.name}-${++this.seq}`,
      channelId: this.channelId,
      channelType: this.channelType,
      senderId: 'eval-user',
      content: turn.message,
      timestamp: Date.now(),
    };

    const t0 = clock();
    this.channel.inject(msg);
    await this.waitForIdle(turn.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, eventStart);
    const tEnd = clock();

    const events = this.channel.since(eventStart);
    const delivered = events.filter((e) => e.kind === 'delivered').map((e) => e.text);
    const notices = events.filter((e) => e.kind === 'notice').map((e) => e.text);
    const calls = [...this.player.calls];
    const sessionEntries = this.sessionMessages().slice(sessionStart);
    const answer = [...sessionEntries].reverse().find((m) => m.role === 'assistant' && m.kind === 'message');
    const meta = (answer?.metadata ?? {}) as Record<string, unknown>;

    const allPrompts = calls.map((c) => promptText(c.prompt));
    const markerCount = (marker: string) => Math.max(0, ...allPrompts.map((p) => countOccurrences(p, marker)));
    const lastDelivery = [...events].reverse().find((e) => e.kind === 'delivered' || e.kind === 'completion');
    const steps: StepTiming[] = calls.map((c, i) => ({
      index: c.index,
      provider: c.provider,
      startMs: c.startedAt - t0,
      durationMs: (i + 1 < calls.length ? calls[i + 1].startedAt : (lastDelivery?.at ?? tEnd)) - c.startedAt,
      ...(c.error ? { error: c.error } : {}),
    }));
    const lastCall = calls.at(-1);
    const traceMatch = delivered.join('\n').match(/\/trace ([a-z0-9]+)/i);

    const result: TurnResult = {
      message: turn.message,
      finalText: delivered.at(-1) ?? '',
      delivered,
      notices,
      events,
      prompts: events.filter((e) => e.kind === 'prompt').map((e) => ({ question: e.text, answer: e.answer })),
      providerCalls: calls,
      toolCalls: [...this.capabilities.toolLog],
      guard: {
        forcedActionRounds: markerCount(MARKERS.forcedActionRounds),
        wakeUpCalls: markerCount(MARKERS.wakeUpCalls),
        verificationRounds: markerCount(MARKERS.verificationRounds),
        stepBudgetContinuations: markerCount(MARKERS.stepBudgetContinuations),
        forcedToolChoiceCalls: calls.filter((c) => (c.toolChoice as { type?: string } | undefined)?.type === 'required').length,
        pause: pauseKind(delivered),
        providerNotices: events.filter((e) => e.text.startsWith('⚠') && /switching to|served by|no fallback/.test(e.text)).map((e) => e.text),
      },
      timings: {
        promptBuildMs: calls.length > 0 ? calls[0].startedAt - t0 : 0,
        steps,
        deliveryMs: lastCall && lastDelivery ? lastDelivery.at - lastCall.startedAt : 0,
        totalMs: tEnd - t0,
      },
      sessionEntries,
      tokens: {
        input: typeof meta.inputTokens === 'number' ? meta.inputTokens : 0,
        output: typeof meta.outputTokens === 'number' ? meta.outputTokens : 0,
        cached: typeof meta.cachedInputTokens === 'number' ? meta.cachedInputTokens : 0,
      },
      usedProvider: typeof meta.provider === 'string' ? meta.provider : (calls.filter((c) => !c.error).at(-1)?.provider ?? null),
      traceId: typeof meta.traceId === 'string' ? meta.traceId : (traceMatch?.[1] ?? null),
      scriptExhausted: this.player.exhausted,
      failures: [],
    };
    result.failures = checkExpectations(result, turn.expect);
    return result;
  }

  /**
   * handleMessage flips the lifecycle to 'thinking' synchronously inside
   * enqueueMessage, and back to 'idle' when the turn (including delivery)
   * is over. Yield with setImmediate (never faked) until it settles.
   * Hook wanted in agent.ts: a public `whenIdle()` / turn-complete event —
   * see the P2.3 report.
   */
  private async waitForIdle(timeoutMs: number, eventStart: number): Promise<void> {
    const deadline = clock() + timeoutMs;
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    let settled = 0;
    while (settled < 25) {
      await tick();
      if (this.fake) vi.advanceTimersByTime(0); // zero-delay timers only (setTimeout(fn, 0))
      settled = this.agent.lifecycle.is('idle') ? settled + 1 : 0;
      if (clock() > deadline) {
        const tail = this.channel.since(eventStart).map((e) => `${e.kind}: ${e.text.slice(0, 120)}`).join('\n');
        throw new Error(`Turn did not finish within ${timeoutMs}ms (state ${this.agent.lifecycle.getState()}).\n${tail}`);
      }
    }
  }

  /** Model-input text of provider call `index` of the last turn. */
  promptOf(index: number): string {
    const record = this.player.calls[index];
    return record ? promptText(record.prompt) : '';
  }

  async dispose(): Promise<void> {
    try {
      this.agent.cancelActiveWork('eval finished');
      await this.agent.sleep();
    } finally {
      if (this.fake) vi.useRealTimers();
    }
  }
}

export function checkExpectations(result: TurnResult, expect: TurnExpectations | undefined): string[] {
  if (!expect) return [];
  const failures: string[] = [];
  const all = result.events.map((e) => e.text);
  const fail = (what: string) => failures.push(`[${result.message.slice(0, 40)}] ${what}`);
  if (expect.deliveredCount !== undefined && result.delivered.length !== expect.deliveredCount) {
    fail(`delivered ${result.delivered.length} messages, expected ${expect.deliveredCount}: ${JSON.stringify(result.delivered)}`);
  }
  for (const s of expect.finalTextIncludes ?? []) if (!result.finalText.includes(s)) fail(`final text lacks ${JSON.stringify(s)}: ${JSON.stringify(result.finalText)}`);
  for (const s of expect.finalTextExcludes ?? []) if (result.finalText.includes(s)) fail(`final text contains ${JSON.stringify(s)}`);
  for (const s of expect.anyEventIncludes ?? []) if (!all.some((t) => t.includes(s))) fail(`no channel event contains ${JSON.stringify(s)}`);
  for (const s of expect.noEventIncludes ?? []) {
    const hit = all.find((t) => t.toLowerCase().includes(s.toLowerCase()));
    if (hit) fail(`channel event contains ${JSON.stringify(s)}: ${JSON.stringify(hit.slice(0, 160))}`);
  }
  if (expect.providerCalls !== undefined && result.providerCalls.length !== expect.providerCalls) {
    fail(`${result.providerCalls.length} provider calls, expected ${expect.providerCalls}`);
  }
  if (expect.forcedActionRounds !== undefined && result.guard.forcedActionRounds !== expect.forcedActionRounds) {
    fail(`${result.guard.forcedActionRounds} forced action rounds, expected ${expect.forcedActionRounds}`);
  }
  if (expect.verificationRounds !== undefined && result.guard.verificationRounds !== expect.verificationRounds) {
    fail(`${result.guard.verificationRounds} verification rounds, expected ${expect.verificationRounds}`);
  }
  if (expect.stepBudgetContinuations !== undefined && result.guard.stepBudgetContinuations !== expect.stepBudgetContinuations) {
    fail(`${result.guard.stepBudgetContinuations} step-budget continuations, expected ${expect.stepBudgetContinuations}`);
  }
  if (expect.pause !== undefined && result.guard.pause !== expect.pause) fail(`pause ${result.guard.pause}, expected ${expect.pause}`);
  if (expect.usedProvider !== undefined && result.usedProvider !== expect.usedProvider) fail(`served by ${result.usedProvider}, expected ${expect.usedProvider}`);
  if (expect.toolsUsed) {
    const used = [...new Set(result.toolCalls.map((t) => t.tool))];
    if (JSON.stringify(used) !== JSON.stringify(expect.toolsUsed)) fail(`tools ${JSON.stringify(used)}, expected ${JSON.stringify(expect.toolsUsed)}`);
  }
  if (result.scriptExhausted) fail('the agent made more model calls than the script provides');
  return failures;
}

/** Run every turn of a fixture against a fresh agent. */
export async function runScenario(fixture: ScenarioFixture, options: RunOptions = {}): Promise<ScenarioResult> {
  const harness = await EvalHarness.create(fixture, options);
  const turns: TurnResult[] = [];
  try {
    for (const turn of fixture.turns) turns.push(await harness.runTurn(turn));
  } finally {
    await harness.dispose();
  }
  return {
    name: fixture.name,
    turns,
    failures: turns.flatMap((t) => t.failures),
    sessions: harness.sessions,
    workDir: harness.workDir,
  };
}
