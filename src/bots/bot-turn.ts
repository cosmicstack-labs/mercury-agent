import { streamText, stepCountIs } from 'ai';
import type { ModelMessage, Tool } from 'ai';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { BaseProvider } from '../providers/base.js';
import { classifyStreamCompletion } from '../core/stream-completion.js';
import { stepsExhaustedPrompt } from '../core/completion-verdict.js';
import { isFailedToolResult } from '../core/execute-guard.js';
import { MAX_AUTOMATIC_CONTINUATIONS } from '../core/execution-limits.js';
import { formatToolStep } from '../utils/tool-label.js';
import { logger } from '../utils/logger.js';
import type { BotManifest, BotTrigger } from './types.js';

/** Mailbox messages injected mid-turn (bot-to-bot or queued user input). */
export interface BotTurnMail {
  from: string;
  content: string;
}

/**
 * Real-time bot activity event — what the bot is doing RIGHT NOW. Emitted at
 * AI SDK callback granularity (step start, tool call start/finish) so the
 * surfaces can show live work instead of the coarse idle/running states.
 */
export type BotActivityEvent = {
  botId: string;
  jobId: string;
  kind: 'turn-start' | 'step' | 'tool' | 'turn-end' | 'thinking';
  /** Human-readable: "read_file ~/cookies" / "step 4 · 12.3k tok in". */
  label: string;
  detail?: string;
  stepIndex: number;
  elapsedMs: number;
  status?: 'running' | 'done' | 'error';
  /** kind 'thinking' only: cumulative rolling tails (raw deltas would force
   *  every consumer to reassemble state — tails render stateless instead). */
  reasoningTail?: string;
  textTail?: string;
};

/**
 * What a run is expected to leave behind. Computed by the manager from the
 * trigger and the routine's declaration, never by the model:
 * - work:    a deliverable, an action, or a delegation (cron, self-schedule,
 *            manual runs). A run that only wrote notes is NOT done.
 * - message: a delegated task whose reply text IS the result (crew → lead).
 * - check:   a monitoring routine that is allowed to find nothing to do.
 */
export type BotExpectedOutcome = 'work' | 'message' | 'check';

/** What the tool trace proves the run did — the journal's `outcome`. */
export type BotOutcome = 'deliverable' | 'action' | 'delegated' | 'message' | 'none';

/** Hard per-turn limits (ADR-020). Overridable per bot via `autonomy`. */
export interface BotTurnLimits {
  /** Tokens (in + out) a single turn may spend before it is cut off. */
  maxTokensPerTurn: number;
  /** Wall-clock minutes a single turn may run. */
  maxTurnMinutes: number;
  /** Tool results kept verbatim in the context window; older ones are stubbed. */
  keepRecentToolResults: number;
  /** Any single tool result larger than this is truncated before the model sees it. */
  maxToolResultChars: number;
  /** Fleet-shared folder write budget per turn: notes are not work. */
  sharedWrites: { softFiles: number; softBytes: number; hardFiles: number; hardBytes: number };
}

export const DEFAULT_TURN_LIMITS: BotTurnLimits = {
  maxTokensPerTurn: 300_000,
  maxTurnMinutes: 20,
  keepRecentToolResults: 8,
  maxToolResultChars: 24_000,
  sharedWrites: { softFiles: 2, softBytes: 32 * 1024, hardFiles: 6, hardBytes: 128 * 1024 },
};

export interface BotTurnInput {
  manifest: BotManifest;
  trigger: BotTrigger;
  /** Durable job id — correlates activity events with the run. */
  jobId?: string;
  prompt: string;
  persona: string;
  /** Pending mailbox messages at turn start (attributed bot-to-bot handoffs). */
  mail: BotTurnMail[];
  /** Callback checked between rounds for newly arrived mailbox messages. */
  pollMail: () => BotTurnMail[];
  /** Sandbox areas granted implicitly (rw+x): private workspace + fleet-shared folder. */
  sandbox: { workspace: string; shared: string };
  /** Where finals go (shown to the bot every turn); absent = legacy outputs zone. */
  deliverablesDir?: string;
  /** Skill roster text (native + the bot's own library); empty when none. */
  skillsPrompt?: string;
  /** Fleet hierarchy context (lead crew roster / crew membership); absent for solos. */
  fleet?: {
    role: 'lead' | 'crew';
    leadName?: string;
    crew: Array<{ id: string; name: string; description?: string; state: string }>;
    maxCrew: number;
  };
  /** Outcome contract for this run (default 'work'). */
  expects?: BotExpectedOutcome;
  limits?: Partial<BotTurnLimits>;
  capabilities: CapabilityRegistry;
  tools: Record<string, Tool>;
  userMemory: UserMemoryStore | null;
  provider: BaseProvider;
  tokenBudget: TokenBudget;
  abortSignal: AbortSignal;
  /** Real-time activity consumer (roster, live regions, web feed). */
  onActivity?: (ev: BotActivityEvent) => void;
}

/** One tool call as the trace saw it: name, whether it worked, where it wrote. */
export interface BotToolTraceEntry {
  name: string;
  ok: boolean;
  /** `path` / `command` / `target` argument, when the tool has one. */
  arg?: string;
  /** bot_send with task: true. */
  task?: boolean;
}

export interface BotTurnOutput {
  status: 'completed' | 'failed' | 'halted' | 'paused';
  output: string;
  tokensIn: number;
  tokensOut: number;
  /** Distinct tool names the turn used (drives auto-skill synthesis). */
  toolsUsed: string[];
  error?: string;
  reasonCode?: string;
  /** Wall-clock start of the turn itself (the job's createdAt is the enqueue time). */
  startedAt: number;
  steps: number;
  toolCalls: number;
  /** Largest single-step prompt the provider saw — the context-growth meter. */
  peakInputTokens: number;
  outcome: BotOutcome;
  /** Paths of files delivered via bot_deliver this turn. */
  deliverables: string[];
  /** The reply claimed delivery/execution but the trace shows none. */
  claimedWithoutAction: boolean;
  /** The no-outcome nudge was issued (once per turn). */
  outcomeNudged: boolean;
  trace: BotToolTraceEntry[];
}

const MAX_STEPS_DEFAULT = 25;

/** 'thinking' tail emission cadence — a live preview, not a firehose. */
const THINKING_EMIT_INTERVAL_MS = 300;
/** Rolling tail cap per field; surfaces render the tail bottom-anchored. */
const THINKING_TAIL_CHARS = 600;

/** Steps allowed for the single no-outcome continuation round. */
const NUDGE_STEPS = 8;

/** File tools whose target path decides sandbox (notes) vs outside (action). */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'create_file', 'edit_file', 'delete_file']);
/** Tools whose success IS an action regardless of arguments. */
const ACTION_TOOLS: ReadonlySet<string> = new Set([
  'git_add', 'git_commit', 'git_push', 'create_pr', 'create_issue', 'github_api', 'use_skill', 'bot_spawn', 'bot_retire',
]);
/** run_command heads that only look: not an action. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'stat', 'file', 'du', 'df', 'pwd', 'echo', 'date', 'which',
  'cmp', 'diff', 'md5', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'test', 'true', 'false', 'printf', 'env', 'uname', 'tree', 'less', 'more',
]);

const CLAIM_PATTERN = /\b(delivered|filed|shipped|published|executed|committed|pushed|posted|sent|deployed|uploaded)\b/i;

/**
 * One run of one bot: a fresh-context tool loop over the bot's own provider,
 * persona, toolset, memory namespace, and fail-closed permission manager.
 * Structurally mirrors SubAgent.run() minus the shared-registry hazards:
 * every dependency here is already per-bot.
 *
 * Governed (ADR-020): a hard token and wall-clock cap per turn, tool results
 * compacted as the context grows, a per-turn write budget on the shared
 * folder, and an OUTCOME verdict computed from the tool trace — a run that
 * only wrote notes gets one nudge to deliver or admit it, and is journaled
 * as `none` if it still produced nothing.
 */
export async function runBotTurn(input: BotTurnInput): Promise<BotTurnOutput> {
  const { manifest, provider, capabilities, tokenBudget } = input;
  const maxSteps = manifest.autonomy?.maxSteps ?? MAX_STEPS_DEFAULT;
  const limits = resolveTurnLimits(manifest, input.limits);
  const expects: BotExpectedOutcome = input.expects ?? defaultExpectation(input.trigger);
  const startedAt = Date.now();

  const system = buildBotSystemPrompt(input);
  const messages: ModelMessage[] = [];

  for (const m of input.mail) {
    messages.push({ role: 'user', content: `Message from 🤖 ${m.from}:\n\n${m.content}` });
  }
  if (input.prompt) {
    messages.push({ role: 'user', content: input.prompt });
  }
  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'You have no specific task. Check your inbox and report your status.' });
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let peakInputTokens = 0;
  let lastResult: { text: string; finishReason: unknown } | null = null;
  let stepsRemaining = maxSteps;
  let budgetContinuations = 0;
  let stepIndex = 0;
  let outcomeNudged = false;
  const toolsUsed = new Set<string>();
  const trace: BotToolTraceEntry[] = [];
  const deliveries: string[] = [];
  const onActivity = input.onActivity;
  const emit = (ev: { kind: BotActivityEvent['kind']; label: string; detail?: string; stepIndex: number; status?: BotActivityEvent['status']; elapsedMs?: number; reasoningTail?: string; textTail?: string }): void => {
    if (!onActivity) return;
    try {
      onActivity({
        botId: manifest.id,
        jobId: input.jobId ?? '',
        elapsedMs: ev.elapsedMs ?? Date.now() - startedAt,
        kind: ev.kind,
        label: ev.label,
        detail: ev.detail,
        stepIndex: ev.stepIndex,
        status: ev.status,
        reasoningTail: ev.reasoningTail,
        textTail: ev.textTail,
      });
    } catch { /* activity feedback must never break a turn */ }
  };

  // Turn governor: a local abort the caps trip, chained to the caller's
  // halt signal. The reason tells the two apart in the catch below.
  const governor = new AbortController();
  let governorReason: 'turn_budget' | 'turn_time' | null = null;
  const trip = (reason: 'turn_budget' | 'turn_time'): void => {
    if (governor.signal.aborted) return;
    governorReason = reason;
    governor.abort();
  };
  const onHalt = (): void => governor.abort();
  if (input.abortSignal.aborted) governor.abort();
  else input.abortSignal.addEventListener('abort', onHalt, { once: true });
  const deadline = setTimeout(() => trip('turn_time'), limits.maxTurnMinutes * 60_000);
  deadline.unref?.();
  const halted = (): boolean => input.abortSignal.aborted;

  const tools = wrapBotTools(input.tools, {
    sandbox: input.sandbox,
    limits,
    onDelivered: (path) => deliveries.push(path),
  });

  const baseOutput = () => ({
    tokensIn, tokensOut, toolsUsed: [...toolsUsed], startedAt, steps: stepIndex, toolCalls: trace.length,
    peakInputTokens, deliverables: [...deliveries], outcomeNudged, trace: [...trace],
  });

  try {
    emit({ kind: 'turn-start', stepIndex: 0, label: input.prompt ? input.prompt.slice(0, 80) : 'Checking inbox' });
    while (stepsRemaining > 0 && !governor.signal.aborted) {
      // streamText, not generateText: the deltas are the real-time feedback
      // inside the bot's thread (reasoning + reply tails). Same options and
      // step-count semantics; the result's final promises preserve the old
      // result shape exactly (text/finishReason), so all classification below
      // is unchanged.
      let streamError: unknown = null;
      const stream = streamText({
        model: provider.getModelInstance(),
        system,
        messages,
        tools,
        stopWhen: stepCountIs(stepsRemaining),
        abortSignal: governor.signal,
        experimental_include: { requestBody: false },
        // Context compaction: every step re-sends the whole conversation, so
        // 25 steps of 60KB tool results is a multi-megatoken prompt. Keep
        // the newest results verbatim (capped), stub the rest.
        prepareStep: ({ messages: stepMessages }: { messages: ModelMessage[] }) => ({ messages: compactMessages(stepMessages, limits) }),
        experimental_onStepStart: () => {
          stepIndex++;
          emit({ kind: 'step', stepIndex, label: `step ${stepIndex}` });
        },
        experimental_onToolCallStart: ({ toolCall }: any) => {
          const label = formatToolStep(String(toolCall?.toolName ?? 'tool'), (toolCall?.input ?? {}) as Record<string, any>);
          emit({ kind: 'tool', stepIndex, label, status: 'running' });
        },
        experimental_onToolCallFinish: ({ toolCall, success, error, durationMs }: any) => {
          const label = formatToolStep(String(toolCall?.toolName ?? 'tool'), (toolCall?.input ?? {}) as Record<string, any>);
          emit({
            kind: 'tool',
            stepIndex,
            label,
            detail: error != null ? String(error?.message ?? error).slice(0, 200) : undefined,
            status: success ? 'done' : 'error',
            elapsedMs: typeof durationMs === 'number' ? durationMs : undefined,
          });
        },
        onStepFinish: ({ usage, toolCalls, toolResults }: { usage?: { inputTokens?: number; outputTokens?: number }; toolCalls?: unknown[]; toolResults?: unknown[] }) => {
          if (governor.signal.aborted) return;
          stepsRemaining--;
          if (usage) {
            tokensIn += usage.inputTokens ?? 0;
            tokensOut += usage.outputTokens ?? 0;
            peakInputTokens = Math.max(peakInputTokens, usage.inputTokens ?? 0);
          }
          for (const tc of (toolCalls ?? []) as Array<{ toolName?: string; toolCallId?: string }>) {
            if (tc?.toolName) toolsUsed.add(String(tc.toolName));
            trace.push(traceEntry(tc, ((toolResults ?? []) as Array<{ toolCallId?: string; output?: ToolOutput }>).find((r) => r?.toolCallId !== undefined && r.toolCallId === tc?.toolCallId)));
          }
          const kIn = Math.round(tokensIn / 100) / 10;
          emit({ kind: 'step', stepIndex, label: `step ${stepIndex} · ${kIn}k tok in` });
          if (tokensIn + tokensOut > limits.maxTokensPerTurn) trip('turn_budget');
        },
      });

      // Live thinking feedback: consume the full stream, accumulate rolling
      // tails, emit at most every THINKING_EMIT_INTERVAL_MS (a TUI re-render
      // per delta would thrash ink). Tails are per-round: a new generation
      // round starts thinking anew. Step boundaries insert a paragraph break
      // so multi-step narrations don't run together (same fix as the main
      // chat's stepAwareTextStream).
      let reasoningTail = '';
      let textTail = '';
      let lastEmit = 0;
      const flushThinking = (): void => {
        if (!onActivity) return;
        if (!reasoningTail && !textTail) return;
        lastEmit = Date.now();
        emit({ kind: 'thinking', stepIndex, label: 'thinking', reasoningTail, textTail });
      };
      for await (const part of stream.fullStream) {
        if (part.type === 'reasoning-delta' && part.text) {
          reasoningTail = (reasoningTail + part.text).slice(-THINKING_TAIL_CHARS);
        } else if (part.type === 'text-delta' && part.text) {
          textTail = (textTail + part.text).slice(-THINKING_TAIL_CHARS);
        } else if (part.type === 'start-step' && (reasoningTail || textTail)) {
          reasoningTail += '\n\n';
          textTail += '\n\n';
        } else if (part.type === 'error') {
          // The provider's real error. Without this, `stream.text` below
          // throws the generic "No output generated" and the journal never
          // learns it was an invalid key or a 429.
          streamError = (part as { error?: unknown }).error ?? streamError;
        }
        if (Date.now() - lastEmit >= THINKING_EMIT_INTERVAL_MS) flushThinking();
      }
      flushThinking();

      let result: { text: string; finishReason: unknown };
      try {
        const [finalText, finishReason] = await Promise.all([stream.text, stream.finishReason]);
        result = { text: finalText, finishReason };
      } catch (err) {
        throw streamError ?? err;
      }
      if (streamError && !result.text) throw streamError;
      lastResult = result;

      const completion = classifyStreamCompletion({
        finishReason: result.finishReason as never,
        hasText: Boolean(result?.text),
        hasToolCalls: true,
      });
      if (completion === 'interrupted') {
        throw new Error('Generation was interrupted before completion (no finish signal from provider)');
      }

      if (result.text) {
        messages.push({ role: 'assistant', content: result.text });
      }

      // Step budget exhausted with tool calls still pending is a PAUSE, never
      // a completion (sub-agent completion contract). Mirror the main agent's
      // bounded auto-continuation: refill the budget and resume the SAME
      // conversation in-process — the old path requeued the job and rebuilt
      // the turn from scratch, discarding every completed step and re-burning
      // the budget redoing the first 25 steps. The per-turn token cap is the
      // runaway guard; past the continuation bound the paused return below
      // still applies.
      if (stepsRemaining <= 0 && lastResult?.finishReason === 'tool-calls') {
        if (!governor.signal.aborted && budgetContinuations < MAX_AUTOMATIC_CONTINUATIONS) {
          budgetContinuations++;
          logger.warn(
            { botId: manifest.id, rounds: budgetContinuations, budget: maxSteps },
            'Bot step budget exhausted mid-turn — continuing with a fresh budget',
          );
          messages.push({ role: 'user', content: stepsExhaustedPrompt(input.prompt) });
          stepsRemaining = maxSteps;
          continue;
        }
        break;
      }

      // Consume newly arrived mailbox messages before finishing, so a
      // handoff delivered mid-turn is not lost to the next scheduling gap.
      if (!governor.signal.aborted && stepsRemaining > 0) {
        const fresh = input.pollMail();
        if (fresh.length > 0) {
          for (const m of fresh) {
            messages.push({ role: 'user', content: `Message from 🤖 ${m.from}:\n\n${m.content}` });
          }
          continue;
        }
      }

      // Outcome gate: the trace, not the reply, says whether work happened.
      // A run expected to produce work that only read and wrote notes gets
      // exactly one nudge — deliver now, or say plainly that nothing was
      // done. Bounded like the execute guard; never a loop.
      if (!governor.signal.aborted && expects === 'work' && !outcomeNudged
        && computeOutcome({ trace, deliveries, expects, text: result.text, sandbox: input.sandbox }) === 'none') {
        outcomeNudged = true;
        emit({ kind: 'step', stepIndex, label: 'no deliverable yet — asking for one' });
        messages.push({ role: 'user', content: noOutcomePrompt(input) });
        stepsRemaining = Math.min(maxSteps, NUDGE_STEPS);
        continue;
      }
      break;
    }

    if (halted()) {
      return { status: 'halted', output: 'Turn was halted.', outcome: 'none', claimedWithoutAction: false, ...baseOutput() };
    }
    if (governorReason) {
      return governedFailure(governorReason, lastResult?.text, limits, baseOutput(), input, trace, deliveries, expects, emit, stepIndex);
    }

    // Step budget exhausted with tool calls still pending — pause, never
    // report success on half-done work (sub-agent completion contract).
    // Last resort only: reached past the in-process continuation bound.
    if (stepsRemaining <= 0 && lastResult?.finishReason === 'tool-calls') {
      emit({ kind: 'turn-end', stepIndex, label: 'paused — step budget', status: 'done' });
      return {
        status: 'paused',
        output: 'Step budget reached before the turn completed — remaining work continues next turn.',
        reasonCode: 'step_budget',
        outcome: computeOutcome({ trace, deliveries, expects, text: '', sandbox: input.sandbox }),
        claimedWithoutAction: false,
        ...baseOutput(),
      };
    }

    const output = (lastResult?.text || '').trim() || '(no text response)';
    const outcome = computeOutcome({ trace, deliveries, expects, text: lastResult?.text ?? '', sandbox: input.sandbox });
    const claimedWithoutAction = outcome === 'none' && CLAIM_PATTERN.test(output);

    tokenBudget.recordUsage({
      provider: provider.name,
      model: provider.getModel(),
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      totalTokens: tokensIn + tokensOut,
      channelType: 'bot',
    });

    emit({ kind: 'turn-end', stepIndex, label: outcome === 'none' && expects === 'work' ? 'completed — no deliverable' : 'completed', status: 'done' });
    return { status: 'completed', output, outcome, claimedWithoutAction, ...baseOutput() };
  } catch (err) {
    if (halted()) {
      emit({ kind: 'turn-end', stepIndex, label: 'halted', status: 'done' });
      return { status: 'halted', output: 'Turn was halted.', outcome: 'none', claimedWithoutAction: false, ...baseOutput() };
    }
    if (governorReason) {
      return governedFailure(governorReason, lastResult?.text, limits, baseOutput(), input, trace, deliveries, expects, emit, stepIndex);
    }
    const message = err instanceof Error ? err.message : String(err);
    emit({ kind: 'turn-end', stepIndex, label: `failed: ${message.slice(0, 80)}`, status: 'error' });
    return {
      status: 'failed',
      output: `Turn failed: ${message}`,
      error: message,
      reasonCode: classifyFailure(err),
      outcome: computeOutcome({ trace, deliveries, expects, text: '', sandbox: input.sandbox }),
      claimedWithoutAction: false,
      ...baseOutput(),
    };
  } finally {
    clearTimeout(deadline);
    input.abortSignal.removeEventListener('abort', onHalt);
  }
}

function governedFailure(
  reason: 'turn_budget' | 'turn_time',
  partialText: string | undefined,
  limits: BotTurnLimits,
  base: ReturnType<() => Omit<BotTurnOutput, 'status' | 'output' | 'outcome' | 'claimedWithoutAction'>>,
  input: BotTurnInput,
  trace: BotToolTraceEntry[],
  deliveries: string[],
  expects: BotExpectedOutcome,
  emit: (ev: { kind: BotActivityEvent['kind']; label: string; stepIndex: number; status?: BotActivityEvent['status'] }) => void,
  stepIndex: number,
): BotTurnOutput {
  const what = reason === 'turn_budget'
    ? `the ${Math.round(limits.maxTokensPerTurn / 1000)}k-token cap for one turn`
    : `the ${limits.maxTurnMinutes}-minute cap for one turn`;
  // Token spend of a cut-off turn is still spend.
  input.tokenBudget.recordUsage({
    provider: input.provider.name,
    model: input.provider.getModel(),
    inputTokens: base.tokensIn,
    outputTokens: base.tokensOut,
    totalTokens: base.tokensIn + base.tokensOut,
    channelType: 'bot',
  });
  emit({ kind: 'turn-end', stepIndex, label: `stopped — ${what}`, status: 'error' });
  return {
    status: 'failed',
    output: `Turn stopped at ${what} (${base.steps} steps, ${base.toolCalls} tool calls).`
      + (partialText ? `\n\nLast reply before the cut-off:\n${partialText.slice(0, 2000)}` : ''),
    error: `turn limit: ${reason}`,
    reasonCode: reason,
    outcome: computeOutcome({ trace, deliveries, expects, text: '', sandbox: input.sandbox }),
    claimedWithoutAction: false,
    ...base,
  };
}

/**
 * The outcome contract when the caller did not set one: a conversation
 * (chat, a bot's mail, a channel message) is answered by its reply; an
 * unattended wake (cron, self-schedule, API) must produce work.
 */
export function defaultExpectation(trigger: BotTrigger): BotExpectedOutcome {
  return trigger === 'cron' || trigger === 'api' || trigger === 'cloud' ? 'work' : 'message';
}

export function resolveTurnLimits(manifest: BotManifest, overrides?: Partial<BotTurnLimits>): BotTurnLimits {
  const a = manifest.autonomy ?? {};
  return {
    ...DEFAULT_TURN_LIMITS,
    ...(overrides ?? {}),
    ...(a.maxTokensPerTurn ? { maxTokensPerTurn: a.maxTokensPerTurn } : {}),
    ...(a.maxTurnMinutes ? { maxTurnMinutes: a.maxTurnMinutes } : {}),
    sharedWrites: { ...DEFAULT_TURN_LIMITS.sharedWrites, ...(overrides?.sharedWrites ?? {}) },
  };
}

/** Map a provider/tool error to a typed reason code (retry vs permanent). */
export function classifyFailure(err: unknown): string {
  let msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  // Retry wrappers ("Failed after 3 attempts. Last error: …") carry the
  // real cause after the colon — classify that, not the wrapper.
  const inner = /last error:\s*(.+)$/s.exec(msg);
  if (inner) msg = inner[1];
  if (/rate.?limit|429|too many requests/.test(msg)) return 'provider_rate_limit';
  // Network blips ARE transient — ECONNRESET (connection dropped mid-read)
  // and friends used to fall through to unknown_error, so a plain
  // connection blip went straight to the DLQ with a needs-you flag instead
  // of retrying like every other transient failure. "timed out" (with a
  // space) is how several providers phrase a deadline miss. "terminated" is
  // undici's wording for a response body cut mid-stream; "socket connection
  // was closed" is Node's. Both were 135 DLQ entries in one fleet.
  if (/timeout|timed out|etimedout|econnaborted|econnreset|econnrefused|epipe|enotfound|eai_again|getaddrinfo|fetch failed|socket|terminated|network|interrupted before completion/.test(msg)) return 'provider_timeout';
  // The SDK's "No output generated" means the stream ended before any step:
  // a provider hiccup, not a permanent condition.
  if (/no output generated/.test(msg)) return 'provider_empty';
  if (/no llm providers available/.test(msg)) return 'provider_unavailable';
  if (/permission denied|blocked command|no permission/.test(msg)) return 'permission_denied';
  if (/api key|unauthorized|401|authentication/.test(msg)) return 'provider_auth';
  if (/quota|billing|402/.test(msg)) return 'provider_quota';
  if (/context|maximum.*tokens|too long/.test(msg)) return 'context_overflow';
  return 'unknown_error';
}

/** Transient failures may retry; permanent ones go straight to the DLQ. */
export function isTransientFailure(reasonCode: string): boolean {
  return reasonCode === 'provider_rate_limit' || reasonCode === 'provider_timeout' || reasonCode === 'provider_empty';
}

/**
 * Turn-limit failures are terminal for the job but are NOT escalations: the
 * bot was stopped by policy, not by a fault. Settled done, no DLQ, no
 * "needs you" — the owner is told once (ADR-020).
 */
export function isTurnLimitFailure(reasonCode: string | undefined): boolean {
  return reasonCode === 'turn_budget' || reasonCode === 'turn_time';
}

// ---- outcome verdict ------------------------------------------------------

type ToolOutput = { type?: string; value?: unknown } | string | undefined;

function traceEntry(toolCall: { toolName?: string; input?: unknown } | undefined, toolResult: { output?: ToolOutput } | undefined): BotToolTraceEntry {
  const name = String(toolCall?.toolName ?? 'tool');
  const inputArgs = (toolCall?.input ?? {}) as Record<string, unknown>;
  const output = toolResult?.output;
  const text = toolResultText(output);
  const failedOutput = typeof output === 'object' && (output?.type === 'error-text' || output?.type === 'error-json');
  const ok = toolResult !== undefined && !failedOutput && !isFailedToolResult(text);
  const arg = typeof inputArgs.path === 'string' ? inputArgs.path
    : typeof inputArgs.command === 'string' ? inputArgs.command
      : typeof inputArgs.target === 'string' ? inputArgs.target
        : typeof inputArgs.file === 'string' ? inputArgs.file
          : undefined;
  return { name, ok, arg, ...(inputArgs.task === true ? { task: true } : {}) };
}

function toolResultText(output: ToolOutput): string {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (output.type === 'text' || output.type === 'error-text') return String(output.value ?? '');
  if (output.type === 'json' || output.type === 'error-json') {
    try { return JSON.stringify(output.value ?? ''); } catch { return ''; }
  }
  return '';
}

function insideAny(target: string, roots: string[]): boolean {
  const abs = resolve(target.replace(/^~(?=$|\/|\\)/, process.env.HOME ?? ''));
  return roots.some((root) => {
    const rel = relative(resolve(root), abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

export function isReadOnlyCommand(command: string): boolean {
  const head = command.trim().split(/\s+/)[0]?.replace(/^.*\//, '') ?? '';
  // A pipeline or chain with any non-read head is not read-only.
  const heads = command.split(/\s*(?:\|\||&&|;|\|)\s*/).map((seg) => seg.trim().split(/\s+/)[0]?.replace(/^.*\//, '') ?? '');
  return heads.every((h) => READ_ONLY_COMMANDS.has(h)) && READ_ONLY_COMMANDS.has(head);
}

/**
 * What the run did, by evidence. Order matters: a delivery beats everything;
 * an action outside the sandbox beats a delegation; `message` only counts
 * when the run's contract is a reply.
 */
export function computeOutcome(input: {
  trace: BotToolTraceEntry[];
  deliveries: string[];
  expects: BotExpectedOutcome;
  text: string;
  sandbox: { workspace: string; shared: string };
}): BotOutcome {
  if (input.deliveries.length > 0) return 'deliverable';
  const roots = [input.sandbox.workspace, input.sandbox.shared];
  for (const t of input.trace) {
    if (!t.ok) continue;
    if (ACTION_TOOLS.has(t.name)) return 'action';
    if (FILE_WRITE_TOOLS.has(t.name) && t.arg && !insideAny(t.arg, roots)) return 'action';
    if (t.name === 'run_command' && t.arg && !isReadOnlyCommand(t.arg)) return 'action';
  }
  if (input.trace.some((t) => t.ok && t.name === 'bot_send' && t.task)) return 'delegated';
  if (input.expects === 'message' && input.text.trim().length > 0) return 'message';
  return 'none';
}

function noOutcomePrompt(input: BotTurnInput): string {
  const where = input.deliverablesDir ? ` into ${input.deliverablesDir}` : '';
  return `[outcome check] This run has produced no deliverable and taken no action — only reads and notes in your sandbox. `
    + `Notes are not work. Do ONE of these now, then stop:\n`
    + `1. If you have a finished result, deliver it with bot_deliver${where} and name the file in your reply.\n`
    + `2. If the task needs an action (a command, a change outside your sandbox, a delegation), do it.\n`
    + `3. If there was genuinely nothing to do, reply with one line starting "Nothing to do:" and the reason. Do not write a record about it.`;
}

// ---- context compaction ---------------------------------------------------

/**
 * Keep the newest tool results verbatim (each capped), replace older ones
 * with a short stub. The model can re-run a tool it still needs; it cannot
 * afford to re-send 60KB of every file it ever read on every step.
 */
type ToolResultPart = { type: 'tool-result'; toolName?: string; output?: ToolOutput };

export function compactMessages(messages: ModelMessage[], limits: Pick<BotTurnLimits, 'keepRecentToolResults' | 'maxToolResultChars'>): ModelMessage[] {
  const resultRefs: Array<{ mi: number; pi: number }> = [];
  messages.forEach((m, mi) => {
    if (m?.role !== 'tool' || !Array.isArray(m.content)) return;
    (m.content as unknown as Array<{ type?: string }>).forEach((p, pi) => {
      if (p?.type === 'tool-result') resultRefs.push({ mi, pi });
    });
  });
  if (resultRefs.length === 0) return messages;
  const stubBefore = Math.max(0, resultRefs.length - limits.keepRecentToolResults);
  const out = messages.slice();
  resultRefs.forEach(({ mi, pi }, idx) => {
    const content = out[mi].content as unknown as ToolResultPart[];
    const part = content[pi];
    const output = part.output;
    const text = toolResultText(output);
    if (typeof output === 'object' && output?.type === 'content') return; // media parts: leave alone
    let next: string | null = null;
    if (idx < stubBefore) {
      if (text.length > 400) {
        next = `${text.slice(0, 400)}\n[…${text.length - 400} more chars trimmed from an earlier step — re-run ${part.toolName ?? 'the tool'} if you need it]`;
      }
    } else if (text.length > limits.maxToolResultChars) {
      next = `${text.slice(0, limits.maxToolResultChars)}\n[…truncated ${text.length - limits.maxToolResultChars} chars]`;
    }
    if (next === null) return;
    if (out[mi] === messages[mi]) out[mi] = { ...messages[mi], content: (messages[mi].content as unknown as ToolResultPart[]).slice() } as ModelMessage;
    (out[mi].content as unknown as ToolResultPart[])[pi] = { ...part, output: { type: 'text', value: next } };
  });
  return out;
}

// ---- tool wrapping: delivery capture + shared-folder write budget ----------

/**
 * Wrap the bot's toolset so the turn can see what matters without parsing
 * replies: deliveries (bot_deliver's destination) and writes into the
 * fleet-shared folder (budgeted — the shared folder is for data other bots
 * consume, not for narration; a soft limit warns, a hard limit refuses).
 */
export function wrapBotTools(
  tools: Record<string, Tool>,
  ctx: { sandbox: { workspace: string; shared: string }; limits: BotTurnLimits; onDelivered: (path: string) => void },
): Record<string, Tool> {
  const out: Record<string, Tool> = { ...tools };
  const shared = { files: new Set<string>(), bytes: 0 };
  const { sharedWrites } = ctx.limits;
  type ToolArgs = Record<string, unknown>;
  type Exec = (args: ToolArgs, options: unknown) => Promise<unknown>;
  const wrap = (name: string, fn: (original: Exec, args: ToolArgs, options: unknown) => Promise<unknown>): void => {
    const original = tools[name];
    if (!original || typeof original.execute !== 'function') return;
    const exec = original.execute.bind(original) as Exec;
    out[name] = { ...original, execute: (args: ToolArgs, options: unknown) => fn(exec, args, options) } as Tool;
  };

  wrap('bot_deliver', async (exec, args, options) => {
    const result = await exec(args, options);
    const m = /^Delivered to (.+?) —/.exec(String(result ?? ''));
    if (m) ctx.onDelivered(m[1]);
    return result;
  });

  for (const name of ['write_file', 'create_file', 'edit_file']) {
    wrap(name, async (exec, args, options) => {
      const target = typeof args?.path === 'string' ? args.path : '';
      const inShared = target && insideAny(resolve(ctx.sandbox.workspace, target), [ctx.sandbox.shared]);
      if (!inShared) return exec(args, options);
      const bytes = String(args?.content ?? args?.new_string ?? '').length;
      const nextFiles = shared.files.has(target) ? shared.files.size : shared.files.size + 1;
      if (nextFiles > sharedWrites.hardFiles || shared.bytes + bytes > sharedWrites.hardBytes) {
        return `Error: shared-folder write budget for this run is used up (${shared.files.size} files, ${Math.round(shared.bytes / 1024)}KB). `
          + `_shared is for data other bots consume, not for notes or records. Keep working notes in your private workspace, `
          + `and deliver finished results with bot_deliver.`;
      }
      const result = await exec(args, options);
      const text = String(result ?? '');
      if (isFailedToolResult(text)) return result;
      shared.files.add(target);
      shared.bytes += bytes;
      if (shared.files.size > sharedWrites.softFiles || shared.bytes > sharedWrites.softBytes) {
        return `${text}\n\n[Note: this run has written ${shared.files.size} files / ${Math.round(shared.bytes / 1024)}KB to the shared folder. `
          + `That is a lot for one run — the shared folder is for data other bots consume. Notes belong in your private workspace; finals go through bot_deliver.]`;
      }
      return result;
    });
  }
  return out;
}

// ---- system prompt --------------------------------------------------------

function buildBotSystemPrompt(input: BotTurnInput): string {
  const { manifest } = input;
  let prompt = `You are "${manifest.name}", a Mercury bot (id: ${manifest.id}).\n`;
  if (manifest.description) {
    prompt += `Role: ${manifest.description}\n`;
  }
  prompt += '\n';
  prompt += input.persona;

  // Scoped memory injection — mirrors the main agent's injection site, but
  // into the bot's own namespace (scope own/shared-read; scope none = null).
  if (input.userMemory) {
    try {
      const query = input.mail.map(m => m.content).join(' ') || input.prompt;
      const relevant = input.userMemory.retrieveRelevant(query, { maxRecords: 5, maxChars: 900 });
      if (relevant?.context) {
        prompt += `\n\n[Bot memory — auto-retrieved context]\n${relevant.context}`;
      }
    } catch (err: any) {
      logger.warn({ botId: manifest.id, err: err?.message }, 'Bot memory retrieval failed — continuing without');
    }
  }

  prompt += `\n\nOperating rules:
- You run unattended: NEVER ask the user questions or wait for confirmation. If a required input is missing, state the assumption you are proceeding with.
- Actions you lack permission for are denied automatically (fail-closed). Do not attempt workarounds; report what you could not do.
- Stay in your specialty; say so plainly when a request falls outside it.
- Work, don't narrate: a run is judged by what it delivered or changed, not by what it wrote about itself. Do not write records, receipts, logs or status files about your own runs — Mercury keeps the journal. If there is nothing to do, say "Nothing to do:" and the reason, and stop.`;

  // Sandbox: the bot's always-granted work areas (rw+x, no permission ask).
  prompt += `\n\nSandbox (always granted — read, write, execute; no permission needed):
- Private workspace: ${input.sandbox.workspace} — your scratch area: drafts, intermediate work, compiled artifacts.
- Fleet-shared folder: ${input.sandbox.shared} — one folder shared with all other bots, for DATA other bots consume (a dossier, a dataset, a draft handed to the next stage). Not for notes about your work; writes here are budgeted per run.
Anything outside these two areas and your declared Access grants is denied.`;

  if (input.deliverablesDir) {
    prompt += `\n\nDeliverables — where the owner finds your results: ${input.deliverablesDir}
- When a result is finished, call bot_deliver on the file (give it a human title; mark final: true for the finished piece the owner asked for). Never write there by hand.
- Intermediate stages (research, drafts, checks) are delivered as work, not finals; the lead delivers the final.
- Name the delivered file in your reply.`;
  }

  const roster = manifest.comms?.canMessage ?? [];
  if (roster.length > 0) {
    prompt += `\n\nBots you can message via bot_send: ${roster.join(', ')}.`;
  }

  const toolNames = Object.keys(input.tools);
  if (toolNames.length > 0) {
    prompt += `\n\nAvailable tools: ${toolNames.join(', ')}`;
  }

  if (input.skillsPrompt) {
    prompt += `\n\n${input.skillsPrompt}`;
    prompt += `\nSkill scripts are subject to your access grants: a skill whose scripts you cannot run from its own directory can be copied into your sandbox workspace and run from there.`;
  }

  // Fleet hierarchy: the lead orchestrates, the crew executes.
  if (input.fleet?.role === 'lead') {
    const roster = input.fleet.crew.length > 0
      ? input.fleet.crew.map(c => `- ${c.name} (${c.id})${c.description ? ` — ${c.description}` : ''} [${c.state}]`).join('\n')
      : '(EMPTY — build your team first, see below)';
    prompt += `\n\nYou lead a fleet of crew bots:
${roster}

Fleet protocol:
- SELF-ORGANIZE: if your crew is empty or lacks a specialist the task needs, BUILD IT FIRST with bot_spawn — design each sub-bot's role and persona from YOUR persona and the current task (e.g. a product lead spawns research/QA/support specialists). Do not report that you lack a team; hire one. Then delegate.
- DELEGATE with bot_send (task: true) — be concrete and self-contained; the result arrives in your mailbox when the bot finishes.
- MONITOR with fleet_status — check who is running, idle, or blocked before and after delegating.
- You may create specialists with bot_spawn (crew cap: ${input.fleet.maxCrew}) and retire your own crew with bot_retire.
- Crew run CONCURRENTLY — dispatch independent work in parallel rather than sequentially.
- You SYNTHESIZE: crew results arrive in your mailbox attributed by bot; combine them and report a single coherent outcome.${input.fleet.leadName ? `\n- You are also crew of **${input.fleet.leadName}** — your task results return to it automatically; treat it as your manager.` : ''}`;
  } else if (input.fleet?.role === 'crew') {
    prompt += `\n\nYou are crew in **${input.fleet.leadName ?? 'your lead'}'s** fleet. Tasks delegated to you (mailbox messages with a task) return your result to the lead automatically when you finish — make your final output a complete, self-contained report. Use bot_send to ask the lead questions mid-task.`;
  }

  const remaining = input.tokenBudget.getRemaining();
  prompt += `\n\nToken budget remaining: ${remaining}`;

  return prompt;
}
