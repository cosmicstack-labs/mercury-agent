import { generateText, streamText, stepCountIs } from 'ai';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { MercuryConfig, ProviderName } from '../utils/config.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { ScheduledDispatch, ScheduledTaskManifest } from './scheduler.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { ArtifactCollector } from '../artifacts/collector.js';
import { artifactStore, type Artifact } from '../artifacts/store.js';
import { chatFoldersFor, outputRoot, researchDir, type ChatFolders } from '../artifacts/output-dir.js';
import { ownerApprovals } from '../security/owner-approvals.js';
import { approvalAnsweredText, approvalRequestText, isOwnerSender, newLocationText, parseApprovalReply } from '../security/approval-messages.js';
import { audit } from '../security/audit.js';
import { setApprovalRoutes } from '../web/owner-gate.js';
import { onDeviceNewLocation } from '../web/middleware.js';
import { artifactKindLabel, artifactRef, formatBytes } from '../artifacts/ref.js';
import { getMercuryHome } from '../utils/config.js';
import { createProvider } from '../providers/registry.js';
import type { BaseProvider } from '../providers/base.js';
import { Lifecycle } from './lifecycle.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runInTurnScope } from '../utils/turn-scope.js';
import { claimToolImagesForTurn } from '../capabilities/tool-images.js';
import { TurnGovernor, machineFacts, resolveTurnLimit, type GovernedTurn } from './turn-governor.js';
import { Scheduler } from './scheduler.js';
import { ProgrammingMode, scopedProgrammingState, type ProgrammingSnapshot } from './programming-mode.js';
import { ResearchMode } from './research-mode.js';
import { SaverMode, NORMAL_HISTORY_WINDOW } from './saver-mode.js';
import { BackgroundTaskManager } from './background-tasks.js';
import type { SkillLoader } from '../skills/loader.js';
import { logger } from '../utils/logger.js';
import { refinePersona } from '../bots/persona-template.js';
import { proposeCrew } from '../bots/fleet-onboarding.js';
import { PERMISSION_TIERS, tierPermissionsFile, isPermissionTier, type PermissionTier } from '../bots/permission-tiers.js';
import { buildBotBundle, writeBundle, readBundle, importBotBundle } from '../bots/bundle.js';
import { applyBotFieldPatch } from '../bots/edit.js';
import { CLIChannel } from '../channels/cli.js';
import { TelegramChannel } from '../channels/telegram.js';
import { SignalChannel } from '../channels/signal.js';
import { DiscordChannel } from '../channels/discord.js';
import { SlackChannel } from '../channels/slack.js';
import { formatToolStep, formatNarrative, type NarrativeStep } from '../utils/tool-label.js';
import { getTelegramHelp, getDiscordHelp, getSlackHelp } from '../utils/manual.js';
import { WebChannel } from '../channels/web.js';
import type { ArrowSelectOption } from '../utils/arrow-select.js';
import { setAskUserHandler } from '../capabilities/interaction/ask-user.js';
import { classifyResearchIntent } from './research-intent.js';
import { closePlan, coverageSection, parsePlanLines, reportBody, reportFileName, RESEARCH_PLAN_SYSTEM, RESEARCH_WRITE_SYSTEM, sourcesAppendix, unansweredFrom, type ResearchRun } from './research-run.js';
import type { SpotifyClient } from '../spotify/client.js';
import { fallbackSessionTitle, isThinOpening, normalizeGeneratedSessionTitle, SessionResolutionError, type SessionRepository } from '../sessions/index.js';
import { PLAYER_CONTROLS, handlePlayerAction, formatNowPlaying } from '../spotify/ui.js';
import { getCloudTokenStore } from '../cloud/token-store.js';
import {
  approveTelegramPendingRequest,
  approveTelegramPendingRequestByPairingCode,
  clearTelegramAccess,
  demoteTelegramAdmin,
  getTelegramAccessSummary,
  getTelegramApprovedUsers,
  getTelegramPendingRequests,
  promoteTelegramUserToAdmin,
  rejectTelegramPendingRequest,
  removeTelegramUser,
  saveConfig,
  loadConfig,
  getActiveProviders,
  getDiscordAccessSummary,
  hasDiscordAdmins,
  findDiscordPendingRequest,
  approveDiscordPendingRequest,
  approveDiscordPendingRequestByPairingCode,
  rejectDiscordPendingRequest as rejectDiscordPendingRequestConfig,
  removeDiscordUser,
  clearDiscordAccess,
  getSlackAccessSummary,
  hasSlackAdmins,
  findSlackPendingRequest,
  approveSlackPendingRequest,
  approveSlackPendingRequestByPairingCode,
  rejectSlackPendingRequest as rejectSlackPendingRequestConfig,
  removeSlackUser,
  clearSlackAccess,
} from '../utils/config.js';
import { fetchProviderModelCatalog, getPreferredModelsForProvider } from '../utils/provider-models.js';
import { WorkLedger, type WorkEntry } from './work-ledger.js';
import { MAX_PROVIDER_ATTEMPT_MS, MAX_AUTOMATIC_CONTINUATIONS, needsContinuationApproval, needsRetryApproval, withAbortDeadline } from './execution-limits.js';
import { requiresFinalSend } from './response-delivery.js';
import { updateCliProviderStatus } from './provider-status.js';
import { compactConversation } from './memory-governor.js';
import { writeCrashFlag } from './crash-flag.js';
import { summarizeSilentTurn, type TurnAction } from './silent-turn.js';
import { classifyStreamCompletion, isLengthTruncation, truncationContinuationPrompt, toolTruncationContinuationPrompt } from './stream-completion.js';
import { MAX_EXECUTE_CONTINUATIONS, MAX_VERIFICATION_CONTINUATIONS, executeContinuationPrompt, shouldForceExecuteContinuation, isFailedToolResult, shouldRequireVerification, isVerificationOutputOk, verificationPrompt, responseAsksUser, EXECUTE_MUTATING_TOOLS, VERIFICATION_COMMAND_PATTERN, wakeUpPrompt } from './execute-guard.js';
import { classifyTurnEnd, stepsExhaustedPrompt, STEPS_PAUSED_BANNER, WORK_NOT_STARTED_BANNER, VERIFICATION_FAILED_BANNER, type LoopEndCause } from './completion-verdict.js';
import { HISTORY_TOKEN_BUDGET, HISTORY_TOKEN_BUDGET_SAVER, TOOL_TRACE_KIND, selectHistoryWindow, buildModelHistory, withReasoningParts, formatToolTrace, formatToolTraceLine, summarizeToolArgs, summarizeToolResult, detectRepetitionLoop } from './context-window.js';
import { buildSystemPrompt as assembleSystemPrompt, buildSystemPromptParts, budgetContext, type SystemPromptInputs } from './system-prompt.js';
import { buildStatusVerbPrompt, parseStatusVerbs, shouldRefreshStatusVerbs } from './status-verbs.js';
import { verbPoolFor } from '../ui/status-word.js';
import { StallWatchdog } from './stall-watchdog.js';
import { setProgressPulse } from './progress-pulse.js';
import { selectActiveTools } from './tool-exposure.js';
import { ToolDiscovery } from './tool-discovery.js';
import { createTaskSurface, type DoneInput } from './task-surface.js';
import { buildFileChangePreview } from '../utils/file-preview.js';
import { whatsNewText } from '../utils/whats-new.js';
import { handleBotsCommand as handleBotsCommandImpl } from './commands/bots-command.js';
import { modelSeesImages, withAttachments } from './attachments.js';
import { attachmentRefs } from '../web/api/uploads.js';
import { AlertGate } from './alert-gate.js';
import { setToolVision } from '../capabilities/tool-images.js';
import { visionProfile } from './vision-profile.js';
import { handleCallCommand } from '../plugins/call-schedule.js';
import { handlePluginsCommand, tryPluginCommand, hasPluginDialog, answerPluginDialog } from '../plugins/commands.js';
import { handleChatCommand as handleChatCommandImpl } from './commands/chat-command.js';
import { formatCounts, formatLearnedLine } from './commands/memory-commands.js';
import { handleBgCommand as handleBgCommandImpl } from './commands/bg-command.js';
import { handleSaverCommand as handleSaverCommandImpl } from './commands/saver-command.js';
import { handleSessionCommand as handleSessionCommandImpl } from './commands/session-command.js';
import { handleFastPathCommand as handleFastPathCommandImpl } from './commands/fast-path-command.js';
import { openCliMemoryMenu as openCliMemoryMenuImpl } from './commands/cli-memory-menu.js';
import { openMemoryChoiceMenu as openMemoryChoiceMenuImpl } from './commands/memory-choice-menu.js';
import { openCliCommandMenu as openCliCommandMenuImpl } from './commands/cli-command-menu.js';
import { collectTurnSignals, parseToolTraceLines } from '../learning/signals.js';
import { extractBeliefOperations, type ExtractTurn } from '../learning/extract.js';
import { composeLearnedNote, pendingQuestion } from '../learning/announce.js';
import { asksAboutSelf, ownerWords } from '../learning/text.js';

/** Minimum gap between two "☿ Noted" lines on one channel. */
const NOTE_COOLDOWN_MS = 3 * 60 * 1000;
import { runReflection } from '../learning/reflection.js';
import { createOwnerSectionsMemo } from '../learning/owner-brief.js';
import type { ApplyResult } from '../memory/beliefs.js';
import { TurnTrace, toolSummary } from './turn-trace.js';
import { applyMediaIntent } from '../media/intent.js';
import { getSpeechService, speakableText, voiceReplyWanted } from '../media/speech.js';
import { loadMediaPrefs } from '../media/prefs.js';
import { mediaJobs, type MediaJob } from '../media/jobs.js';
import { claimEffortChat } from '../utils/model-prefs.js';
import { claimExposureForTurn, exposure, type Exposure } from '../security/provenance.js';
import { noteMessageExposure } from '../security/message-exposure.js';
import { TurnUsage, billingEntries, type SourceUsageTotals, type StepUsageLike, type TurnUsageTotals } from './turn-usage.js';

/**
 * Step-aware text stream for the TUI. The SDK's textStream concatenates
 * the narration of EVERY agentic step back-to-back with no separator —
 * on longer /code tasks that produced word salad ("Building it
 * now.Clean slate.Now scaffolding…Next.js project scaffolded…") as each
 * tool step narrated and then handed off to the next. This wraps
 * fullStream and inserts paragraph breaks at step boundaries so each
 * step's narration reads as its own block.
 */
export function stepAwareTextStream(
  fullStream: AsyncIterable<any>,
  onReasoning?: (preview: string | null, delta?: string) => void,
): AsyncIterable<string> {
  return (async function* () {
    let firstStep = true;
    let sawTextInStep = false;
    let reasoningBuf = '';
    for await (const part of fullStream) {
      // Step boundary: AI SDK 6 emits 'start-step' (the v4/v5 name was
      // 'step-start'). Matching only the old name meant the separator never
      // fired — every step's narration ran into the next as word salad
      // ("…in this project.Found the situation…") in the live tail.
      if (part.type === 'start-step' || part.type === 'step-start') {
        // A new step's thinking is its own block on screen.
        if (reasoningBuf) {
          reasoningBuf = '';
          onReasoning?.(null);
        }
        if (!firstStep && sawTextInStep) yield '\n\n';
        firstStep = false;
        sawTextInStep = false;
        continue;
      }
      if ((part.type === 'tool-call' || part.type === 'tool-input-start') && reasoningBuf) {
        reasoningBuf = '';
        onReasoning?.(null);
        continue;
      }
      if (part.type === 'reasoning-delta' && part.text) {
        // Live thinking feedback: the model reasoning before speaking is
        // surfaced as a preview instead of dead air.
        reasoningBuf = (reasoningBuf + part.text).slice(-400);
        onReasoning?.(reasoningBuf.slice(-160), part.text);
        continue;
      }
      if (part.type === 'text-delta' && part.text) {
        if (reasoningBuf) {
          reasoningBuf = '';
          onReasoning?.(null);
        }
        sawTextInStep = true;
        yield part.text;
      }
    }
    onReasoning?.(null);
  })();
}



/**
 * Tools allowed on a GUARD-FORCED step: MUTATING tools only. The forced
 * step must be real work — a narration-prone model satisfied toolChoice
 * 'required' by calling list_dir/read_file every round (inspection instead
 * of action), burning all guard rounds and pausing. The grounding message
 * already gives it the directory listing, so inspection is unnecessary;
 * if it truly must read, run_command is available (and permission-gated).
 */
const FORCED_ACTION_TOOLS = [...EXECUTE_MUTATING_TOOLS];

class ToolCallLoopDetector {
  private recentCalls: Array<{ tool: string; params: string; failed: boolean; timestamp: number }> = [];
  private totalCalls = 0;
  private hardAborted = false;
  private recentStepTexts: Array<string> = [];
  private consecutiveNoActionSteps = 0;

  // --- Limits ---
  private static readonly ABSOLUTE_MAX = 75;
  private static readonly FAILED_ABSOLUTE_MAX = 20;
  private static readonly NO_ACTION_MAX = 6;

  // Tools that naturally repeat in productive work
  private static readonly HIGH_TOLERANCE_TOOLS = new Set([
    'fetch_url', 'read_file', 'list_dir', 'web_search', 'github_api',
    'run_command', 'edit_file', 'write_file', 'create_file',
    'git_status', 'git_diff', 'git_log',
  ]);

  // --- Thresholds ---
  // Identical = same tool + same params (always a true loop)
  private static readonly IDENTICAL_THRESHOLD = 4;
  // Similar = same tool, all failing
  private static readonly SIMILAR_THRESHOLD = 6;
  // Text repetition in model output
  private static readonly TEXT_REPEAT_THRESHOLD = 4;
  private static readonly MAX_STEP_TEXTS = 15;

  record(toolName: string, params: Record<string, any>, failed: boolean = false): void {
    const paramsKey = JSON.stringify(params).slice(0, 300);
    this.recentCalls.push({ tool: toolName, params: paramsKey, failed, timestamp: Date.now() });
    this.totalCalls++;
    this.consecutiveNoActionSteps = 0;
    if (this.recentCalls.length > 40) {
      this.recentCalls.shift();
    }
  }

  recordNoActionResult(): boolean {
    this.consecutiveNoActionSteps++;
    return this.consecutiveNoActionSteps >= ToolCallLoopDetector.NO_ACTION_MAX;
  }

  recordStepText(text: string): void {
    if (!text || text.length < 10) return;
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!normalized) return;
    this.recentStepTexts.push(normalized);
    if (this.recentStepTexts.length > ToolCallLoopDetector.MAX_STEP_TEXTS) {
      this.recentStepTexts.shift();
    }
  }

  detectAbsoluteLimit(): boolean {
    if (this.totalCalls >= ToolCallLoopDetector.ABSOLUTE_MAX) return true;
    const failCount = this.recentCalls.filter(c => c.failed).length;
    if (failCount >= ToolCallLoopDetector.FAILED_ABSOLUTE_MAX) return true;
    return false;
  }

  /**
   * Identical loop: same tool + exact same params repeated.
   * This is always a true stuck loop — no productive work produces identical calls.
   */
  detectIdentical(): { tool: string; count: number; message: string } | null {
    if (this.recentCalls.length < 3) return null;
    const last = this.recentCalls[this.recentCalls.length - 1];
    let identicalCount = 0;
    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      if (this.recentCalls[i].tool === last.tool && this.recentCalls[i].params === last.params) {
        identicalCount++;
      } else {
        break;
      }
    }
    if (identicalCount >= ToolCallLoopDetector.IDENTICAL_THRESHOLD) {
      this.hardAborted = true;
      return {
        tool: last.tool,
        count: identicalCount,
        message: `Identical call detected: "${last.tool}" called ${identicalCount}x with the exact same parameters.`,
      };
    }
    return null;
  }

  /**
   * Failing loop: same tool called repeatedly, all calls failing.
   * Different params but consistently failing = stuck on a broken approach.
   */
  detectSimilarLoop(): { tool: string; count: number; message: string } | null {
    if (this.recentCalls.length < 4) return null;
    const last = this.recentCalls[this.recentCalls.length - 1];
    let failCount = 0;
    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      const call = this.recentCalls[i];
      if (call.tool !== last.tool) break;
      if (call.failed) failCount++;
      else break;
    }
    if (failCount >= ToolCallLoopDetector.SIMILAR_THRESHOLD) {
      this.hardAborted = true;
      return {
        tool: last.tool,
        count: failCount,
        message: `Failing loop: "${last.tool}" called ${failCount}x, all failing.`,
      };
    }
    return null;
  }

  detectTextRepetition(): { pattern: string; count: number } | null {
    if (this.recentStepTexts.length < ToolCallLoopDetector.TEXT_REPEAT_THRESHOLD) return null;
    const texts = this.recentStepTexts;
    const last = texts[texts.length - 1];
    let repeatCount = 0;
    for (let i = texts.length - 1; i >= 0; i--) {
      if (this.textSimilarity(last, texts[i]) >= 0.7) repeatCount++;
      else break;
    }
    if (repeatCount >= ToolCallLoopDetector.TEXT_REPEAT_THRESHOLD) {
      return { pattern: last.slice(0, 60), count: repeatCount };
    }
    return null;
  }

  private textSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const setA = new Set(a.split(' '));
    const setB = new Set(b.split(' '));
    const intersection = [...setA].filter(w => setB.has(w)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * Smart repetition analysis: detects same-tool runs but evaluates whether
   * the work is productive based on parameter diversity and success rate.
   *
   * Returns null if no concern, or an analysis object with:
   * - tool, count: what's repeating
   * - paramDiversity: 0-1, how varied the parameters are (1 = all unique)
   * - successRate: 0-1, fraction of calls that succeeded
   * - verdict: 'productive' | 'suspicious' | 'stuck'
   */
  analyzeRepetition(): {
    tool: string;
    count: number;
    paramDiversity: number;
    successRate: number;
    verdict: 'productive' | 'suspicious' | 'stuck';
  } | null {
    if (this.recentCalls.length < 5) return null;

    // Find the consecutive run of the same tool
    const last = this.recentCalls[this.recentCalls.length - 1];
    const run: typeof this.recentCalls = [];
    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      if (this.recentCalls[i].tool === last.tool) run.unshift(this.recentCalls[i]);
      else break;
    }

    // Need a meaningful run length to analyze
    const isHigh = ToolCallLoopDetector.HIGH_TOLERANCE_TOOLS.has(last.tool);
    const minRun = isHigh ? 10 : 6;
    if (run.length < minRun) return null;

    // Parameter diversity: how many unique param sets vs total calls
    const uniqueParams = new Set(run.map(c => c.params));
    const paramDiversity = uniqueParams.size / run.length;

    // Success rate
    const successes = run.filter(c => !c.failed).length;
    const successRate = successes / run.length;

    // Verdict logic
    let verdict: 'productive' | 'suspicious' | 'stuck';
    if (paramDiversity >= 0.6 && successRate >= 0.7) {
      // High diversity + mostly succeeding = productive iteration
      // e.g., fetching 20 different URLs, reading 15 different files
      verdict = 'productive';
    } else if (successRate < 0.3) {
      // Mostly failing = stuck
      verdict = 'stuck';
    } else if (paramDiversity < 0.2 && successRate < 0.5) {
      // Low diversity + mediocre success = suspicious
      verdict = 'stuck';
    } else if (paramDiversity < 0.3) {
      // Low diversity but succeeding — suspicious (might be retrying similar things)
      verdict = 'suspicious';
    } else {
      // Moderate diversity, moderate success — let it run but flag
      verdict = 'suspicious';
    }

    return {
      tool: last.tool,
      count: run.length,
      paramDiversity,
      successRate,
      verdict,
    };
  }

  isHardAborted(): boolean {
    return this.hardAborted;
  }

  /** Return human-readable summaries of recent calls for AI self-check */
  getRecentCallSummaries(): string[] {
    return this.recentCalls.slice(-10).map(c => {
      const params = c.params.length > 100 ? c.params.slice(0, 97) + '...' : c.params;
      return `${c.tool}(${params})${c.failed ? ' [FAILED]' : ' [OK]'}`;
    });
  }

  /** Reset all loop detection state */
  reset(): void {
    this.recentCalls = [];
    this.totalCalls = 0;
    this.hardAborted = false;
    this.recentStepTexts = [];
    this.consecutiveNoActionSteps = 0;
  }
}

// AI SDK warnings go to Mercury's logger, never straight to the terminal: a raw
// console.warn lands in the middle of the TUI's live region and the renderer
// then erases the wrong rows (a stuck "Processing" block in the transcript).
(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = (options: { warnings: unknown[]; provider?: string; model?: string }) => {
  logger.warn({ warnings: options.warnings, provider: options.provider, model: options.model }, 'AI SDK warning');
};

// Test/soak override: MERCURY_MAX_STEPS=3 forces cheap step-budget
// exhaustion to exercise the completion contract end to end.
/**
 * The value a tool returned. AI SDK v6 tool results carry it as `output`;
 * older shapes used `result`. Reading only `.result` stringified the whole
 * envelope, so failures were detected by accident and the loop detector's
 * failed flag never fired.
 */
/**
 * The result of toolCalls[i]. Results of parallel calls don't always come
 * back in call order, so match by the call's id; by position only when there
 * is no id. (By position, a fetch_url step showed a search's results.)
 */
export function resultFor(toolCalls: readonly unknown[] | undefined, toolResults: readonly unknown[] | undefined, i: number): unknown {
  if (!toolResults) return undefined;
  const id = (toolCalls?.[i] as { toolCallId?: unknown } | undefined)?.toolCallId;
  if (typeof id === 'string' && id) {
    const match = toolResults.find((r) => (r as { toolCallId?: unknown } | null)?.toolCallId === id);
    if (match !== undefined) return match;
  }
  return toolResults[i];
}

export function toolResultValue(tr: unknown): unknown {
  if (tr && typeof tr === 'object') {
    const o = tr as { output?: unknown; result?: unknown };
    if (o.output !== undefined) return o.output;
    if (o.result !== undefined) return o.result;
  }
  return tr;
}

export const MAX_STEPS = (() => {
  const override = Number(process.env.MERCURY_MAX_STEPS);
  return Number.isFinite(override) && override > 0 ? Math.floor(override) : 75;
})();
// No Mercury-imposed size limit: a single-file app write is emitted AS
// tool-call arguments, so any cap we choose eventually severs a legitimate
// write mid-argument. The ceiling below is deliberately far above any
// mainstream model's NATIVE output limit — the model's own limit governs,
// not ours. If a provider still rejects the value, the adaptive clamp in
// the attempt loop halves it and retries.
const MODEL_OUTPUT_TOKEN_LIMIT = 32768;
const HEARTBEAT_INITIAL_MS = 20000;
const HEARTBEAT_MAX_MS = 60000;
/** Telegram hides a typing action after ~5s; refresh it from progress under that window. */
const TYPING_REFRESH_MS = 4000;
const LONG_TASK_HANDOFF_SUGGEST_MS = 45000;
const MAX_STALL_MS = 4 * 60 * 1000;
/** No chunk at all from a provider within this window → next provider (ADR-039). */
const FIRST_RESPONSE_TIMEOUT_MS = 150_000;
const MAX_SELF_CHECKS = 3; // max AI self-checks per request before hard-aborting

/**
 * Heuristic: does this message look like a deep-research request that would
 * benefit from full research mode? Conservative — false negatives just fall
 * through to a normal answer, so we prefer specificity over recall.
 */
function looksResearchy(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 24) return false; // too short to be a research question
  if (t.startsWith('/')) return false;

  // Temporal / event research signals
  const temporal = /\b(happened|occurr?ed|took place|what (did|do) .* (say|report|find)|recent|last (week|month|year|few)|(\d+)\s*(days?|weeks?|months?|years?) (ago|back|earlier)|today'?s news|this week|this month|this year)\b/;
  // Deep / comparative / explain signals
  const deep = /\b(research|investigate|deep dive|in[- ]depth|explain in detail|comprehensive (guide|overview|analysis)|compare (and )?contrast|state of|history of|causes? of|impact of|effects? of|timeline of|breakdown of|everything about)\b/;
  // Factual lookup signals
  const factual = /\b(latest|current state|what is .* (situation|status)|what are the (options|alternatives|risks|benefits))\b/;

  return temporal.test(t) || deep.test(t) || factual.test(t);
}

/** No answer to the Mercury Code hand-off prompt is treated as "keep chatting". */
export const MERCURY_CODE_HANDOFF_TIMEOUT_MS = 45_000;

/**
 * Fleet-control verbs: `/bot <verb> …` where the first token resolves to NO
 * configured bot is a control command typed on the message slash — it is
 * routed to the /bots surface instead of failing as an unknown target.
 * (A bot actually named e.g. "start" always wins — bot resolution first.)
 */
export const BOT_CONTROL_VERBS = new Set([
  'start', 'stop', 'pause', 'enable', 'disable', 'run', 'open', 'send',
  'journal', 'inbox', 'budget', 'edit', 'delete', 'replay', 'list', 'dlq', 'storage',
]);

/**
 * Whitelabel a provider error into one short, respectful line for the chat:
 * the user gets the real reason (token expired, rate limit, server error) —
 * never a stack trace or raw HTTP dump.
 */
export function whitelabelProviderError(err: any): string {
  const raw = String(err?.message || err || 'unknown error');
  const body = typeof (err as any)?.responseBody === 'string' ? (err as any).responseBody : '';
  const combined = `${raw} ${body}`;

  if (/401|invalid[_ -]?api[_ -]?key|token expired|expired token|invalid_api_key|unauthorized|authentication|credential/i.test(combined)) {
    return 'Access token expired or rejected (credentials)';
  }
  if (/403|forbidden|permission/i.test(combined)) {
    return 'The provider refused the request (permissions/quota)';
  }
  // OpenAI Codex usage limit: the error body carries a reset timestamp —
  // surface it, the user needs to know when the plan window reopens.
  const resetsAt = Number((err as any)?.resets_at ?? /"resets_at":\s*(\d+)/.exec(body)?.[1]);
  if (Number.isFinite(resetsAt) && resetsAt > 0) {
    return `Usage limit reached on this plan — resets ${new Date(resetsAt * 1000).toLocaleTimeString()}`;
  }
  if (/429|rate limit|too many requests/i.test(combined)) {
    return 'Rate limited — too many requests right now';
  }
  if (/max[_ -]?tokens|context (length|window)|too large|exceed/i.test(combined)) {
    return 'The request exceeded the model limit';
  }
  if (/(5\d\d|bad gateway|service unavailable|timeout|timed out|ECONNRESET|ENOTFOUND|fetch failed|network)/i.test(combined)) {
    return 'Provider server error or network timeout';
  }
  return raw.split('\n')[0].replace(/\s+/g, ' ').slice(0, 120) || 'unknown error';
}

/**
 * Coding-shaped task detector for the Mercury Code hand-off prompt.
 * Conservative — only messages that clearly describe build/repair work on a
 * codebase match (build/repair verbs + code artifacts, source-file paths,
 * shell/package-manager commands, or fenced code). Conceptual chat questions
 * about code ("what is a pointer", "explain recursion") never match, so the
 * prompt stays rare.
 */
export function looksLikeCodingTask(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 16 || t.startsWith('/')) return false;

  // Concept-chat noise never prompts.
  const chatNoise = /\b(what is|what's|whats|who is|explain|difference between|meaning of|how does|how do)\b/;
  if (chatNoise.test(t)) return false;

  const intent = /\b(implement|refactor|write|create|build|develop|add|fix|debug|migrate|restructure|scaffold|optimize|clean up|cleanup)\b/;
  const artifact = /\b(code|function|method|class|component|module|feature|endpoint|api|route|handler|script|library|package|bug|regression|test suite|codebase|repository|repo|app|application|plugin|migration|schema|database|service|ui|frontend|backend)\b/;
  const pathOrCommand = /(^|[\s"'(])[\w./@~-]+\.(ts|tsx|js|jsx|py|rs|go|java|kt|rb|php|c|cpp|cs|swift|sh)\b|\b(npm|pnpm|yarn|pip|cargo|git|docker|make|gradle|mvn)\s+\w+/;
  const fence = /```/;

  return (intent.test(t) && artifact.test(t)) || pathOrCommand.test(t) || fence.test(t);
}


export type AbortReason = 'stalled' | 'time-limit' | 'memory-pressure' | 'backgrounded' | 'stopped' | 'halted';
/** Aborts that come from the owner: final for the turn, never retried or resumed (ADR-038). */
export type CancelReason = 'stopped' | 'halted' | 'backgrounded';

/** What the chat is told when the owner ended its turn. */
export function stopNoteFor(reason: CancelReason): string {
  if (reason === 'backgrounded') return 'This task was moved to the background and will report back when it finishes.';
  return `⏹ Task ${reason}. Its work entry was cancelled — a restart will not resume it. Send the request again or ask me to continue if you change your mind.`;
}
const CANCEL_REASONS: ReadonlySet<AbortReason> = new Set<AbortReason>(['stopped', 'halted', 'backgrounded']);

/** One running turn (ADR-037): everything that used to be a single field on the agent. */
interface TurnState {
  readonly id: string;
  readonly laneKey: string;
  readonly message: ChannelMessage;
  readonly startedAt: number;
  abort: AbortController | null;
  abortReason: AbortReason | null;
  /**
   * Set once the owner stops this turn (/stop, /halt, Stop button, /bg
   * current) and never cleared (ADR-038). Internal recovery (stall retry,
   * provider fallback, continuation rounds, durable retry) checks it and
   * gives up; a new abort controller is born aborted.
   */
  cancelled: CancelReason | null;
  activity: string;
  completedStepCount: number;
  stepNarrative: import('../utils/tool-label.js').NarrativeStep[];
  workKey: string | null;
  lastProgressAt: number;
  lastTypingAt: number;
  injectedBeliefIds: string[];
  readonly lifecycle: Lifecycle;
  /** A desktop Code session's own programming mode; null = the global one. */
  programming: ProgrammingMode | null;
  /** Set once the turn has fully ended (late timers check it). */
  done: boolean;
  /** What the turn thought and ran, in order: kept with the reply (turn-trace.ts). */
  readonly trace: TurnTrace;
}

/** The canonical session a message names, if any. */
function sessionOf(msg: ChannelMessage): string | undefined {
  return msg.sessionId ?? (typeof msg.metadata?.sessionId === 'string' ? msg.metadata.sessionId : undefined);
}

/**
 * The lane a message runs in: one turn at a time per lane, lanes run
 * concurrently (ADR-037). A canonical session id when the message names
 * one; else the channel's conversation. The terminal is one lane.
 */
export function laneKeyFor(msg: ChannelMessage): string {
  if (msg.channelType === 'cli') return 'cli';
  const sessionId = msg.sessionId ?? (typeof msg.metadata?.sessionId === 'string' ? msg.metadata.sessionId : undefined);
  if (sessionId) return `session:${sessionId}`;
  if (msg.channelType === 'internal') {
    const task = typeof msg.metadata?.scheduledTaskId === 'string' ? msg.metadata.scheduledTaskId : msg.channelId;
    return `internal:${task}`;
  }
  const conversation = typeof msg.metadata?.externalConversationId === 'string' ? msg.metadata.externalConversationId : msg.channelId;
  return `${msg.channelType}:${conversation}`;
}

export class Agent {
  private readonly globalLifecycle: Lifecycle;
  readonly scheduler: Scheduler;
  readonly capabilities: CapabilityRegistry;
  private running = false;
  /** Messages waiting for their chat's lane (and a free slot), in order (ADR-037). */
  private messageQueue: Array<{ message: ChannelMessage; workKey?: string }> = [];
  private queuedWorkKeys = new Set<string>();
  /**
   * Concurrent sessions (ADR-037). One running turn per lane (a chat /
   * session); different lanes run at once, as many as the governor admits.
   * Each turn's state lives in its own TurnState, carried through
   * everything the turn awaits by `turnStore`; the fields below
   * (currentMessage, currentAbort, …) read and write the CALLING turn's.
   */
  private readonly activeTurns = new Map<string, TurnState>();
  private readonly turnStore = new AsyncLocalStorage<TurnState>();
  readonly governor: TurnGovernor;
  private turnSeq = 0;
  private lastAdmitRefusal: string | null = null;
  /** Each chat's working directory between its turns (the terminal's is the registry-wide one). */
  private readonly laneCwd = new Map<string, string>();
  telegramStreaming: boolean;

  /** The calling turn, if the calling code runs inside one. */
  private turn(): TurnState | undefined {
    return this.turnStore.getStore();
  }

  /**
   * The chat the calling code runs in (the turn's lane: a desktop thread
   * id, "cli", or a channel conversation); undefined outside a turn. Keys a
   * chat's own settings, such as its effort override.
   */
  currentChatKey(): string | undefined {
    return this.turn()?.laneKey;
  }

  /** Is any turn running? (Use isLaneBusy / turnForChannel for one chat.) */
  get processing(): boolean {
    return this.activeTurns.size > 0;
  }

  /** How many turns are running right now. */
  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  /** The calling turn's message (null outside a turn). */
  get currentMessage(): ChannelMessage | null {
    return this.turn()?.message ?? null;
  }

  get currentAbort(): AbortController | null {
    return this.turn()?.abort ?? null;
  }
  set currentAbort(value: AbortController | null) {
    const t = this.turn();
    if (!t) return;
    t.abort = value;
    // A stopped turn never gets a live controller back: a retry that makes a
    // fresh one (stall recovery) finds it already aborted.
    if (t.cancelled && value && !value.signal.aborted) value.abort(new Error(`Task ${t.cancelled} by the user`));
  }

  /** The calling turn's abort reason; once the owner stopped it, always that (ADR-038). */
  get currentAbortReason(): AbortReason | null {
    const t = this.turn();
    return t?.cancelled ?? t?.abortReason ?? null;
  }
  set currentAbortReason(value: AbortReason | null) {
    const t = this.turn();
    if (!t) return;
    // Internal handling (stall, time limit, memory) may set or clear its own
    // reason; it can never overwrite or clear the owner's stop.
    if (t.cancelled) return;
    t.abortReason = value;
  }

  /** Has the owner stopped the calling turn? Every retry/continue path asks this. */
  private turnCancelled(): boolean {
    return this.turn()?.cancelled != null;
  }

  private get lastProgressAt(): number {
    return this.turn()?.lastProgressAt ?? 0;
  }
  private set lastProgressAt(value: number) {
    const t = this.turn();
    if (t) t.lastProgressAt = value;
  }

  get currentActivity(): string {
    return this.turn()?.activity ?? '';
  }
  set currentActivity(value: string) {
    const t = this.turn();
    if (t) t.activity = value;
  }

  get completedStepCount(): number {
    return this.turn()?.completedStepCount ?? 0;
  }
  set completedStepCount(value: number) {
    const t = this.turn();
    if (t) t.completedStepCount = value;
  }

  get stepNarrative(): import('../utils/tool-label.js').NarrativeStep[] {
    return this.turn()?.stepNarrative ?? [];
  }
  set stepNarrative(value: import('../utils/tool-label.js').NarrativeStep[]) {
    const t = this.turn();
    if (t) t.stepNarrative = value;
  }

  private get currentWorkKey(): string | null {
    return this.turn()?.workKey ?? null;
  }
  private set currentWorkKey(value: string | null) {
    const t = this.turn();
    if (t) t.workKey = value;
  }

  private get lastTypingAt(): number {
    return this.turn()?.lastTypingAt ?? 0;
  }
  private set lastTypingAt(value: number) {
    const t = this.turn();
    if (t) t.lastTypingAt = value;
  }

  /** Beliefs injected into the calling turn's prompt (set by retrieveMemoryContext, ADR-026). */
  get lastInjectedBeliefIds(): string[] {
    return this.turn()?.injectedBeliefIds ?? [];
  }
  set lastInjectedBeliefIds(value: string[]) {
    const t = this.turn();
    if (t) t.injectedBeliefIds = value;
  }

  /**
   * The calling turn's lifecycle (thinking → responding → idle); outside a
   * turn, the runtime's own (birth, sleep, idle).
   */
  get lifecycle(): Lifecycle {
    return this.turn()?.lifecycle ?? this.globalLifecycle;
  }

  /**
   * The calling turn's programming mode: a desktop Code session's own one
   * inside its turns, else the terminal's (global) one.
   */
  get programmingMode(): ProgrammingMode {
    return this.turn()?.programming ?? this.globalProgrammingMode;
  }
  supervisor?: import('../core/supervisor.js').SubAgentSupervisor;
  botManager?: import('../bots/bot-manager.js').BotManager;
  /** Bot awaiting a persona from the next message (post-create setup flow). */
  /**
   * A terminal beside a live daemon (ADR-024): the daemon owns persisted
   * schedules, interrupted-work recovery and undelivered replies — running
   * them here too would fire every cron twice and replay work twice.
   */
  terminalOnly = false;
  pendingPersonaFor: string | null = null;
  /** The chat whose next message is the persona (Telegram/web/Discord — channels without a bot thread). */
  pendingPersonaChannelId: string | null = null;
  /** True while the pending persona capture belongs to a JUST-created bot —
   * gates the fleet (solo vs lead) onboarding step in finalizePersona. */
  pendingPersonaNewlyCreated = false;
  /** Bot awaiting a daily token budget answer (final onboarding step). */
  pendingBudgetFor: string | null = null;
  /** Owner Model (ADR-026): per chat, the numbering of the last belief list printed
   * (`/memory learned|beliefs|contested`), so `/memory confirm <n>` knows what n is. */
  readonly lastBeliefListing = new Map<string, string[]>();
  /** Owner Model (ADR-026): per chat, the belief announced by the last `☿ Noted:` line,
   * so a plain "forget that" undoes it. Set by the per-turn learner; cleared on undo. */
  readonly lastNotedBeliefId = new Map<string, string>();
  /** When the last "☿ Noted" went out per channel: at most one every few minutes, so an upgrade's backlog never floods a chat. */
  private readonly lastNotedAt = new Map<string, number>();
  /** The terminal's programming mode (and every turn's that isn't a desktop Code session). */
  readonly globalProgrammingMode: ProgrammingMode;
  readonly researchMode: ResearchMode;
  readonly saverMode: SaverMode;
  spotifyClient?: SpotifyClient;
  private skillLoader?: SkillLoader;
  readonly backgroundTasks: BackgroundTaskManager;
  private titleGenerationInFlight = new Set<string>();
  // Mercury Code status-verb refresh (see core/status-verbs.ts): per-session
  // turn counter + in-flight/disabled markers keep the one-shot LLM call rare.
  private statusVerbTurnCount = 0;
  private statusVerbsInFlight = false;
  private statusVerbsDisabled = false;
  sessionSyncEnabled = false;
  private readonly workLedger: WorkLedger;
  private outboxRetryTimer: ReturnType<typeof setInterval> | null = null;
  private replayingOutbox = false;
  /** "About {owner}" / "How to work with {owner}", recomputed only when the beliefs change (keeps the prompt prefix cacheable). */
  private readonly ownerSections = createOwnerSectionsMemo();
  private reflectionInFlight: Promise<void> | null = null;
  /** Per session: beliefs its previous turn acted on; credited as "acted on without objection" once the owner's next message there shows no correction. */
  private readonly pendingActedOn = new Map<string, string[]>();

  constructor(
    public config: MercuryConfig,
    public providers: ProviderRegistry,
    private identity: Identity,
    public shortTerm: ShortTermMemory,
    private longTerm: LongTermMemory,
    private episodic: EpisodicMemory,
    public userMemory: UserMemoryStore | null,
    public channels: ChannelRegistry,
    public tokenBudget: TokenBudget,
    capabilities: CapabilityRegistry,
    scheduler: Scheduler,
    public sessions: SessionRepository,
    private generateTitle?: (input: { userMessage: string; assistantMessage: string; providerName: string }) => Promise<string>,
  ) {
    this.globalLifecycle = new Lifecycle();
    this.scheduler = scheduler;
    this.capabilities = capabilities;
    this.capabilities.setSessionRepository(sessions);
    this.installProgressPulse();
    this.telegramStreaming = config.channels.telegram.streaming ?? true;
    this.globalProgrammingMode = new ProgrammingMode();
    this.researchMode = new ResearchMode();
    // Research runs are per chat: inside a turn, "the" run is that chat's.
    this.researchMode.setScope(() => this.turn()?.message.channelId ?? null);
    this.governor = new TurnGovernor({
      limit: resolveTurnLimit(config.concurrency?.maxTurns, machineFacts()),
      onExit: (heapUsed) => this.exitForMemory(heapUsed),
    });
    logger.info({ maxTurns: this.governor.limit() }, 'Concurrent turns: limit set');
    this.saverMode = new SaverMode(config);
    this.wireResearchModeToCapabilities();
    this.backgroundTasks = new BackgroundTaskManager();
    this.workLedger = new WorkLedger();

    this.backgroundTasks.onGlobalComplete((task) => {
      this.notifyBackgroundTaskComplete(task);
    });

    this.scheduler.setOnScheduledTask(async (manifest, runId) => this.handleScheduledTask(manifest, runId));

    this.channels.onIncomingMessage((msg) => this.enqueueMessage(msg));
    this.wireOwnerApprovals();

    this.scheduler.onHeartbeat(async () => {
      await this.heartbeat();
    });

    // After a migration (or when asked), reflect soon after boot instead of
    // waiting an hour, so migrated candidates are judged against real sessions.
    if (this.userMemory?.beliefs.getMeta('reflection_force') === '1') {
      setTimeout(() => { void this.reflectNow(); }, 2 * 60 * 1000).unref();
    }

    setAskUserHandler(async (question, choices, channelId, channelType) => {
      return this.presentChoice(question, choices, channelId, channelType);
    });
  }

  setSkillLoader(skillLoader: SkillLoader): void {
    this.skillLoader = skillLoader;
  }

  /** Wire the Mercury Bots runtime (see bots/bot-manager.ts, BOTS-ARCHITECTURE.md). */
  setBotManager(botManager: import('../bots/bot-manager.js').BotManager): void {
    this.botManager = botManager;
    botManager.setNotify(async (channelType, channelId, message) => {
      const channel = this.channels.get(channelType as ChannelType);
      if (channel) {
        await channel.send(message, channelId).catch((e) => logger.warn({ e }, 'bot notify channel send failed'));
      }
    });
    botManager.setSendFile(async (channelType, channelId, filePath) => {
      const channel = this.channels.get(channelType as any);
      if (channel) await channel.sendFile(filePath, channelId);
    });
    botManager.setAlert(async (message) => {
      const channel = this.channels.getNotificationChannel();
      // The CLI is NOT a needs-you surface: an alert printed there lands in
      // the main chat (bot thread leak) — the bot's own thread already
      // carries the event via botManager's own notify.
      if (channel && channel.type !== 'cli') {
        await channel.send(message).catch((e) => logger.warn({ e }, 'bot alert send failed'));
      }
    });
  }

  /**
   * Security questions for the owner (owner-approvals): sent to every
   * messaging channel they connected and shown in the CLI here; answered by
   * a reply with the code from an admin of that channel, /server here, or
   * Mercury Desktop on this computer.
   */
  private wireOwnerApprovals(): void {
    const messaging = () => this.channels.getActiveChannels().filter((t) => t !== 'cli' && t !== 'web' && t !== 'internal').map((t) => this.channels.get(t)).filter((ch): ch is NonNullable<typeof ch> => !!ch && ch.isReady() && !ch.noBroadcast);
    const label = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    setApprovalRoutes(() => [...messaging().map((ch) => label(ch.type)), 'this computer (/server or Mercury Desktop)']);
    ownerApprovals().onChange((a, change) => {
      const cli = this.channels.get('cli');
      if (change === 'new') {
        const text = approvalRequestText(a);
        for (const ch of messaging()) void ch.send(text).catch((e) => logger.warn({ e, channel: ch.type }, 'Owner approval: send failed'));
        if (cli instanceof CLIChannel) cli.sendSystemNotice(`${text.replace(/Reply “approve (\w+)” to allow it, or “deny \w+”/, 'Answer with /server approve $1 (or deny $1)')}`);
        const web = this.channels.get('web');
        if (web instanceof WebChannel) web.sendOwnerApproval(a, 'new');
      } else {
        const web = this.channels.get('web');
        if (web instanceof WebChannel) web.sendOwnerApproval(a, 'decided');
      }
    });
    onDeviceNewLocation((device, ip) => {
      const text = newLocationText(device.name, ip);
      for (const ch of messaging()) void ch.send(text).catch(() => {});
      const cli = this.channels.get('cli');
      if (cli instanceof CLIChannel) cli.sendSystemNotice(text);
    });
  }

  /** A messaging-channel reply to a security question. True when it was one (and nothing else should see it). */
  private answerOwnerApproval(msg: ChannelMessage): boolean {
    if (msg.channelType === 'cli' || msg.channelType === 'web' || msg.channelType === 'internal') return false;
    const reply = parseApprovalReply(msg.content);
    if (!reply) return false;
    const pending = ownerApprovals().find(reply.code);
    if (!pending || pending.status !== 'pending') return false;
    const channel = this.channels.getChannelForMessage(msg);
    if (!isOwnerSender(msg)) {
      void channel?.send('Only the owner (an admin of this chat) can answer that.', msg.channelId).catch(() => {});
      audit('action.denied', { who: pending.who, detail: `answer from a non-admin on ${msg.channelType} ignored`, by: msg.channelType });
      return true;
    }
    const decided = ownerApprovals().decide(reply.code, reply.decision, msg.channelType);
    if (!decided) return false;
    if (decided.kind === 'action') audit(decided.status === 'allowed' ? 'action.allowed' : 'action.denied', { who: decided.who, ip: decided.ip, detail: decided.title, by: msg.channelType });
    else if (decided.status === 'denied') audit('pair.denied', { who: decided.who, ip: decided.ip, by: msg.channelType });
    void channel?.send(approvalAnsweredText(decided), msg.channelId).catch(() => {});
    return true;
  }

  getBotManager(): import('../bots/bot-manager.js').BotManager | undefined {
    return this.botManager;
  }

  setSessionSyncEnabled(enabled: boolean): void {
    this.sessionSyncEnabled = enabled;
  }

  isSessionSyncEnabled(): boolean {
    return this.sessionSyncEnabled;
  }

  acknowledgeCloudDelivery(requestId: string): void {
    const key = `request:${requestId}`;
    if (this.workLedger.get(key)) this.workLedger.markDelivered(key);
  }

  private wireResearchModeToCapabilities(): void {
    this.capabilities.setResearchModeGetter(() => this.researchMode.isActive());
  }

  setSupervisor(supervisor: import('../core/supervisor.js').SubAgentSupervisor): void {
    this.supervisor = supervisor;
    supervisor.setSaverMode(this.saverMode);
    supervisor.setNotifyCallback(async (channelType, channelId, message) => {
      const channel = this.channels.get(channelType as any);
      if (channel) {
        await channel.send(message, channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
      }
    });
    supervisor.setLifecycleCallback((event) => {
      const bgTask = this.backgroundTasks.getByAgentId(event.agentId);
      if (!bgTask) return;

      if (event.type === 'progress' && event.progress) {
        this.backgroundTasks.updateAgentProgress(bgTask.id, event.progress);
        this.syncBgTasksToTui();
        return;
      }

      if (event.type === 'complete' && event.result) {
        const result = event.result;
        // A step-budget pause is neither complete nor failed — the supervisor
        // auto-resumes it; the background task stays open meanwhile.
        if (result.status === 'paused') return;
        const status = result.status === 'completed' ? 'completed' : result.status === 'halted' ? 'cancelled' : 'failed';
        this.backgroundTasks.completeAgentTask(bgTask.id, status === 'completed' ? 0 : 1, status, result.output);
        this.syncBgTasksToTui();
      }
    });
  }

  enqueueMessage(msg: ChannelMessage): void {
    logger.info({ from: msg.channelType, content: msg.content.slice(0, 50) }, 'Message enqueued');

    const trimmed = msg.content.trim();

    // "approve K7Q2M": the owner answering a security question (a new device,
    // a remote sensitive action) from their messaging channel.
    if (this.answerOwnerApproval(msg)) return;

    // Onboarding from a chat without a bot thread (Telegram, web, Discord):
    // the next plain message in THAT chat is the new bot's persona — same
    // state machine as the TUI, same choices, just addressed to the chat
    // that asked. A slash command means the owner moved on.
    if (this.pendingPersonaFor && this.pendingPersonaChannelId === msg.channelId && this.botManager) {
      const botId = this.pendingPersonaFor;
      const channel = this.channels.getChannelForMessage(msg);
      if (trimmed.toLowerCase() === '/skip') {
        this.pendingPersonaFor = null;
        this.pendingPersonaChannelId = null;
        channel?.send(`⏭ Keeping the starter persona — change it anytime with \`/bots persona ${botId} <text>\`.`, msg.channelId).catch(() => {});
        return;
      }
      if (trimmed.startsWith('/')) {
        this.pendingPersonaFor = null;
        this.pendingPersonaChannelId = null;
      } else if (channel) {
        this.pendingPersonaChannelId = null;
        this.finalizePersona(this.botManager, botId, trimmed, msg, this.pendingPersonaNewlyCreated).catch((err) => {
          logger.warn({ err, botId }, 'Persona onboarding failed');
        });
        return;
      }
    }

    // Mercury Bots never touch the main message queue — /bots is always
    // fast-path, whether the main loop is busy or idle.
    if (trimmed.startsWith('/bots')) {
      const channel = this.channels.getChannelForMessage(msg);
      if (channel) {
        this.handleBotsCommand(trimmed, msg, channel).catch((err) => {
          logger.error({ err: (err as any)?.message ?? err, content: trimmed.slice(0, 50) }, '/bots command failed');
        });
      }
      return;
    }

    // A plugin setup or menu waiting for an answer in this chat ("2", "+91…").
    if (!trimmed.startsWith('/') && hasPluginDialog(msg.channelId)) {
      const channel = this.channels.getChannelForMessage(msg);
      if (channel) {
        answerPluginDialog(trimmed, msg, channel).catch((err) => {
          logger.error({ err: err instanceof Error ? err.message : err }, 'plugin dialog failed');
        });
        return;
      }
    }

    // /call and /calls: scheduled calls, worked out in code (no model turn).
    if (/^\/calls?(\s|$)/.test(trimmed)) {
      const channel = this.channels.getChannelForMessage(msg);
      if (channel) {
        void channel.send(handleCallCommand(trimmed, msg.senderRole === 'member'), msg.channelId).catch(() => {});
      }
      return;
    }

    // /plugins is fast-path like /bots: installing or toggling a plugin must
    // work while a turn is running (that's often when you notice you need it).
    if (/^\/plugins?(\s|$)/.test(trimmed)) {
      const channel = this.channels.getChannelForMessage(msg);
      if (channel) {
        handlePluginsCommand(trimmed, msg, channel).catch((err) => {
          logger.error({ err: err instanceof Error ? err.message : err, content: trimmed.slice(0, 50) }, '/plugins command failed');
        });
      }
      return;
    }

    // Slash commands contributed by plugins. Built-in names are reserved,
    // so a plugin can never take over /help, /stop, /bots and so on.
    if (trimmed.startsWith('/')) {
      const channel = this.channels.getChannelForMessage(msg);
      if (channel && tryPluginCommand(trimmed, msg, channel)) return;
    }

    // /bot <id> <message> — talk to a named bot from ANY channel (TUI,
    // Telegram, web). Durable enqueue; the run's output is delivered back
    // to the requesting chat via the job's source (Telegram first).
    if (trimmed.startsWith('/bot ')) {
      if (!this.botManager) {
        // Bots disabled: do NOT swallow the message — tell the user and stop.
        const channel = this.channels.getChannelForMessage(msg);
        void channel?.send('Bots are not enabled on this instance (set `bots.enabled: true` in mercury.yaml).', msg.channelId)
          .catch((err) => logger.warn({ err }, 'bots-disabled notice failed'));
        return;
      }
      const rest = trimmed.slice('/bot '.length).trim();
      const spaceIndex = rest.indexOf(' ');
      const rawTarget = (spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)).toLowerCase();
      const message = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1).trim();
      // `/bot start <id>` etc. — a fleet-control verb typed on the message
      // slash: the first token resolves to NO bot, so it was never a target.
      // Route it to /bots (the control surface) instead of failing with a
      // confusing "Could not message start: target_unknown".
      if (BOT_CONTROL_VERBS.has(rawTarget) && !this.botManager.resolveBotId(rawTarget)) {
        const channel = this.channels.getChannelForMessage(msg);
        if (channel) {
          this.handleBotsCommand(trimmed.replace(/^\/bot\b/, '/bots'), msg, channel).catch((err) => {
            logger.error({ err: (err as any)?.message ?? err, content: trimmed.slice(0, 50) }, '/bots command failed');
          });
          return;
        }
      }
      const botId = this.botManager.resolveBotId(rawTarget) ?? rawTarget;
      if (botId && message) {
        void this.dispatchToBot(botId, message, msg);
      }
      return;
    }

    // @<botId|name> <message> — mention-style routing (Telegram groups, etc.).
    // Only intercepts when the first token resolves to a configured bot, so
    // ordinary @-messages are never hijacked.
    if (trimmed.startsWith('@') && this.botManager) {
      const mention = this.parseBotMention(trimmed);
      if (mention) {
        void this.dispatchToBot(mention.botId, mention.message, msg);
        return;
      }
    }

    // /stop is asynchronous: the abort lands, the turn unwinds, THEN the
    // chat's lane frees. A command typed in that window used to be answered
    // "Agent is busy" — wait for the stop to finish and route it normally.
    const lane = laneKeyFor(msg);
    const laneTurn = this.activeTurns.get(lane);
    if (laneTurn && trimmed.startsWith('/') && laneTurn.abortReason && !msg.metadata?.waitedForStop) {
      void this.waitUntilLaneIdle(lane, 5000).then(() => {
        msg.metadata = { ...msg.metadata, waitedForStop: true };
        this.enqueueMessage(msg);
      });
      return;
    }

    // A command for a chat that is busy (or while every slot is taken) is
    // answered on the fast path instead of waiting behind long work.
    if (trimmed.startsWith('/') && (laneTurn || !this.governor.canAdmit(this.activeTurns.size).ok)) {
      this.handleFastPathCommand(msg).catch((err) => {
        logger.error({ err, content: trimmed.slice(0, 50) }, 'Fast-path command failed');
      });
      return;
    }

    let workKey: string | undefined;
    if (!trimmed.startsWith('/')) {
      msg.metadata = {
        ...msg.metadata,
        workCwd: typeof msg.metadata?.workCwd === 'string' ? msg.metadata.workCwd : this.cwdForLane(lane),
      };
      const accepted = this.workLedger.accept(msg);
      workKey = accepted.entry.key;
      if (!accepted.accepted) {
        void this.handleDuplicateWork(accepted.entry);
        return;
      }
    }

    // Research-y message prompt: when research mode is off and the message looks
    // like a deep-research request, ask whether to run a full research pass.
    // Never prompt in Mercury Code (the coding TUI) — its questions are about
    // the repo, not web research, so the prompt is pure friction there.
    const isUserMessage = msg.channelType !== 'internal' && msg.senderId !== 'system' && !trimmed.startsWith('/');
    const promptChannel = this.channels.getChannelForMessage(msg);
    const inMercuryCode = promptChannel instanceof CLIChannel && promptChannel.getTuiState().mercuryCode != null;
    // The word filter only decides whether to ask the model; the model
    // decides whether the owner actually wants a research article. An
    // instruction ("do X with the latest file") or a quick question never
    // gets the prompt, and a failed or slow check means no prompt.
    if (isUserMessage && !inMercuryCode && !this.researchMode.isActive() && looksResearchy(trimmed)) {
      void this.wantsResearch(trimmed).then((wanted) => {
        if (!wanted) {
          this.routeIncoming(msg, workKey, trimmed, isUserMessage, inMercuryCode, promptChannel);
          return;
        }
        this.promptResearchMode(msg, workKey).catch((err) => {
          logger.warn({ err: err.message }, 'Research-mode prompt failed — proceeding with normal message');
          this.queueMessage(msg, workKey);
          this.processQueue();
        });
      });
      return;
    }

    this.routeIncoming(msg, workKey, trimmed, isUserMessage, inMercuryCode, promptChannel);
  }

  /** After the research check: the Mercury Code hand-off, then the queue. */
  private routeIncoming(
    msg: ChannelMessage,
    workKey: string | undefined,
    trimmed: string,
    isUserMessage: boolean,
    inMercuryCode: boolean,
    promptChannel: ReturnType<ChannelRegistry['getChannelForMessage']>,
  ): void {
    // Mercury Code hand-off: in the normal chat TUI, a coding-shaped task may
    // belong in the coding TUI. Ask once; no answer within the timeout is
    // treated as "No" and the request proceeds in normal chat — never blocked.
    // The research prompt takes precedence when both match.
    if (isUserMessage && !inMercuryCode && promptChannel instanceof CLIChannel && looksLikeCodingTask(trimmed)) {
      this.promptMercuryCodeHandoff(promptChannel, msg, workKey).catch((err) => {
        logger.warn({ err: err.message }, 'Mercury Code hand-off prompt failed — proceeding with normal message');
        this.queueMessage(msg, workKey);
        this.processQueue();
      });
      return;
    }

    this.queueMessage(msg, workKey);
    this.processQueue();
  }

  /**
   * Mercury Code hand-off, with SESSION memory (like the session permission
   * modes): an explicit Yes/No is remembered for the current session —
   *
   *   'code'  → later coding tasks auto-switch to Mercury Code, and every
   *            automatic switch says WHY ("you chose it earlier this session")
   *   'chat'  → later coding tasks never ask; they continue in normal chat
   *
   * A TIMEOUT is not a choice — nothing is remembered, and the next coding
   * task asks again. The prompt itself still has a timeout so the request is
   * never left blocked.
   */
  private async promptMercuryCodeHandoff(channel: CLIChannel, msg: ChannelMessage, workKey?: string): Promise<void> {
    const preferenceKey = this.sessions.getOrCreateBound(msg.channelType, 'current', msg.sessionId ?? undefined).id;
    const remembered = this.mercuryCodeHandoffPreferences.get(preferenceKey);

    if (remembered === 'chat') {
      // Remembered "No": keep chatting, never ask again this session.
      this.queueMessage(msg, workKey);
      this.processQueue();
      return;
    }
    if (remembered === 'code') {
      // Remembered "Yes": switch back automatically — and say why.
      const cwd = this.capabilities.getCwd();
      const entered = channel.enterMercuryCode(cwd, channel.getTuiState().version || 'dev');
      if (entered.ok) {
        this.syncProgrammingModeForCode(cwd, channel);
        await channel.send('Switching to Mercury Code — you chose it for coding tasks earlier this session.', msg.channelId).catch(() => {});
      }
      this.queueMessage(msg, workKey);
      this.processQueue();
      return;
    }

    const choice = await this.presentChoiceWithTimeout(
      'This looks like a coding task. Open it in Mercury Code (full-screen coding TUI — plan + build in one flow)?',
      ['Yes — switch to Mercury Code (remembered for this session)', 'No — continue in normal chat (not asked again this session)'],
      msg.channelId,
      msg.channelType,
      MERCURY_CODE_HANDOFF_TIMEOUT_MS,
      1, // time-weighted default: No (not remembered — nobody answered)
    );

    if (choice.startsWith('Yes')) {
      this.mercuryCodeHandoffPreferences.set(preferenceKey, 'code');
      const cwd = this.capabilities.getCwd();
      const entered = channel.enterMercuryCode(cwd, channel.getTuiState().version || 'dev');
      if (entered.ok) {
        this.syncProgrammingModeForCode(cwd, channel);
        await channel.send('Mercury Code active (AUTO) — continuing your request here. I\'ll open it automatically for coding tasks for the rest of this session.', msg.channelId).catch(() => {});
      } else {
        await channel.send(`Could not open Mercury Code (${entered.message}) — continuing in normal chat.`, msg.channelId).catch(() => {});
      }
    } else {
      await channel.send('Continuing in normal chat — I won\'t ask again this session.', msg.channelId).catch(() => {});
    }
    this.queueMessage(msg, workKey);
    this.processQueue();
  }

  /** AUTO flow + project context, mirrored from the /code handler. */
  private syncProgrammingModeForCode(cwd: string, channel: CLIChannel): void {
    this.programmingMode.setAuto();
    this.programmingMode.setProjectContext(cwd);
    channel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
  }

  /**
   * presentChoice with a time-weighted default: if the user does not answer
   * within `timeoutMs`, the fallback choice wins and the work continues; a
   * later answer is discarded. The visible prompt is dismissed on timeout so
   * it never lingers waiting for input nobody will give.
   */
  private async presentChoiceWithTimeout(
    question: string,
    choices: string[],
    channelId: string,
    channelType: string,
    timeoutMs: number,
    fallbackIndex: number,
  ): Promise<string> {
    const fallback = choices[fallbackIndex];
    const channel = this.channels.get(channelType as any);
    const timeoutPromise = new Promise<string>((resolve) => {
      setTimeout(() => {
        if (channel instanceof CLIChannel) channel.resolveChoicePromptWithDefault(String(fallbackIndex));
        resolve(fallback);
      }, timeoutMs);
    });
    return Promise.race([
      this.presentChoice(question, choices, channelId, channelType).catch(() => fallback),
      timeoutPromise,
    ]);
  }

  queueMessage(message: ChannelMessage, workKey?: string): void {
    if (workKey && this.queuedWorkKeys.has(workKey)) return;
    // Someone is waiting on the line: a question asked on a call goes ahead
    // of queued chat work (behind earlier call questions, in order).
    if (message.metadata?.voiceCall === true) {
      let at = 0;
      while (at < this.messageQueue.length && this.messageQueue[at].message.metadata?.voiceCall === true) at++;
      this.messageQueue.splice(at, 0, { message, workKey });
    } else {
      this.messageQueue.push({ message, workKey });
    }
    if (workKey) this.queuedWorkKeys.add(workKey);
    this.announceQueue();
  }

  /**
   * What a waiting message waits for (ADR-037): its own chat's running turn
   * when there is one, else (every slot taken) the oldest running turn.
   */
  private blockingTurnFor(msg: ChannelMessage): TurnState | undefined {
    const own = this.activeTurns.get(laneKeyFor(msg));
    if (own) return own;
    let oldest: TurnState | undefined;
    for (const t of this.activeTurns.values()) if (!oldest || t.startedAt < oldest.startedAt) oldest = t;
    return oldest;
  }

  private describeTurn(t: TurnState): string {
    return (t.activity || t.message.content).replace(/^\W+/u, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'another task';
  }

  /**
   * A waiting message's place in line: the messages ahead of it that start
   * before it — earlier ones in its own chat, and earlier ones from chats
   * that are free (they take the next free slot first). Messages of other
   * busy chats wait for their own chat, not for a slot, so they don't count.
   */
  private positionOf(index: number): number {
    const lane = laneKeyFor(this.messageQueue[index].message);
    let ahead = 0;
    for (let i = 0; i < index; i++) {
      const other = laneKeyFor(this.messageQueue[i].message);
      if (other === lane || !this.activeTurns.has(other)) ahead++;
    }
    return ahead + 1;
  }

  /**
   * Tell every waiting desktop/web chat where it stands: its place in its
   * chat's line, and the turn it waits for (which chat, and what it's
   * doing). Without this a waiting chat showed "Thinking" for a turn that
   * hadn't started.
   */
  private announceQueue(): void {
    if (this.activeTurns.size === 0) return;
    const web = this.channels.get('web') as unknown as { sendQueued?: (t: string, d: { position: number; busyWith?: string; busySessionId?: string }) => void } | undefined;
    if (!web?.sendQueued) return;
    this.messageQueue.forEach((item, i) => {
      const m = item.message;
      if (m.channelType !== 'web') return;
      const blocking = this.blockingTurnFor(m);
      if (!blocking) return;
      // Its own chat is running: that chat already shows the running turn.
      if (blocking.laneKey === laneKeyFor(m)) return;
      const busySessionId = blocking.message.channelType === 'web' ? blocking.message.channelId : undefined;
      web.sendQueued!(m.channelId, { position: this.positionOf(i), busyWith: this.describeTurn(blocking), busySessionId });
    });
  }

  /** Where one chat's work stands, for a chat opened while it waits. */
  queueStateFor(channelId: string): { state: 'running' | 'queued' | 'none'; position?: number; busyWith?: string; busySessionId?: string } {
    if (this.turnForChannel(channelId)) return { state: 'running' };
    const at = this.messageQueue.findIndex((i) => i.message.channelId === channelId);
    if (at === -1) return { state: 'none' };
    const blocking = this.blockingTurnFor(this.messageQueue[at].message);
    return {
      state: 'queued',
      position: this.positionOf(at),
      busyWith: blocking ? this.describeTurn(blocking) : undefined,
      busySessionId: blocking?.message.channelType === 'web' ? blocking.message.channelId : undefined,
    };
  }

  /** The running turn for this chat (by channel id), if any. */
  turnForChannel(channelId: string): TurnState | undefined {
    for (const t of this.activeTurns.values()) if (t.message.channelId === channelId) return t;
    return undefined;
  }

  /** The running turn for a canonical session (a cloud request's channel id is per request; its session is not). */
  turnForSession(sessionId: string): TurnState | undefined {
    for (const t of this.activeTurns.values()) {
      const of = t.message.sessionId ?? (typeof t.message.metadata?.sessionId === 'string' ? t.message.metadata.sessionId : undefined);
      if (of === sessionId) return t;
    }
    return undefined;
  }

  /** Is this message's chat running a turn right now? */
  isLaneBusy(msg: ChannelMessage): boolean {
    return this.activeTurns.has(laneKeyFor(msg));
  }

  /** The running turn of this message's chat, if any (fast-path commands act on it). */
  turnFor(msg: ChannelMessage): TurnState | undefined {
    return this.activeTurns.get(laneKeyFor(msg));
  }

  /** Every running turn, oldest first: what each chat is doing (for /progress, status screens). */
  /**
   * The reply a chat is working on right now, as far as it got: thinking and
   * tool steps (with what still runs), and what it is doing. Undefined when
   * the chat is idle. Lets a screen that left the chat and came back show
   * the turn again instead of a blank.
   */
  liveTurn(id: string): { startedAt: number; activity: string; trace: import('./turn-trace.js').StoredTrace } | undefined {
    const turn = this.turnForSession(id) ?? this.turnForChannel(id);
    if (!turn || turn.done) return undefined;
    return { startedAt: turn.startedAt, activity: turn.activity, trace: turn.trace.peek(turn.startedAt) };
  }

  runningTurns(): Array<{ laneKey: string; channelType: string; channelId: string; sessionId?: string; content: string; activity: string; startedAt: number; completedSteps: number; narrative: import('../utils/tool-label.js').NarrativeStep[] }> {
    return [...this.activeTurns.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((t) => ({
        laneKey: t.laneKey,
        channelType: t.message.channelType,
        channelId: t.message.channelId,
        ...(sessionOf(t.message) ? { sessionId: sessionOf(t.message) } : {}),
        content: t.message.content,
        activity: t.activity,
        startedAt: t.startedAt,
        completedSteps: t.completedStepCount,
        narrative: t.stepNarrative,
      }));
  }

  /**
   * Chats with messages waiting (for their own chat or a free slot), each
   * once, with how many messages wait and the place of its first one.
   */
  waitingChats(): Array<{ channelType: string; channelId: string; sessionId?: string; waiting: number; position: number }> {
    const out = new Map<string, { channelType: string; channelId: string; sessionId?: string; waiting: number; position: number }>();
    this.messageQueue.forEach((item, i) => {
      const lane = laneKeyFor(item.message);
      const known = out.get(lane);
      if (known) { known.waiting++; return; }
      const sessionId = sessionOf(item.message);
      out.set(lane, { channelType: item.message.channelType, channelId: item.message.channelId, ...(sessionId ? { sessionId } : {}), waiting: 1, position: this.positionOf(i) });
    });
    return [...out.values()];
  }

  /** Change how many chats run at once, live (ADR-037); waiting chats start if there is room now. */
  setConcurrentTurnLimit(limit: number): void {
    this.governor.setLimit(limit);
    this.processQueue();
  }

  /**
   * Abort one running turn. Its work entry is cancelled for a user stop (a
   * restart never resumes it); a background hand-off keeps it. Returns
   * false when it was already stopping.
   */
  abortTurn(t: TurnState, reason: AbortReason, ledgerNote?: string): boolean {
    if (t.done) return false;
    if (CANCEL_REASONS.has(reason)) {
      // The owner's stop is recorded even when the controller is already
      // aborted (a stall retry in flight): that retry must not carry on.
      const first = t.cancelled === null;
      if (first) t.cancelled = reason as CancelReason;
      t.abortReason = reason;
      if (t.abort && !t.abort.signal.aborted) t.abort.abort(new Error(`Task ${reason} by the user`));
      if (ledgerNote && t.workKey) {
        try { this.workLedger.markCancelled(t.workKey, ledgerNote); } catch { /* entry may not exist */ }
      }
      return first;
    }
    if (!t.abort || t.abort.signal.aborted) return false;
    t.abortReason = reason;
    t.abort.abort();
    return true;
  }

  /** "Do mine first": this chat's waiting messages move to the front of the line (in their order). */
  prioritize(channelId: string): number {
    const mine = this.messageQueue.filter((i) => i.message.channelId === channelId);
    if (mine.length === 0) return 0;
    this.messageQueue = [...mine, ...this.messageQueue.filter((i) => i.message.channelId !== channelId)];
    this.announceQueue();
    return mine.length;
  }

  /** Is a turn for this session running, or waiting in the queue? */
  /** Messages waiting behind the running one (the updater waits for them). */
  get queuedCount(): number {
    return this.messageQueue.length;
  }

  isBusyWith(sessionId: string): boolean {
    const of = (m: ChannelMessage | null | undefined) => m?.sessionId ?? (typeof m?.metadata?.sessionId === 'string' ? m.metadata.sessionId : undefined);
    for (const t of this.activeTurns.values()) if (of(t.message) === sessionId) return true;
    return this.messageQueue.some((i) => of(i.message) === sessionId);
  }

  /**
   * Where work for one channel stands: running now, waiting in the queue,
   * or neither; and, when it waits, what it waits for.
   */
  workStateFor(channelId: string): { state: 'running' | 'queued' | 'none'; busyWith?: string } {
    if (this.turnForChannel(channelId)) return { state: 'running' };
    const waiting = this.messageQueue.find((i) => i.message.channelId === channelId);
    if (waiting) {
      const blocking = this.blockingTurnFor(waiting.message);
      return { state: 'queued', busyWith: blocking ? this.describeTurn(blocking) : undefined };
    }
    return { state: 'none' };
  }

  private async handleDuplicateWork(entry: WorkEntry): Promise<void> {
    if (entry.status === 'completed' && !entry.delivered && entry.finalResponse) {
      await this.deliverLedgerEntry(entry);
      return;
    }
    const channel = this.channels.getChannelForMessage(entry.message);
    if (!channel || entry.message.channelType === 'internal') return;
    // For the web (Cloud chat) channel, don't send duplicate-status messages
    // to the user. The Cloud dashboard already handles dedup on its end, and
    // sending "This request is already running" creates a bad UX — the user
    // sees a confusing system message instead of silence.
    if (entry.message.channelType === 'web') return;
    const status = entry.status === 'completed'
      ? 'This request already completed and its result was delivered.'
      : entry.status === 'failed'
        ? `This request previously failed: ${entry.error || 'unknown error'}`
        : entry.status === 'paused'
          ? 'This task was paused before completing. Send "continue" to resume it with the work preserved.'
          : entry.status === 'cancelled'
            ? 'This request was cancelled earlier and was not resumed. Send it again if you want Mercury to run it.'
            : `This request is already ${entry.status}${entry.attempts > 0 ? ` (attempt ${entry.attempts})` : ''}.`;
    await channel.send(status, entry.message.channelId).catch((error) => {
      logger.warn({ error, workKey: entry.key }, 'Unable to send duplicate work status');
    });
  }

  /** One folder per chat in the output folder (~/mercury-artifacts/Chats). */
  private chatFolders(): ChatFolders {
    return chatFoldersFor(outputRoot(this.config.artifacts?.outputDir));
  }

  /** Tell screens how a research run stands (the desktop's chip, panel and report card). */
  private emitResearch(msg: ChannelMessage, run: ResearchRun): void {
    const channel = this.channels.getChannelForMessage(msg);
    if (channel instanceof WebChannel) channel.sendResearch(run.snapshot(), msg.channelId);
  }

  /** How long a proposed research plan waits for Start before it starts as proposed. */
  private static readonly RESEARCH_PLAN_WAIT_MS = 10 * 60 * 1000;

  /**
   * Plan first: one small model call proposes the sub-questions; the owner
   * edits them and presses Start, or cancels. False = cancelled. A plan that
   * can't be drafted just starts the research (the owner asked for it).
   */
  private async planResearch(msg: ChannelMessage, channel: WebChannel, run: ResearchRun): Promise<boolean> {
    run.phase = 'planning';
    this.emitResearch(msg, run);
    this.markProgress('Planning the research...');
    let questions: string[] = [];
    try {
      const model = this.providers.getDefault().getModelInstance();
      const out = await generateText({ model, system: RESEARCH_PLAN_SYSTEM, messages: [{ role: 'user', content: run.topic }], maxOutputTokens: 400 });
      questions = parsePlanLines(out.text);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Research plan: drafting failed; starting without one');
    }
    if (!questions.length) {
      channel.sendNotice("Couldn't draft a plan, so the research is starting without one.", msg.channelId, 'warning');
      return true;
    }
    run.setQuestions(questions);
    this.emitResearch(msg, run);
    // Waiting for the owner is not a stall.
    const keepAlive = setInterval(() => this.markProgress('Waiting for you to start the research...'), 20_000);
    try {
      const answer = await channel.askResearchPlan(run.id, run.topic, questions, msg.channelId, Agent.RESEARCH_PLAN_WAIT_MS);
      if (answer.action === 'cancel') {
        run.end('cancelled', 'you cancelled it');
        return false;
      }
      run.setQuestions(answer.questions);
      if (answer.timedOut) channel.sendNotice('No answer on the plan, so the research started with it as proposed.', msg.channelId);
      channel.sendPlan(run.questions.map((label) => ({ label, status: 'pending' })), msg.channelId);
      run.planned = true;
      return true;
    } finally {
      clearInterval(keepAlive);
      this.markProgress('Starting the research...');
    }
  }

  /**
   * The report from the pages a run read, without the conversation: for a
   * run cut short. Tries the default model, then the others.
   */
  private async writeResearchFromNotes(run: ResearchRun): Promise<string | null> {
    const notes = run.notesText();
    if (!notes.trim()) return null;
    const names = [this.providers.getDefault().name, ...this.providers.listAvailable()].filter((n, i, a) => a.indexOf(n) === i);
    const prompt = `Research question: ${run.topic}\n${run.questions.length ? `Sub-questions:\n${run.questions.map((q) => `- ${q}`).join('\n')}\n` : ''}\nSource notes (what was read before the research stopped):\n\n${notes}`;
    for (const name of names.slice(0, 4)) {
      const provider = this.providers.get(name);
      if (!provider) continue;
      try {
        const out = await generateText({ model: provider.getModelInstance(), system: RESEARCH_WRITE_SYSTEM, messages: [{ role: 'user', content: prompt }], maxOutputTokens: 6000 });
        const text = out.text.trim();
        if (text) return text;
      } catch (err) {
        logger.warn({ provider: name, err: err instanceof Error ? err.message : String(err) }, 'Research: report writing failed on this provider');
      }
    }
    return null;
  }

  /** Keep a research report as a file with the conversation (Artifacts), with every source consulted. */
  private saveResearchReport(run: ResearchRun, text: string, threadId: string): Artifact | null {
    try {
      const dir = researchDir(outputRoot(this.config.artifacts?.outputDir));
      mkdirSync(dir, { recursive: true });
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || run.topic;
      const file = path.join(dir, reportFileName(title, run.startedAt));
      const appendix = sourcesAppendix(run);
      writeFileSync(file, `${text.trim()}\n${appendix ? `\n---\n\n${appendix}\n` : ''}`, 'utf-8');
      const saved = artifactStore().add({ threadId, path: file, kind: 'text', tool: 'research', surface: 'chat' });
      run.report = { ...artifactRef(saved) };
      return saved;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Research: saving the report failed');
      return null;
    }
  }

  /**
   * "Write the report now" from a screen: stop searching and write it from
   * what was read. False when there's no research running in that chat.
   */
  finishResearch(sessionId: string): { ok: boolean; reason?: string } {
    const run = this.researchMode.activeRunFor(sessionId);
    if (!run || run.outcome !== 'running') return { ok: false, reason: 'No research is running in this chat.' };
    if (run.readCount() === 0) return { ok: false, reason: 'Nothing has been read yet, so there is nothing to write from. Stop it instead, or let it read a few sources.' };
    const turn = this.turnForChannel(sessionId);
    if (!turn?.abort || turn.abort.signal.aborted) return { ok: false, reason: 'The research is already finishing.' };
    run.finishRequested = true;
    // Not a cancellation: the turn goes on to write the report from what it read.
    turn.abortReason = 'stopped';
    turn.abort.abort();
    return { ok: true };
  }

  /** One small model call: does this message ask for a full research article? */
  private async wantsResearch(text: string): Promise<boolean> {
    let model: ReturnType<ReturnType<ProviderRegistry['getDefault']>['getModelInstance']>;
    try {
      model = this.learningProviders().getDefault().getModelInstance();
    } catch {
      return false;
    }
    const verdict = await classifyResearchIntent(text, async (system, user) => {
      const result = await generateText({ model, system, messages: [{ role: 'user', content: user }], maxOutputTokens: 8 });
      return result.text;
    });
    logger.debug({ verdict }, 'Research intent');
    return verdict === 'research';
  }

  private async promptResearchMode(msg: ChannelMessage, workKey?: string): Promise<void> {
    const channel = this.channels.getChannelForMessage(msg);
    if (!channel) {
      this.queueMessage(msg, workKey);
      this.processQueue();
      return;
    }

    const explanation =
      'Research mode will search the web, cross-check multiple sources, gather images, and produce a full research article as rich markdown. It runs longer than a quick answer and will not be killed early.';

    // Time-weighted default (same contract as the Mercury Code hand-off): an
    // unanswered prompt must never hold a chat message hostage. No answer
    // within the window → "Quick answer", nothing remembered, and the next
    // research-shaped question asks again. Quick answer is listed FIRST, so
    // the picker starts on it and an accidental Enter never starts a long
    // research run.
    const planOption = channel instanceof WebChannel ? ['Full research, show me the plan first'] : [];
    const choice = await this.presentChoiceWithTimeout(
      `This looks like a research question. ${explanation}\n\nHow do you want to proceed?`,
      ['Quick answer (normal conversation)', 'Full research mode (deep, multi-source article)', ...planOption],
      msg.channelId,
      msg.channelType,
      MERCURY_CODE_HANDOFF_TIMEOUT_MS,
      0, // unanswered = Quick answer (not remembered — nobody chose)
    );

    if (choice.toLowerCase().startsWith('full')) {
      const planFirst = /plan first/i.test(choice);
      this.researchMode.setOn(msg.content.trim().slice(0, 160), { sessionId: msg.channelId, planFirst });
      if (channel instanceof WebChannel) {
        // The research chip says it from here on (state, phase, sources).
        channel.sendResearchArmed(true, msg.channelId, { topic: msg.content.trim().slice(0, 160), planFirst });
      } else {
        await channel.send('Research mode: **On**. Gathering sources and building the article now — this may take a while.', msg.channelId).catch(() => {});
      }
    }
    this.queueMessage(msg, workKey);
    this.processQueue();
  }

  /**
   * Stop all current work with /stop semantics. Shared by the chat fast-path
   * command and the Cloud `task.stop` control so a remote stop behaves
   * exactly like typing /stop locally. Returns the confirmation note.
   */
  /**
   * Stop work. With a `channelId` (a `/stop` typed in a chat, the app's
   * Stop button in one conversation, Esc in the terminal) only that chat's
   * running turn and the sub-agents it started stop — other chats keep
   * going (ADR-037). Without one (`/halt`, or a caller that names no chat)
   * every running turn and every sub-agent stops.
   */
  async stopAllWork(reason: 'stopped' | 'halted', target?: { channelId?: string; sessionId?: string; keepQueued?: boolean }): Promise<string> {
    // The user deliberately killed this work — cancel its ledger entry so
    // a restart never tries to resume it. (Only real crashes auto-resume.)
    const label = reason === 'stopped' ? 'Stopped by the user (/stop).' : 'Halted by the user (/halt).';
    // A stop typed in an idle chat runs as that chat's own turn: never abort the command itself.
    const caller = this.turn();
    if (target && (target.channelId || target.sessionId)) {
      let turn = (target.channelId ? this.turnForChannel(target.channelId) : undefined)
        ?? (target.sessionId ? this.turnForSession(target.sessionId) : undefined);
      if (turn && caller && turn.id === caller.id) turn = undefined;
      if (turn) this.abortTurn(turn, reason, label);
      // Messages this chat had waiting go too (unless the caller only wants
      // the running turn gone, e.g. "do mine first"): a stop that let the
      // next queued message start would look like the task resuming.
      const dropped = target.keepQueued ? 0 : this.dropWaiting((m) =>
        (target.channelId !== undefined && m.channelId === target.channelId)
        || (target.sessionId !== undefined && (m.sessionId ?? m.metadata?.sessionId) === target.sessionId)
        || (turn !== undefined && laneKeyFor(m) === turn.laneKey), label);
      const channelId = turn?.message.channelId ?? target.channelId;
      const halted = this.supervisor && channelId ? await this.supervisor.haltForChannel(channelId) : [];
      // Videos and songs this chat is still making stop too (ADR-042).
      const jobsStopped = channelId ? mediaJobs()?.stop({ channelId }) ?? 0 : 0;
      const others = [...this.activeTurns.values()]
        .filter((t) => t !== turn && t.id !== caller?.id && !t.abort?.signal.aborted).length;
      // Nothing else running anywhere: the full stop it always was (locks
      // released, task board cleared), exactly as with one chat.
      let cleared = false;
      if (reason === 'stopped' && others === 0 && this.supervisor
        && this.supervisor.getActiveAgents().every((a) => halted.includes(a.id) || (a.status !== 'running' && a.status !== 'pending'))) {
        this.supervisor.clearTaskBoard();
        cleared = true;
      }
      const tail = cleared ? ' Locks released, task board cleared.' : '';
      const elsewhere = others > 0 ? ` ${others} task${others === 1 ? '' : 's'} in other chats keep${others === 1 ? 's' : ''} running — /halt stops everything.` : '';
      if (!turn && halted.length === 0 && dropped === 0 && jobsStopped === 0) {
        return cleared ? `Nothing was running.${tail}` : `Nothing is running in this chat.${elsewhere}`;
      }
      const parts = [
        turn ? 'Stopped this chat\'s task' : null,
        halted.length ? `halted ${halted.length} sub-agent${halted.length === 1 ? '' : 's'} it started` : null,
        dropped ? `dropped ${dropped} waiting message${dropped === 1 ? '' : 's'}` : null,
        jobsStopped ? `stopped ${jobsStopped} video or song being made` : null,
      ].filter(Boolean) as string[];
      parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      return `${parts.join(', ')}.${tail}${elsewhere}`;
    }
    this.dropWaiting(() => true, label);
    mediaJobs()?.stop();
    let stoppedTurns = 0;
    for (const turn of this.activeTurns.values()) {
      if (caller && turn.id === caller.id) continue;
      if (this.abortTurn(turn, reason, label)) stoppedTurns++;
    }
    const turnsNote = stoppedTurns > 1 ? `${stoppedTurns} running tasks` : stoppedTurns === 1 ? 'The running task' : null;
    if (this.supervisor) {
      await this.supervisor.haltAll();
      if (reason === 'stopped') {
        this.supervisor.clearTaskBoard();
      }
      const agentsNote = reason === 'halted' ? 'all sub-agents halted.' : 'all agents stopped, locks released, task board cleared.';
      return turnsNote ? `${turnsNote} ${reason}; ${agentsNote}` : agentsNote.charAt(0).toUpperCase() + agentsNote.slice(1);
    }
    if (turnsNote) return `${turnsNote} ${reason}.${reason === 'stopped' ? ' Locks released, task board cleared.' : ''}`;
    return reason === 'halted' ? 'Foreground task halted.' : 'Foreground task stopped, locks released, task board cleared.';
  }

  /**
   * Take waiting messages out of the line and cancel their work entries
   * (never started: a restart must not run them after all). Returns how many.
   */
  private dropWaiting(match: (m: ChannelMessage) => boolean, reason: string): number {
    const dropped = this.messageQueue.filter((i) => match(i.message));
    if (dropped.length === 0) return 0;
    this.messageQueue = this.messageQueue.filter((i) => !match(i.message));
    for (const item of dropped) {
      if (!item.workKey) continue;
      this.queuedWorkKeys.delete(item.workKey);
      try { this.workLedger.markCancelled(item.workKey, reason); } catch { /* entry may not exist */ }
    }
    // A screen showing "Waiting…" for one of them must hear it won't run.
    // Best effort: telling a screen must never get in the way of the stop.
    let web: { sendQueueDropped?: (target: string, data: { dropped: number; reason: string }) => void } | undefined;
    try { web = this.channels?.get?.('web') as unknown as typeof web; } catch { web = undefined; }
    if (web?.sendQueueDropped) {
      const perChat = new Map<string, number>();
      for (const item of dropped) if (item.message.channelType === 'web') perChat.set(item.message.channelId, (perChat.get(item.message.channelId) ?? 0) + 1);
      for (const [target, count] of perChat) {
        try { web.sendQueueDropped(target, { dropped: count, reason }); } catch { /* best effort */ }
      }
    }
    this.announceQueue();
    return dropped.length;
  }

  /** Resolves when this lane has no running turn (or after the deadline). */
  private waitUntilLaneIdle(laneKey: string, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    return new Promise((resolve) => {
      const tick = () => { if (!this.activeTurns.has(laneKey) || Date.now() >= deadline) resolve(); else setTimeout(tick, 50); };
      tick();
    });
  }

  private readonly sessionLocks = new Map<string, Promise<void>>();

  /**
   * Take one stored conversation for the calling turn; resolves to its
   * release. Waiters queue in order; a released lock with no waiter is
   * forgotten, so the map only holds conversations in use.
   */
  private async lockSession(sessionId: string): Promise<() => void> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => mine);
    this.sessionLocks.set(sessionId, chained);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.sessionLocks.get(sessionId) === chained) this.sessionLocks.delete(sessionId);
    };
  }

  /** No turn running and none waiting. */
  isIdle(): boolean {
    return this.activeTurns.size === 0 && this.messageQueue.length === 0;
  }

  private idleWaiters: Array<() => void> = [];

  /** Resolves once no turn runs and none waits (at once when that's already so). */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }

  private async handleFastPathCommand(msg: ChannelMessage): Promise<void> {
    return handleFastPathCommandImpl(this, msg);
  }

  async handleFastPathSpotify(trimmed: string, msg: ChannelMessage, channel: any): Promise<void> {
    if (!this.spotifyClient) {
      await channel.send('Spotify is not connected.', msg.channelId);
      return;
    }
    const rawArgs = trimmed.slice('/spotify'.length).trim().toLowerCase();
    if (!rawArgs || rawArgs === 'status') {
      const auth = this.spotifyClient.isAuthenticated() ? 'Connected' : 'Not connected';
      const accountName = this.spotifyClient.getAccountName();
      const product = this.spotifyClient.getProduct();
      let status = `Spotify: **${auth}**`;
      if (accountName) status += `\nAccount: **${accountName}**`;
      if (product) status += `\nPlan: ${product}`;
      status += `\nDevice: ${this.spotifyClient.getDeviceId() || 'none selected'}`;
      await channel.send(status, msg.channelId);
      return;
    }
    if (rawArgs === 'logout') {
      this.spotifyClient.logout();
      await channel.send('Spotify disconnected. Run `/spotify auth` to reconnect.', msg.channelId);
      return;
    }
    if (rawArgs === 'now' || rawArgs === 'playing' || rawArgs === 'np') {
      try {
        const text = await this.spotifyClient.getNowPlayingText();
        await channel.send(text, msg.channelId);
      } catch (err: any) {
        await channel.send(`Failed: ${err.message}`, msg.channelId);
      }
      return;
    }
    await channel.send('Agent is busy. Full Spotify controls will be available after current task completes.', msg.channelId);
  }

  async handleFastPathCode(trimmed: string, msg: ChannelMessage, channel: any): Promise<void> {
    const rawArgs = trimmed.slice('/code'.length).trim().toLowerCase();
    if (rawArgs === 'status') {
      await channel.send(this.programmingMode.getStatusText(), msg.channelId);
      return;
    }
    if (rawArgs === 'exit' || rawArgs === 'quit') {
      if (channel instanceof CLIChannel && channel.getTuiState().mercuryCode) {
        channel.setMercuryCodeExitConfirm(true);
        return;
      }
      this.programmingMode.setOff();
      await channel.send('Programming mode: **Off**', msg.channelId);
      return;
    }
    if (rawArgs === 'diff') {
      try {
        const { runGit } = await import('../capabilities/git/git-path.js');
        const diff = await runGit('git', ['--no-pager', 'diff', '--no-color', 'HEAD'], { cwd: this.capabilities.getCwd(), timeoutMs: 30000 });
        await channel.send(diff.trim() ? '```\n' + (diff.length > 20000 ? diff.slice(-20000) : diff) + '\n```' : 'Working tree is clean.', msg.channelId);
      } catch (err: any) {
        await channel.send(`git diff failed: ${err?.message || String(err)}`, msg.channelId);
      }
      return;
    }
    if (rawArgs === 'auto') {
      this.programmingMode.setAuto();
      if (channel instanceof CLIChannel) channel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
      await channel.send('Programming mode: **Auto** — Mercury plans and builds in one flow, confirming before large changes only.', msg.channelId);
      return;
    }
    if (rawArgs === 'plan') {
      this.programmingMode.setPlan();
      if (channel instanceof CLIChannel) channel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
      await channel.send('Programming mode: **Plan**', msg.channelId);
      return;
    }
    await channel.send('Agent is busy. Programming mode changes will be available after current task completes.', msg.channelId);
  }

  /**
   * Persona finalization: before anything is written to persona.md, offer
   * "Convert to template" (LLM-restructured, restructure-only) vs save
   * as-is. TUI gets a real choice prompt; other channels default to
   * template with graceful raw fallback on provider failure.
   */
  async finalizePersona(bm: import('../bots/bot-manager.js').BotManager, botId: string, raw: string, msg: ChannelMessage, newlyCreated = false): Promise<void> {
    const channel = this.channels.getChannelForMessage(msg);
    const manifest = bm.store.get(botId);
    if (!channel || !manifest) return;
    const channelType = msg.channelType as any;
    const target = this.onboardingTarget(botId, msg, channel);

    let choice = 'template';
    try {
      choice = await this.presentChoice(
        `Persona for **${manifest.name}** — how should it be saved?`,
        ['Convert to template (recommended — structured, precise)', 'Save as-is', 'Cancel — that was a task, not a persona'],
        msg.channelId,
        channelType,
      );
    } catch {
      choice = 'template';
    }

    if (choice.startsWith('Cancel')) {
      // Escape hatch (review K1): the text was a real task — dispatch it,
      // touch nothing on disk, and drop the pending capture.
      this.pendingPersonaFor = null;
      this.pendingBudgetFor = null;
      await this.dispatchToBot(botId, raw, msg);
      return;
    }

    let finalPersona = raw;
    if (choice.startsWith('Convert')) {
      // The builder is an LLM call (10-60s on slower providers) — the user
      // must see it is working, or onboarding reads as a hang.
      await channel.send('⏳ Running the persona builder — structuring your text (typically 10–60s)…', target).catch(() => {});
      (channel as any).sendHeartbeat?.('⏳ Persona builder running…');
      const refined = await refinePersona(raw, manifest.name, this.providers.getDefault());
      (channel as any).clearHeartbeat?.();
      if (refined) {
        finalPersona = refined;
      } else {
        await channel.send('⚠ Template conversion unavailable (provider) — saving your text as-is. Edit `persona.md` anytime.', msg.channelId).catch(() => {});
      }
    }

    bm.store.writePersona(botId, finalPersona.endsWith('\n') ? finalPersona : finalPersona + '\n');
    bm.invalidateRuntime(botId);
    this.pendingPersonaFor = null;
    const mode = finalPersona === raw ? 'as-is' : 'as a structured template';
    await channel.send(`✍️ Persona saved ${mode}.`, target).catch(() => {});

    // New-bot onboarding: permission tier, then solo vs fleet (edits later never ask).
    if (newlyCreated) {
      await this.offerPermissionTier(bm, botId, manifest.name, msg, channel);
      await this.offerFleetStep(bm, botId, manifest.name, msg, channel);
    }

    // Final onboarding step: the daily token budget. Every bot has one
    // (ADR-020) — the presets are sizes, not a yes/no.
    const standard = this.config.bots?.suggestedDailyTokenBudget ?? 5_000_000;
    if (channel.type !== 'cli') {
      await this.offerBudgetChoice(bm, botId, manifest.name, msg, channel, standard);
      return;
    }
    this.pendingBudgetFor = botId;
    const home = homedir();
    const folder = bm.store.deliverablesDir(botId);
    await channel.send(
      `Last step — how much may **${manifest.name}** spend per day?\n` +
      `• \`light\` — 1M tokens/day (a few runs)\n` +
      `• \`standard\` — ${standard.toLocaleString()}/day (default — just type your first task)\n` +
      `• \`heavy\` — 20M/day (a busy fleet)\n` +
      `• a number, or \`none\` for no cap\n` +
      `When the cap is hit the bot pauses until tomorrow; you are warned at 80%. Change anytime: \`/bots budget ${botId} <tokens|suggest|none>\`.\n` +
      `📁 Its results will appear in \`${folder.startsWith(home) ? '~' + folder.slice(home.length) : folder}\` (\`/bots folder ${botId}\` opens it).`,
      target,
    ).catch(() => {});
  }

  /**
   * Where onboarding talks: the bot's own thread in the TUI, the chat that
   * asked everywhere else (Telegram cannot resolve `bot:<id>`).
   */
  private onboardingTarget(botId: string, msg: ChannelMessage, channel: { type?: string }): string {
    return channel.type === 'cli' ? `bot:${botId}` : msg.channelId;
  }

  /** Budget step as buttons (Telegram/web): sizes, not a typed keyword. */
  private async offerBudgetChoice(bm: import('../bots/bot-manager.js').BotManager, botId: string, botName: string, msg: ChannelMessage, channel: { send: (text: string, target?: string) => Promise<void> }, standard: number): Promise<void> {
    const home = homedir();
    const folder = bm.store.deliverablesDir(botId);
    const options = [
      `Standard — ${standard.toLocaleString()}/day (recommended)`,
      'Light — 1M/day',
      'Heavy — 20M/day',
      'No cap',
    ];
    let choice = options[0];
    try {
      choice = await this.presentChoice(
        `Last step — how much may **${botName}** spend per day? When the cap is hit it pauses until tomorrow (warned at 80%). Change anytime: \`/bots budget ${botId} <tokens|suggest|none>\`.\n📁 Results will appear in \`${folder.startsWith(home) ? '~' + folder.slice(home.length) : folder}\`.`,
        options,
        msg.channelId,
        msg.channelType,
      );
    } catch {
      choice = options[0];
    }
    const keyword = choice.startsWith('Light') ? 'light' : choice.startsWith('Heavy') ? 'heavy' : choice.startsWith('No cap') ? 'none' : 'standard';
    this.pendingBudgetFor = botId;
    await this.applyBudgetAnswer(bm, botId, keyword, msg);
    await channel.send(`✅ **${botName}** is ready. Give it work with \`/bot ${botId} <task>\` or \`@${botId} <task>\` — results come back here, with the files.`, msg.channelId).catch(() => {});
  }

  /**
   * Permission-tier onboarding step (new bots only): one clear question
   * instead of silent fail-closed defaults + manual file editing. Change
   * anytime with `/bots permissions <id> <tier>`.
   */
  private async offerPermissionTier(bm: import('../bots/bot-manager.js').BotManager, botId: string, botName: string, msg: ChannelMessage, channel: any): Promise<void> {
    const target = this.onboardingTarget(botId, msg, channel);
    let choice = 'Read-only (recommended default)';
    try {
      choice = await this.presentChoice(
        `What should **${botName}** be allowed to do?\n` +
        Object.values(PERMISSION_TIERS).map(t => `• **${t.label}** — ${t.description}`).join('\n') +
        '\n(Path scopes always stay fail-closed — a tool only reaches what its Access grants cover.)',
        Object.values(PERMISSION_TIERS).map(t => t.label),
        msg.channelId,
        msg.channelType as any,
      );
    } catch {
      choice = 'Read-only (recommended default)';
    }
    const tier = (Object.entries(PERMISSION_TIERS).find(([, t]) => choice.startsWith(t.label))?.[0] ?? 'readonly') as PermissionTier;
    // The tier must EXECUTE: write the full permission file (tool gate +
    // path scopes) — the single source of truth. The old manifest-only write
    // left the path gate at fail-closed defaults, so a "full access" bot
    // still could not read anything outside its sandbox.
    bm.store.writePermissions(botId, tierPermissionsFile(tier));
    bm.store.update(botId, m => { delete (m as any).tools; });
    bm.invalidateRuntime(botId);
    await channel.send(`🔐 Permissions for **${botName}**: **${PERMISSION_TIERS[tier].label}**. Change anytime with \`/bots permissions ${botId} <readonly|builder|operator|full>\`.`, target).catch(() => {});
  }

  /**
   * Fleet onboarding step (new bots only): solo vs lead. Auto-build asks one
   * LLM call for a matched crew; manual points at `/bots add-crew`. The
   * budget step follows either way.
   */
  async offerFleetStep(bm: import('../bots/bot-manager.js').BotManager, botId: string, botName: string, msg: ChannelMessage, channel: any): Promise<void> {
    const target = this.onboardingTarget(botId, msg, channel);
    let choice = 'Solo bot';
    try {
      choice = await this.presentChoice(
        `Should **${botName}** work solo, or lead a fleet of sub-bots?`,
        ['Solo bot', 'Lead a fleet — auto-build the crew', 'Lead a fleet — I\'ll add crew myself'],
        msg.channelId,
        msg.channelType as any,
      );
    } catch {
      choice = 'Solo bot';
    }
    if (choice.startsWith('Solo')) return;

    // Promote to lead before any crew exists.
    bm.store.update(botId, m => { m.fleetRole = 'lead'; });
    bm.invalidateRuntime(botId);

    if (choice.startsWith('Lead a fleet — I\'ll')) {
      await channel.send(
        `👑 **${botName}** is now a fleet lead. Add specialists anytime:\n` +
        `\`/bots add-crew ${botId} <id> "Name" "Description" "persona (optional)"\`\n` +
        `Review the fleet with \`/bots crew ${botId}\` — or just tell **${botName}** to hire its own crew (it has bot_spawn).`,
        target,
      ).catch(() => {});
      return;
    }

    // Auto-build: one LLM proposal, created through the standard path. This
    // is an LLM call (30-90s) — it must NOT hold onboarding hostage: run it
    // detached with visible progress, and deliver the roster when ready.
    await channel.send(`👑 **${botName}** is now a fleet lead — building the crew in the background…`, target).catch(() => {});
    (channel as any).sendHeartbeat?.('⏳ Proposing fleet crew (up to ~90s)…');
    const persona = bm.store.readPersona(botId);
    const leadDescription = bm.store.get(botId)?.description ?? '';
    void (async () => {
      try {
        const proposals = await proposeCrew(botName, leadDescription, persona, this.providers.getDefault(), bm.maxCrew());
        (channel as any).clearHeartbeat?.();
        if (proposals.length === 0) {
          await channel.send(`⚠ Crew proposal unavailable (provider) — **${botName}** is a lead with an empty crew. Add members with \`/bots add-crew ${botId} <id> "Name" "Description" "persona"\` or tell the lead to hire its own.`, target).catch(() => {});
          return;
        }
        const lines: string[] = [`👑 **${botName}** fleet ready — ${proposals.length} crew member(s) created:`, ''];
        for (const p of proposals) {
          const result = bm.addCrew(botId, p);
          if (result.ok) {
            lines.push(result.duplicate
              ? `• **${p.name}** (\`${result.manifest.id}\`) — already on the crew, skipped`
              : `• **${p.name}** (\`${result.manifest.id}\`) — ${p.description || 'specialist'}`);
          } else {
            lines.push(`⚠ ${p.name} (${p.id}): ${result.error}`);
          }
        }
        lines.push('', 'Dispatch tasks with `/bot <crewId> <task>` or tell the lead to delegate — it can also spawn more crew itself.');
        await channel.send(lines.join('\n'), target).catch(() => {});
      } catch (err: any) {
        (channel as any).clearHeartbeat?.();
        await channel.send(`⚠ Fleet auto-build failed: ${err?.message ?? err} — **${botName}** is a lead with an empty crew; add members with \`/bots add-crew ${botId} <id> "Name" "Description" "persona"\`.`, target).catch(() => {});
      }
    })();
  }

  /** Apply the budget answer typed after the persona step (or a later task). */
  private async applyBudgetAnswer(bm: import('../bots/bot-manager.js').BotManager, botId: string, message: string, msg: ChannelMessage): Promise<boolean> {
    const value = message.trim().toLowerCase();
    const isBudgetCommand = /^\d+$/.test(value) || ['suggest', 'none', 'skip', 'light', 'standard', 'heavy', 'unlimited'].includes(value);
    if (!isBudgetCommand) {
      // Not a budget answer — treat as the user's first task; budget stays unset.
      this.pendingBudgetFor = null;
      return false;
    }
    this.pendingBudgetFor = null;
    const manifest = bm.store.get(botId);
    const suggested = this.config.bots?.suggestedDailyTokenBudget ?? 5_000_000;
    let applied: string;
    const presets: Record<string, number> = { light: 1_000_000, heavy: 20_000_000 };
    if (value === 'suggest' || value === 'standard' || value === 'skip') {
      // The fleet default applies (ADR-020): nothing to write.
      bm.store.update(botId, m => { if (m.autonomy) delete m.autonomy.dailyTokenBudget; });
      applied = `${suggested.toLocaleString()}/day (default)`;
    } else if (value === 'none' || value === 'unlimited') {
      bm.store.update(botId, m => { m.autonomy = { ...m.autonomy, dailyTokenBudget: 0 }; });
      applied = 'no cap (unlimited)';
    } else if (presets[value]) {
      bm.store.update(botId, m => { m.autonomy = { ...m.autonomy, dailyTokenBudget: presets[value] }; });
      applied = `${presets[value].toLocaleString()}/day`;
    } else {
      const n = parseInt(value, 10);
      bm.store.update(botId, m => { m.autonomy = { ...m.autonomy, dailyTokenBudget: n }; });
      applied = `${n.toLocaleString()}/day`;
    }
    bm.invalidateRuntime(botId);
    const channel = this.channels.getChannelForMessage(msg);
    await channel?.send(`💰 Budget for **${manifest?.name ?? botId}**: ${applied}. When the cap is hit the bot pauses until the next day — never killed.`, channel ? this.onboardingTarget(botId, msg, channel) : msg.channelId)
      .catch(() => {});
    return true;
  }

  /** Enqueue a bot turn from any channel, with ack + reply-back routing. */
  private async dispatchToBot(botId: string, message: string, msg: ChannelMessage): Promise<void> {
    const bm = this.botManager;
    if (!bm) return;
    const channel = this.channels.getChannelForMessage(msg);
    if (!channel) return;

    // Budget step runs after the persona step: the next message answers it
    // if it looks like one; anything else is the user's first real task.
    if (this.pendingBudgetFor) {
      if (this.pendingBudgetFor !== botId) {
        this.pendingBudgetFor = null;
      } else {
        const handled = await this.applyBudgetAnswer(bm, botId, message, msg);
        if (handled) return;
      }
    }

    // Post-create persona setup: the first message typed into the new bot's
    // chat becomes its persona instead of a task (send /skip to keep the
    // template). Any dispatch to a different bot cancels the pending setup.
    if (this.pendingPersonaFor) {
      if (this.pendingPersonaFor !== botId) {
        this.pendingPersonaFor = null;
      } else if (message.trim().toLowerCase() === '/skip') {
        this.pendingPersonaFor = null;
        await channel.send('⏭ Keeping the starter persona — edit it anytime with `/persona` here or `/bots persona <id> <text>`.', `bot:${botId}`)
          .catch(() => {});
        return;
      } else {
        // Offer the "convert to template" step before anything hits disk.
        await this.finalizePersona(bm, botId, message.trim(), msg, this.pendingPersonaNewlyCreated);
        return;
      }
    }
    // Dispatched from inside that bot's TUI chat → ack and reply land in
    // the bot's own transcript (targetId `bot:<id>`; cli.ts routes it).
    const pendingBot = (channel as any).consumePendingBotChatTarget?.() ?? null;
    const inBotChat = pendingBot === botId;
    const replyTarget = inBotChat ? `bot:${botId}` : msg.channelId;
    const result = bm.enqueue(botId, {
      trigger: 'chat',
      prompt: message,
      source: { channelType: msg.channelType, channelId: replyTarget },
    });
    if (result.accepted) {
      await channel.send(`🤖 Queued for **${botId}** (job ${result.jobId}) — the reply will arrive in this chat.`, replyTarget)
        .catch((err) => logger.warn({ err }, '/bot ack send failed'));
    } else {
      await channel.send(`Could not message **${botId}**: [reason: ${result.reasonCode}]`, replyTarget)
        .catch((err) => logger.warn({ err }, '/bot ack send failed'));
    }
  }

  /**
   * Parse `@<botId|Name> <message>` into a bot routing when the first token
   * resolves to a configured bot; null for any other @-message.
   */
  private parseBotMention(content: string): { botId: string; message: string } | null {
    const bm = this.botManager;
    if (!bm) return null;
    const firstSpace = content.indexOf(' ');
    const token = (firstSpace === -1 ? content : content.slice(0, firstSpace)).replace(/^@/, '').trim();
    const message = firstSpace === -1 ? '' : content.slice(firstSpace + 1).trim();
    if (!token || !message) return null;
    const botId = bm.resolveBotId(token);
    return botId ? { botId, message } : null;
  }

  /**
   * /bots — Mercury Bots control surface (BOTS-ARCHITECTURE.md §2.7).
   * Always fast-path: bots live outside the main message queue, so bot
   * control stays responsive while the agent is busy.
   */
  async handleBotsCommand(trimmed: string, msg: ChannelMessage, channel: any): Promise<void> {
    return handleBotsCommandImpl(this, trimmed, msg, channel);
  }

  async handleBgCommand(trimmed: string, msg: ChannelMessage, channel: any): Promise<void> {
    return handleBgCommandImpl(this, trimmed, msg, channel);
  }

  syncBgTasksToTui(): void {
    const cliChannel = this.channels.get('cli');
    if (cliChannel && cliChannel instanceof CLIChannel) {
      (cliChannel as CLIChannel).updateBackgroundTasks(this.backgroundTasks.getAllSummaries());
    }
  }

  /**
   * Long-running tools (run_command) pulse this while they are alive so the
   * foreground heartbeat and the StallWatchdog do not abort a legitimate
   * ten-minute build as a "stalled provider". See core/progress-pulse.ts.
   */
  private installProgressPulse(): void {
    setProgressPulse(() => this.markProgress());
  }

  private markProgress(activity?: string): void {
    this.lastProgressAt = Date.now();
    if (activity) {
      this.currentActivity = activity;
    }
    this.refreshTypingIndicator();
  }

  /**
   * Telegram shows a typing action for only ~5 seconds, and the stream loop does
   * not run during provider startup, reasoning or tool execution. Re-send the
   * action from the progress path, throttled under that window. Nothing is
   * scheduled here, so it stops by itself once the turn stops making progress.
   */
  private refreshTypingIndicator(): void {
    const typingChannel = this.currentMessage ? this.channels.getChannelForMessage(this.currentMessage) : undefined;
    if (!typingChannel) return;
    const now = Date.now();
    if (now - this.lastTypingAt < TYPING_REFRESH_MS) return;
    this.lastTypingAt = now;
    void typingChannel
      .typing(this.currentMessage!.channelId)
      .catch((e) => logger.warn({ e }, 'channel typing refresh failed'));
  }

  /**
   * Push a phase change to the CLI live feedback block in real time.
   * Cheap no-op for non-CLI channels.
   */
  private pushLiveActivity(phase: string, detail?: string): void {
    this.cliFeed()?.setLiveActivity(phase, detail);
    const web = this.currentMessage ? this.channels.getChannelForMessage(this.currentMessage) : undefined;
    if (web instanceof WebChannel) web.sendPhase(phase, detail, this.currentMessage!.channelId);
  }

  /**
   * The terminal's live feed, when the calling turn may draw on it: the
   * terminal's own turn always; another chat's only while the terminal has
   * no turn of its own (ADR-037 — two turns must not interleave one feed).
   */
  private cliFeed(): CLIChannel | undefined {
    const ch = this.channels.get('cli');
    if (!(ch instanceof CLIChannel)) return undefined;
    const t = this.turn();
    if (t && t.laneKey !== 'cli' && this.activeTurns.has('cli')) return undefined;
    return ch;
  }

  /**
   * A video or song finished (or failed) after its turn ended (media/jobs.ts):
   * post it to the chat that asked. The apps get it as a new message with
   * the file attached (kept with the conversation, so a reopened chat shows
   * it); chat apps get a note and the file; the terminal a notice with the path.
   */
  async deliverMediaJob(job: MediaJob, note?: string): Promise<void> {
    const channel = this.channels.get(job.chat.channelType as Parameters<ChannelRegistry['get']>[0]);
    const what = job.kind === 'video' ? 'video' : 'music';
    const icon = job.kind === 'video' ? '🎬' : '🎵';
    const text = job.status === 'done' && job.file
      ? `${icon} Your ${what} is ready${job.madeWith ? ` (${job.madeWith})` : ''}.${note ? `\n\n${note.trim().slice(0, 500)}` : ''}`
      : `⚠ I couldn't make the ${what}: ${job.error ?? 'it failed'}`;
    const file = job.status === 'done' && job.file && existsSync(job.file) ? job.file : undefined;
    if (job.chat.channelType === 'web') {
      const sessionId = job.chat.sessionId ?? job.chat.channelId;
      let refs: ReturnType<typeof artifactRef>[] = [];
      if (file) {
        try {
          const kind = /\.(mp4|webm|mov|m4v)$/i.test(file) ? 'video' : 'audio';
          refs = [artifactRef(artifactStore().add({ threadId: sessionId, path: file, kind, tool: `generate_${job.kind}` }))];
        } catch (err) { logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Keeping a media job artifact failed'); }
      }
      try {
        this.sessions.appendMessage(sessionId, {
          role: 'assistant',
          content: text,
          externalMessageId: `media-job:${job.id}`,
          metadata: { channelType: 'web', channelId: job.chat.channelId, ...(refs.length ? { artifacts: refs } : {}) },
        });
      } catch { /* the chat was deleted meanwhile */ }
      if (channel instanceof WebChannel) channel.sendMediaReady(text, refs, job.chat.channelId, job.id);
      return;
    }
    if (!channel) return;
    if (channel instanceof CLIChannel) {
      channel.sendSystemNotice(`${text}${file ? `\n  ${file}` : ''}`);
      return;
    }
    await channel.send(text, job.chat.channelId).catch(() => {});
    if (file) await channel.sendFile(file, job.chat.channelId);
  }

  /**
   * Say the reply as a voice note in a chat app: when the owner sent a voice
   * note ("mirror", the default), on every reply ("always"), or never
   * ("off"); /media replies. The text was already sent: this is extra and
   * never fails the turn.
   */
  private async maybeVoiceReply(channel: { sendFile(path: string, targetId?: string): Promise<void> }, msg: ChannelMessage, text: string): Promise<void> {
    if (this.turnCancelled() || !voiceReplyWanted(msg.channelType, msg.metadata?.voiceNote === true, loadMediaPrefs().speech?.replies)) return;
    const spoken = speakableText(text);
    if (!spoken || /^\s*⏹/.test(text)) return;
    const speech = getSpeechService();
    if (!speech) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'mercury-voice-reply-'));
    try {
      const { file } = await speech.speakToFile(spoken, dir, { format: 'ogg' });
      await channel.sendFile(file, msg.channelId);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), channel: msg.channelType }, 'Voice reply failed (the text reply was sent)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * A note while the turn keeps working ("Checking my work…"). On the web
   * channel a plain send is a finished reply, which would end the turn on
   * screen while work goes on; there it is a progress event instead.
   */
  private async sendProgressNote(channel: { send(text: string, targetId?: string): Promise<void> }, text: string, channelId: string): Promise<void> {
    if (channel instanceof WebChannel) {
      channel.sendProgressNote(text, channelId);
      return;
    }
    await channel.send(text, channelId);
  }

  /**
   * Where a stream's reasoning goes: the terminal's thinking preview, the
   * desktop's live thought process, and the turn's trace (kept with the
   * reply). `null` ends the current thinking block.
   */
  private reasoningSink(channel: unknown, channelId: string): (preview: string | null, delta?: string) => void {
    const cli = channel instanceof CLIChannel ? channel : null;
    const web = channel instanceof WebChannel ? channel : null;
    const trace = this.turn()?.trace;
    return (preview, delta) => {
      cli?.showThinkingPreview(preview);
      if (preview === null) {
        trace?.reasoningEnded();
        web?.sendReasoning(null, channelId);
        return;
      }
      if (delta) trace?.reasoning(delta);
      web?.sendReasoning(delta ?? '', channelId);
    };
  }

  /**
   * Push a tool execution event to the CLI live feedback in real time.
   * Unlike onStepFinish (which fires after the whole LLM step), this fires at
   * tool start/finish so the TUI shows running work during long operations.
   */
  private pushLiveToolEvent(
    callId: string,
    toolName: string,
    argsOrResult: Record<string, any> | unknown,
    status: 'running' | 'done' | 'error',
    durationMs?: number,
  ): void {
    // Channels that narrate progress themselves (plugin channels: a voice call
    // speaks "still searching the web…") hear about every tool start.
    if (status === 'running' && this.currentMessage) {
      const current = this.channels.getChannelForMessage(this.currentMessage) as { toolStarted?: (channelId: string, toolName: string) => void } | undefined;
      if (typeof current?.toolStarted === 'function') {
        try { current.toolStarted(this.currentMessage.channelId, toolName); } catch { /* best effort */ }
      }
    }
    const turn = this.turn();
    if (status === 'running') turn?.trace.toolStarted(callId, formatToolStep(toolName, (argsOrResult as Record<string, unknown>) || {}));
    else turn?.trace.toolFinished(callId, status === 'error', durationMs, toolSummary(argsOrResult));
    // Mercury Desktop and the web dashboard see each tool as it starts and
    // ends, not only after the whole step.
    const web = this.currentMessage ? this.channels.getChannelForMessage(this.currentMessage) : undefined;
    if (web instanceof WebChannel) {
      const target = this.currentMessage!.channelId;
      if (status === 'running') web.sendToolStarted(callId, toolName, (argsOrResult as Record<string, unknown>) || {}, target);
      else web.sendToolFinished(callId, toolName, argsOrResult, status === 'error', durationMs, target);
    }
    const ch = this.cliFeed();
    if (!ch) return;
    if (status === 'running') {
      void ch.sendToolEvent(toolName, argsOrResult as Record<string, any>, callId).catch(() => {});
    } else {
      ch.completeToolEvent(toolName, argsOrResult, status === 'error', durationMs, callId);
    }
  }

  private withProgressStream(content: AsyncIterable<string>): AsyncIterable<string> {
    const self = this;
    return (async function* () {
      for await (const chunk of content) {
        self.markProgress('Streaming response...');
        yield chunk;
      }
    })();
  }

  /**
   * Abort this provider attempt as stalled when no chunk of any kind (text,
   * reasoning, tool call) arrives within the first-response window.
   * `MERCURY_FIRST_RESPONSE_TIMEOUT_MS` overrides it (0 turns it off).
   */
  private armFirstResponseTimer(providerName: string, controller: AbortController): { received(): void; clear(): void } {
    const raw = Number(process.env.MERCURY_FIRST_RESPONSE_TIMEOUT_MS);
    const windowMs = Number.isFinite(raw) && raw >= 0 ? raw : FIRST_RESPONSE_TIMEOUT_MS;
    let settled = false;
    const timer = windowMs > 0 ? setTimeout(() => {
      if (settled || controller.signal.aborted) return;
      settled = true;
      logger.warn({ provider: providerName, waitedMs: windowMs }, 'No response from the provider within the first-response window — trying the next one');
      this.pushLiveActivity(`No response from ${providerName} — trying again`, `${Math.round(windowMs / 1000)}s without a reply`);
      this.currentAbortReason = 'stalled';
      controller.abort(new Error(`${providerName} sent nothing for ${Math.round(windowMs / 1000)}s`));
    }, windowMs) : null;
    timer?.unref?.();
    const clear = () => {
      settled = true;
      if (timer) clearTimeout(timer);
    };
    return { received: clear, clear };
  }

  private withProviderDeadline<T>(operation: PromiseLike<T>, controller: AbortController, deadlineAt: number): Promise<T> {
    return withAbortDeadline(operation, controller, deadlineAt - Date.now(), () => {
      this.currentAbortReason = 'time-limit';
    });
  }

  private startForegroundHeartbeat(msg: ChannelMessage): () => void {
    if (msg.channelType === 'internal') return () => {};

    let heartbeatCount = 0;
    let currentIntervalMs = HEARTBEAT_INITIAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      // Timers carry the turn's scope: a tick after the turn ended does nothing.
      const own = this.turn();
      if (!own || own.done || !this.currentMessage || this.currentMessage.id !== msg.id) return;
      const channel = this.channels.getChannelForMessage(msg);

      const elapsedMs = Date.now() - this.currentMessage.timestamp;
      const stallMs = Date.now() - this.lastProgressAt;
      const elapsedSec = Math.round(elapsedMs / 1000);
      const stallSec = Math.round(stallMs / 1000);

      if (stallMs >= MAX_STALL_MS * this.researchMode.getStallMsMultiplier() && this.currentAbort && !this.currentAbort.signal.aborted) {
        logger.warn({ elapsedSec, stallSec, msgId: msg.id }, 'Foreground task stalled — aborting');
        this.currentAbortReason = 'stalled';
        this.currentAbort.abort();
        const stallLine = `Mercury detected a stalled provider after ${stallSec}s without progress. Reconnecting and retrying automatically.`;
        // On the apps this is a note in the running turn, not its answer
        // (sent as a reply, it ended the turn on screen while the retry ran).
        if (channel instanceof WebChannel) channel.sendNotice(stallLine, msg.channelId, 'warning');
        else if (channel) void channel.send(stallLine, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
        timer = setTimeout(tick, HEARTBEAT_MAX_MS);
        return;
      }

      heartbeatCount++;
      const handoffHint = elapsedMs >= LONG_TASK_HANDOFF_SUGGEST_MS
        ? '\nUse /bg current to move to background.'
        : '';
      const stepBudget = this.saverMode.adjustMaxSteps(MAX_STEPS) * this.researchMode.getMaxStepsMultiplier();
      const stepInfo = this.completedStepCount > 0
        ? ` · step ${this.completedStepCount}/${stepBudget}`
        : '';
      const run = this.researchMode.currentRun();
      const researchInfo = run && run.sessionId === msg.channelId
        ? ` · researching: ${run.snapshot().searches} searches, ${run.readCount()} sources read${run.failedSources().length ? `, ${run.failedSources().length} failed` : ''}`
        : '';
      const narrative = formatNarrative(this.stepNarrative, this.currentActivity, 3);
      const narrativeBlock = narrative ? `\n${narrative}` : '';
      const heartbeatText = `⏳ Working... ${elapsedSec}s elapsed${stepInfo}${researchInfo}.${narrativeBlock}${handoffHint}`;

      // CLI: update one message in place instead of stacking new ones.
      // Web/cloud: send a non-terminal heartbeat so the cloud response handler stays alive.
      // Other channels (Telegram): still send as separate messages.
      if (channel instanceof CLIChannel) {
        (channel as CLIChannel).sendHeartbeat(heartbeatText);
      } else if (channel instanceof WebChannel) {
        (channel as WebChannel).sendHeartbeat(heartbeatText, msg.channelId);
      } else if (channel && (channel as { quietProgress?: boolean }).quietProgress) {
        // Phone chats (plugin channels like WhatsApp): keep "typing…" alive, and
        // say once, early, that this one is taking a while and what it's doing.
        void channel.typing(msg.channelId).catch(() => {});
        if (heartbeatCount === 1) {
          const doing = this.currentActivity ? this.currentActivity.replace(/[.…]+$/, '') : 'working on it';
          void channel.send(`⏳ This one takes a moment. Still on it: ${doing.charAt(0).toLowerCase()}${doing.slice(1)}…`, msg.channelId).catch(() => {});
        }
      } else if (channel) {
        void channel.send(heartbeatText, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
      }

      // Escalate: 20s → 30s → 45s → 60s (cap)
      if (heartbeatCount <= 2) {
        currentIntervalMs = 30000;
      } else if (heartbeatCount <= 4) {
        currentIntervalMs = 45000;
      } else {
        currentIntervalMs = HEARTBEAT_MAX_MS;
      }
      timer = setTimeout(tick, currentIntervalMs);
    };

    timer = setTimeout(tick, HEARTBEAT_INITIAL_MS);

    return () => {
      if (timer) clearTimeout(timer);
      // The task is over — remove any lingering heartbeat message (the
      // "⏳ Working... Ns elapsed" block with step list / "Streaming
      // response...") from the TUI so nothing trails a finished task.
      // Late ticks can fire after the final send already cleared it.
      try {
        const ch = this.channels.getChannelForMessage(msg);
        if (ch instanceof CLIChannel) (ch as CLIChannel).clearHeartbeat();
      } catch { /* best effort */ }
    };
  }

  private notifyBackgroundTaskComplete(task: import('./background-tasks.js').BackgroundTask): void {
    const label = task.command || task.task || task.id;
    const duration = task.completedAt ? ` in ${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s` : '';
    let message: string;

    if (task.status === 'completed') {
      message = `✅ Background task ${task.id} completed${duration}: "${label}"`;
    } else if (task.status === 'failed') {
      message = `❌ Background task ${task.id} failed${duration}: "${label}" (exit code ${task.exitCode ?? 'unknown'})`;
    } else if (task.status === 'timed_out') {
      message = `⏱ Background task ${task.id} timed out: "${label}"`;
    } else if (task.status === 'cancelled') {
      message = `⛔ Background task ${task.id} cancelled: "${label}"`;
    } else {
      message = `Background task ${task.id}: ${task.status} — "${label}"`;
    }

    const output = (task.stdout + '\n' + task.stderr).trim();
    if (output) {
      const preview = output.length > 500 ? '\n' + output.slice(-500) : '\n' + output;
      message += preview;
    }

    const cliCh = this.channels.get('cli');
    if (cliCh) {
      (cliCh as CLIChannel).send(message).catch((e) => logger.warn({ e }, 'channel send failed'));
    }
    const tgCh = this.channels.get('telegram');
    if (tgCh) {
      tgCh.send(message).catch((e) => logger.warn({ e }, 'channel send failed'));
    }
    const dcCh = this.channels.get('discord');
    if (dcCh) {
      dcCh.send(message).catch((e) => logger.warn({ e }, 'channel send failed'));
    }
    const slCh = this.channels.get('slack');
    if (slCh) {
      slCh.send(message).catch((e) => logger.warn({ e }, 'channel send failed'));
    }

    this.syncBgTasksToTui();
  }

  /**
   * Session-scoped coding. A message that names a programming mode (Mercury
   * Desktop's Code surface) runs with THAT session's mode, plan and folder;
   * everything else (terminal, chat, other sessions) keeps the global mode.
   * The turn gets its own ProgrammingMode instance and its own working
   * directory (ADR-037), so it can run beside other turns; the global mode
   * is never touched.
   */
  private readonly sessionProgramming = new Map<string, ProgrammingSnapshot>();

  private async withSessionProgramming(msg: ChannelMessage, run: () => Promise<void>): Promise<void> {
    const requested = scopedProgrammingState(msg.metadata?.programming);
    const sessionKey = typeof msg.metadata?.sessionId === 'string' ? msg.metadata.sessionId : msg.sessionId;
    const turn = this.turn();
    if (!requested || !sessionKey || !turn) return run();
    const cwd = typeof msg.metadata?.programmingCwd === 'string' ? msg.metadata.programmingCwd : null;
    const saved = this.sessionProgramming.get(sessionKey);
    const mode = new ProgrammingMode();
    mode.restore({
      state: requested,
      projectContext: cwd ?? saved?.projectContext ?? null,
      // A plan made in this session stays with this session.
      lastPlan: saved?.lastPlan ?? null,
    });
    turn.programming = mode;
    if (cwd) {
      this.capabilities.setCwd(cwd);
      this.capabilities.permissions.addTempScope(cwd, true, true);
    }
    try {
      await run();
    } finally {
      this.sessionProgramming.delete(sessionKey);
      this.sessionProgramming.set(sessionKey, mode.snapshot());
      if (this.sessionProgramming.size > 200) {
        const oldest = this.sessionProgramming.keys().next().value;
        if (oldest !== undefined) this.sessionProgramming.delete(oldest);
      }
      turn.programming = null;
    }
  }

  /** Where a chat's next turn starts: its own last directory, else the terminal's. */
  private cwdForLane(laneKey: string): string {
    if (laneKey === 'cli') return this.capabilities.getGlobalCwd();
    const own = this.laneCwd.get(laneKey);
    return own && existsSync(own) ? own : this.capabilities.getGlobalCwd();
  }

  private rememberLaneCwd(laneKey: string, dir: string): void {
    if (laneKey === 'cli') {
      // The terminal's `cd` carries over to its next turn, as before.
      this.capabilities.setGlobalCwd(dir);
      return;
    }
    this.laneCwd.delete(laneKey);
    this.laneCwd.set(laneKey, dir);
    if (this.laneCwd.size > 500) {
      const oldest = this.laneCwd.keys().next().value;
      if (oldest !== undefined) this.laneCwd.delete(oldest);
    }
  }

  /**
   * Start every waiting message whose chat is free, while the governor
   * admits more (ADR-037). Never awaits a turn: each runs on its own and
   * pumps again when it ends. Order: first come, first served across chats
   * (voice-call questions and "do mine first" reorder the line as before);
   * within a chat, strictly one after another.
   */
  private processQueue(): void {
    if (!this.running) return;
    if (!this.globalLifecycle.is('idle')) return;
    for (;;) {
      const index = this.messageQueue.findIndex((i) => !this.activeTurns.has(laneKeyFor(i.message)));
      if (index === -1) break;
      const decision = this.governor.canAdmit(this.activeTurns.size);
      if (!decision.ok) {
        if (this.lastAdmitRefusal !== decision.reason) {
          logger.info({ reason: decision.reason, running: this.activeTurns.size, waiting: this.messageQueue.length, limit: this.governor.limit() }, 'Turn governor: holding new turns');
        }
        this.lastAdmitRefusal = decision.reason;
        break;
      }
      this.lastAdmitRefusal = null;
      const [item] = this.messageQueue.splice(index, 1);
      if (item.workKey) this.queuedWorkKeys.delete(item.workKey);
      this.startTurn(item);
    }
    // The line moved: everyone still waiting learns their place and what they wait for.
    this.announceQueue();
  }

  private startTurn(item: { message: ChannelMessage; workKey?: string }): void {
    const msg = item.message;
    const laneKey = laneKeyFor(msg);
    const turn: TurnState = {
      id: `t${++this.turnSeq}`,
      laneKey,
      message: msg,
      startedAt: Date.now(),
      abort: null,
      abortReason: null,
      cancelled: null,
      activity: '',
      completedStepCount: 0,
      stepNarrative: [],
      workKey: item.workKey ?? null,
      lastProgressAt: Date.now(),
      lastTypingAt: 0,
      injectedBeliefIds: [],
      lifecycle: new Lifecycle('idle'),
      programming: null,
      done: false,
      trace: new TurnTrace(),
    };
    this.activeTurns.set(laneKey, turn);
    logger.info({ turn: turn.id, lane: laneKey, running: this.activeTurns.size, limit: this.governor.limit() }, 'Turn started');
    const startCwd = typeof msg.metadata?.workCwd === 'string' && existsSync(msg.metadata.workCwd) ? msg.metadata.workCwd : this.cwdForLane(laneKey);

    void this.turnStore.run(turn, () => runInTurnScope(() => this.capabilities.permissions.withTurn(async () => {
      // This turn's working directory, tools switch and image switch are its own.
      this.capabilities.claimTurnState(startCwd);
      claimToolImagesForTurn();
      // Its requests carry this chat's effort override, if it has one (#188).
      claimEffortChat(laneKey);
      // What untrusted content this turn reads, starting clean (ADR-044).
      claimExposureForTurn();
      noteMessageExposure(msg);
      try {
        await this.runQueuedItem(item);
      } finally {
        this.rememberLaneCwd(laneKey, this.capabilities.getCwd());
        // However the turn ended (reply, error, stop), its streamed text is no longer "live".
        const ch = this.channels.getChannelForMessage(msg);
        if (ch instanceof WebChannel) ch.clearLiveText(msg.channelId);
      }
    }))).catch((err) => {
      logger.error({ err, turn: turn.id }, 'Turn failed outside its handler');
    }).finally(() => {
      turn.done = true;
      if (this.activeTurns.get(laneKey) === turn) this.activeTurns.delete(laneKey);
      logger.info({ turn: turn.id, lane: laneKey, ms: Date.now() - turn.startedAt, running: this.activeTurns.size }, 'Turn ended');
      if (this.activeTurns.size === 0) this.governor.noteIdle();
      this.processQueue();
      if (this.isIdle() && this.idleWaiters.length > 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    });
  }

  /** One queued message, start to finish: the work ledger and scheduled-run bookkeeping around handleMessage. */
  private async runQueuedItem(item: { message: ChannelMessage; workKey?: string }): Promise<void> {
    const msg = item.message;
    // Cancelled while it waited (or a retry timer that raced a stop): never run it.
    if (item.workKey && this.workLedger.get(item.workKey)?.status === 'cancelled') {
      logger.info({ workKey: item.workKey }, 'Skipping cancelled work');
      return;
    }
    try {
      if (item.workKey) this.workLedger.markRunning(item.workKey);
      await this.withSessionProgramming(msg, () => this.handleMessage(msg));
      if (item.workKey && this.workLedger.get(item.workKey)?.status === 'running') {
        this.workLedger.markFailed(item.workKey, 'Work ended without producing a durable final response');
      }
    } catch (err) {
      if (item.workKey) {
        const entry = this.workLedger.get(item.workKey);
        if (entry?.status === 'completed') this.workLedger.markDeliveryError(item.workKey, err);
        else this.workLedger.markFailed(item.workKey, err);
      }
      logger.error({ err, msg: msg.content.slice(0, 50) }, 'Failed to handle message');
    } finally {
      const taskId = msg.metadata?.scheduledTaskId;
      const runId = msg.metadata?.scheduledRunId;
      if (typeof taskId === 'string' && typeof runId === 'string') {
        const entry = item.workKey ? this.workLedger.get(item.workKey) : undefined;
        try {
          this.scheduler.finishRun(taskId, runId, entry?.status === 'completed' ? 'completed' : 'failed',
            entry?.status === 'completed' ? undefined : entry?.error ?? 'Scheduled work ended without confirmed completion');
        } catch (err) {
          // Leave the durable running record uncertain, but always release queue state.
          logger.error({ err, taskId, runId }, 'Could not persist scheduled run outcome');
        }
      }
    }
  }

  /** The running turns as the governor sees them. */
  private governedTurns(): GovernedTurn[] {
    return [...this.activeTurns.values()].map((t) => ({
      id: t.id,
      startedAt: t.startedAt,
      label: `${t.laneKey}: ${this.describeTurn(t)}`,
      isStopping: () => t.done || t.cancelled !== null || !t.abort || t.abort.signal.aborted,
      shed: (error: Error) => {
        if (!t.abort || t.abort.signal.aborted) return;
        t.abortReason = 'memory-pressure';
        t.abort.abort(error);
        this.captureHeapSnapshot();
      },
    }));
  }

  private heapSnapshotTaken = false;

  /** Forensics, once per process: the first pressure stop writes a heap snapshot. Never throws. */
  private captureHeapSnapshot(): void {
    if (this.heapSnapshotTaken) return;
    this.heapSnapshotTaken = true;
    void (async () => {
      try {
        const { writeHeapSnapshot } = await import('node:v8');
        const file = path.join(getMercuryHome(), `heap-task-${Date.now()}.heapsnapshot`);
        writeHeapSnapshot(file);
        logger.error({ file }, 'Heap snapshot captured for memory forensics');
      } catch { /* forensics must never break the governor */ }
    })();
  }

  /**
   * The heap kept growing past the exit line even after turns were stopped:
   * the allocator runs outside any abortable path and a V8 crash is next.
   * Leave now, while the work ledger and sessions are still writable, so
   * every interrupted chat is recovered on the next start.
   */
  private exitForMemory(heapUsed: number): void {
    const turns = [...this.activeTurns.values()];
    const mb = Math.round(heapUsed / 1048576);
    try {
      const first = turns[0];
      writeCrashFlag({
        reason: `Memory safety exit at ${mb}MB with ${turns.length} task(s) running: ${turns.map((t) => this.describeTurn(t).slice(0, 60)).join(' | ').slice(0, 300)}`,
        timestamp: Date.now(),
        activeTask: first ? this.describeTurn(first) : undefined,
        channelId: first?.message.channelId,
        channelType: first?.message.channelType,
      });
    } catch { /* best effort */ }
    try {
      process.stderr.write(`\n⚠ Mercury stopped: memory grew to ${mb}MB.\n  Your work is saved and will be recoverable on the next start. Details: ~/.mercury/crash-report.log\n`);
    } catch { /* stderr gone */ }
    process.exit(0);
  }

  /**
   * One inline continuation round: re-enter generation with the full tool
   * loop and a fresh step budget, nudged by a system-style user message.
   * Used by the completion-contract paths (step-budget resume, verification
   * gate). Throws on provider interruption — the caller decides whether that
   * is fatal for its path.
   */
  private async runInlineContinuationRound(opts: {
    messages: unknown[];
    systemPrompt: string;
    /** Per-turn context block (memory, loop warnings); see withCachedSystem. */
    volatileSystem?: string;
    provider: any;
    maxOutputTokens: number;
    maxSteps: number;
    abortController: AbortController;
    channel: any;
    channelId: string;
    /** Mechanically force the first step to contain a tool call. */
    forceFirstTool?: boolean;
    toolDiscovery: ToolDiscovery;
    onStep: (toolCalls: any[] | undefined, toolResults: any[] | undefined, usage?: StepUsageLike) => void | Promise<void>;
  }): Promise<{ text: string; usage: any; reasoning?: any; finishReason?: string }> {
    this.markProgress(`Resuming with ${opts.provider.name}...`);
    const deadlineAt = Date.now() + MAX_PROVIDER_ATTEMPT_MS;
    const stream = streamText({
      model: opts.provider.getModelInstance(),
      // Mercury builds this system message itself (trusted, not user input);
      // opting in stops the SDK printing a warning on every call.
      allowSystemInMessages: true,
      messages: this.withCachedSystem(opts.systemPrompt, opts.messages, opts.volatileSystem),
      ...opts.toolDiscovery.request(undefined, { forceFirstTool: opts.forceFirstTool }),
      maxOutputTokens: opts.maxOutputTokens,
      stopWhen: stepCountIs(opts.maxSteps),
      // Live tool-step UI during continuation rounds: forced/verification
      // rounds land file writes, and the user must SEE which file is being
      // written at the bottom, exactly as in the main loop.
      experimental_onToolCallStart: ({ toolCall }: any) => {
        const tc = toolCall as any;
        this.markProgress(formatToolStep(tc.toolName, tc.input as Record<string, any> || {}));
        this.pushLiveToolEvent(tc.toolCallId ?? `${tc.toolName}:${Date.now()}`, tc.toolName, tc.input as Record<string, any> || {}, 'running');
      },
      experimental_onToolCallFinish: ({ toolCall, success, output, error, durationMs }: any) => {
        const tc = toolCall as any;
        this.pushLiveToolEvent(
          tc.toolCallId ?? `${tc.toolName}:${Date.now()}`,
          tc.toolName,
          success ? output : error,
          success ? 'done' : 'error',
          durationMs,
        );
      },
      abortSignal: opts.abortController.signal,
      experimental_include: { requestBody: false },
      onStepFinish: async ({ toolCalls, toolResults, usage }) => {
        await opts.onStep(toolCalls as any[], toolResults as any[], usage);
      },
    });
    const text = (opts.channel
      ? await this.withProviderDeadline(
        opts.channel.stream(stepAwareTextStream(stream.fullStream, this.reasoningSink(opts.channel, opts.channelId)), opts.channelId),
        opts.abortController,
        deadlineAt,
      )
      : '') as string;
    const finish = await this.withProviderDeadline(
      stream.finishReason,
      opts.abortController,
      deadlineAt,
    );
    if (finish === 'error') throw new Error('Continuation stream ended with an error');
    const completion = classifyStreamCompletion({ finishReason: finish, hasText: text.length > 0 });
    if (completion === 'interrupted') {
      throw new Error('Continuation stream was interrupted (no finish signal from provider)');
    }
    return { text, usage: await stream.usage, reasoning: stream.reasoning, finishReason: finish };
  }

  /**
   * Emit a bounded, syntax-highlighted file-change preview into the coding
   * TUI transcript when a file tool succeeds ("sometimes, not always" — the
   * size heuristics live in buildFileChangePreview). Never throws: a preview
   * failure must not break the tool loop.
   */
  private maybeShowFileChange(
    channel: any,
    msg: ChannelMessage,
    toolName: string,
    input: unknown,
    result: unknown,
  ): void {
    try {
      if (!(channel instanceof CLIChannel)) return;
      const tui = channel.getTuiState();
      if (tui.mode !== 'mercury-code' && tui.mode !== 'coding') return;
      const tr = result as any;
      const resultText = typeof tr === 'string' ? tr : JSON.stringify(tr ?? '');
      const preview = buildFileChangePreview({
        toolName,
        args: (input ?? {}) as Record<string, any>,
        resultText,
        ok: !isFailedToolResult(resultText || ''),
      });
      if (preview) channel.showFileChange(preview);
    } catch { /* preview must never break the tool loop */ }
  }

  /**
   * Record the model's plan checklist (update_plan tool) into the TUI so the
   * user sees which step is being implemented. Never throws.
   */
  /** Tell the owner about this turn's artifacts: a card in the apps, a line in the terminal (it can't show them). */
  private announceArtifacts(channel: unknown, items: Artifact[], targetId?: string): void {
    try {
      if (channel instanceof CLIChannel) {
        const list = items.slice(0, 6).map((a) => `${a.name} (${artifactKindLabel(a.kind)}, ${formatBytes(a.size)})`).join(', ');
        const more = items.length > 6 ? ` and ${items.length - 6} more` : '';
        const where = items.length === 1 ? `\n  ${items[0].originalPath}` : '';
        channel.sendSystemNotice(`◆ ${items.length === 1 ? 'Artifact' : `${items.length} artifacts`}: ${list}${more}${where}\n  Open them in Mercury Desktop → Artifacts.`);
      } else {
        const app = channel as { sendArtifacts?: (refs: ReturnType<typeof artifactRef>[], targetId?: string) => void } | null;
        if (typeof app?.sendArtifacts === 'function') app.sendArtifacts(items.map(artifactRef), targetId);
      }
    } catch { /* telling about artifacts must never break a turn */ }
  }

  private maybeRecordPlanProgress(channel: unknown, toolName: string, input: unknown, targetId?: string): void {
    try {
      if (toolName !== 'update_plan') return;
      const steps = (input as { steps?: Parameters<CLIChannel['setPlanProgress']>[0] } | null)?.steps;
      if (channel instanceof CLIChannel) channel.setPlanProgress(steps);
      else {
        // The apps (Chat, Code): a card above the composer, kept with the conversation.
        const app = channel as { sendPlan?: (s: typeof steps, targetId?: string) => void } | null;
        if (typeof app?.sendPlan === 'function') app.sendPlan(steps, targetId);
      }
    } catch { /* checklist must never break the tool loop */ }
  }

  private scheduleDurableRetry(msg: ChannelMessage, workKey: string, error: unknown, continuation = false): number {
    // Stopped work is never retried or continued (ADR-038).
    if (this.turnCancelled() || this.workLedger.get(workKey)?.status === 'cancelled') return 0;
    const attempts = this.workLedger.get(workKey)?.attempts ?? 1;
    const delayMs = continuation
      ? Math.min(2_000 * 2 ** Math.min(attempts - 1, 5), 60_000)
      : Math.min(5_000 * 2 ** Math.min(attempts - 1, 6), 5 * 60_000);
    this.workLedger.markRetry(workKey, error, Date.now() + delayMs, {
      continuation,
      workCwd: this.capabilities.getCwd(),
      activity: this.currentActivity,
      summary: formatNarrative(this.stepNarrative, this.currentActivity, 8),
    });
    const timer = setTimeout(() => {
      const entry = this.workLedger.get(workKey);
      if (!entry || entry.status !== 'queued') return;
      this.queueMessage(entry.message, workKey);
      void this.processQueue();
    }, delayMs);
    timer.unref?.();
    return delayMs;
  }

  private isRetryableProviderError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return /timeout|timed out|network|socket|connection|temporar|unavailable|overloaded|rate.?limit|\b429\b|\b5\d\d\b|econn|fetch failed|stalled/.test(message);
  }

  /**
   * Durable provider fallback notice. On the CLI TUI (Mercury Code included)
   * it goes through sendSystemNotice — a durable system row that renders in
   * the coding transcript and survives the turn; on other channels it rides
   * the heartbeat or a plain send as before.
   */
  private async sendFallbackNotice(msg: ChannelMessage, line: string): Promise<void> {
    const channel = this.channels.getChannelForMessage(msg);
    if (!channel || msg.channelType === 'internal') return;
    if (channel instanceof CLIChannel) {
      channel.sendSystemNotice(line);
      return;
    }
    if (channel instanceof WebChannel) {
      channel.sendHeartbeat(line, msg.channelId);
      return;
    }
    await channel.send(line, msg.channelId);
  }

  private async sendProgressNotice(msg: ChannelMessage, message: string): Promise<void> {
    const channel = this.channels.getChannelForMessage(msg);
    if (!channel || msg.channelType === 'internal') return;
    if (channel instanceof WebChannel) {
      channel.sendHeartbeat(message, msg.channelId);
      return;
    }
    if (channel instanceof CLIChannel) {
      channel.sendHeartbeat(message);
      return;
    }
    await channel.send(message, msg.channelId);
  }

  private channelProviderOverrides = new Map<string, { providerName: string; modelName: string; provider: BaseProvider }>();
  /** Dedupes the "served by a fallback provider" notice — one per (default → served) pair per runtime. */
  private lastFallbackNoticeKey: string | null = null;
  /** Mercury Code hand-off preference, remembered PER SESSION (like the
   * session permission modes): 'code' = auto-switch on coding tasks, 'chat' =
   * never ask in this session. Only EXPLICIT answers are remembered — a
   * timeout (nobody answered) asks again on the next coding task. */
  private mercuryCodeHandoffPreferences = new Map<string, 'chat' | 'code'>();

  async listChatModelOptions(): Promise<Array<{ provider: string; label: string; model: string; models: string[]; selected: boolean }>> {
    const active = getActiveProviders(this.config);
    const current = this.getCurrentProvider();
    return Promise.all(active.map(async (provider) => {
      let models = [provider.model].filter(Boolean);
      try {
        const catalog = await fetchProviderModelCatalog(provider.name as any, provider.name === 'mercuryCloud'
          ? {
            ...provider,
            apiKey: this.config.cloud.accessKey || this.config.cloud.jwt || provider.apiKey,
            baseUrl: this.config.cloud.apiUrl || provider.baseUrl,
          }
          : provider);
        models = [...new Set([provider.model, catalog.recommendedModel, ...catalog.models].filter(Boolean))];
      } catch (err) {
        logger.debug({ provider: provider.name, err }, 'Unable to fetch provider model catalog; using configured model');
        models = [...new Set([provider.model, ...getPreferredModelsForProvider(provider.name as any)].filter(Boolean))];
      }

      return {
        provider: provider.name,
        label: provider.name,
        model: provider.model,
        models,
        selected: provider.name === current.name,
      };
    }));
  }

  async setChannelProviderOverride(
    channelId: string,
    providerName: string,
    modelName?: string,
    options: { persist?: boolean } = {},
  ): Promise<{ ok: boolean; message: string; provider?: string; model?: string }> {
    const active = getActiveProviders(this.config);
    const config = active.find((provider) => provider.name === providerName);
    if (!config) {
      return { ok: false, message: `Provider \`${providerName}\` is not configured for this local agent.` };
    }

    const provider = await createProvider(
      { ...config, model: modelName || config.model },
      providerName === 'mercuryCloud' ? getCloudTokenStore() : undefined,
    );
    if (!provider) {
      return { ok: false, message: `Provider \`${providerName}\` is not available in the running registry.` };
    }

    const previousOverride = this.channelProviderOverrides.get(channelId)?.provider as (BaseProvider & { destroy?: () => void }) | undefined;
    if (previousOverride !== provider && this.providers.get(previousOverride?.name) !== previousOverride) {
      previousOverride?.destroy?.();
    }
    this.channelProviderOverrides.set(channelId, { providerName, modelName: provider.getModel(), provider });

    if (options.persist && providerName in this.config.providers) {
      const providerKey = providerName as ProviderName;
      const providerConfig = this.config.providers[providerKey];
      providerConfig.model = provider.getModel();
      providerConfig.enabled = true;
      this.config.providers.default = providerName as ProviderName;
      this.providers.set(providerName, provider);
      this.providers.setDefault(providerName);
      saveConfig(this.config);
      updateCliProviderStatus(this.channels.get('cli'), providerName, provider.getModel());
    }

    const saved = options.persist ? ' Saved as the default for future sessions.' : '';
    return { ok: true, message: `This chat will use **${providerName}** · **${provider.getModel()}**.${saved}`, provider: providerName, model: provider.getModel() };
  }

  async switchSessionProvider(providerName: string): Promise<{ ok: boolean; message: string }> {
    const active = getActiveProviders(this.config).map((p) => p.name);
    if (!active.includes(providerName)) {
      return { ok: false, message: `Provider \`${providerName}\` is not configured. Run \`mercury doctor\` to add/configure models.` };
    }

    this.config.providers.default = providerName as any;
    // In place: bots, kanban and the IDE hold this same registry, so a new
    // instance would leave them on the old (destroyed) providers.
    await this.providers.reload(this.config, getCloudTokenStore());
    const selected = this.providers.getDefault();
    const model = selected.getModel();

    // Persist: `/models use` is an explicit default change — it must survive
    // restart. It used to mutate only the in-memory config, so the switch was
    // silently lost (or half-persisted by an unrelated saveConfig) on restart.
    saveConfig(this.config);
    updateCliProviderStatus(this.channels.get('cli'), providerName, model);

    // "Saved for future sessions" read as "takes effect next session"; it
    // applies to the next message and stays the default after a restart.
    return { ok: true, message: `✓ Switched to **${model}** (${providerName}). In effect from your next message, and kept as the default.` };
  }

  /** Returns the currently active provider name and model. */
  getCurrentProvider(): { name: string; model: string } {
    try {
      const p = this.providers.getDefault();
      return { name: this.config.providers.default as string || p.name, model: p.getModel() };
    } catch {
      return { name: this.config.providers.default as string || 'unknown', model: '' };
    }
  }

  /** Public wrapper for web API model switching. */
  async switchProvider(providerName: string, model?: string): Promise<{ ok: boolean; message: string }> {
    // Providers like Ollama Local serve many models; pin the requested one
    // before the registry is rebuilt from config. Both values come from the
    // web API, so validate before writing: an unchecked key such as
    // "__proto__" would write onto Object.prototype, and the model id is
    // persisted to mercury.yaml.
    if (model !== undefined) {
      if (typeof model !== 'string' || model.length === 0 || model.length > 256 || [...model].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
        return { ok: false, message: 'Invalid model id.' };
      }
      const providers = this.config.providers as unknown as Record<string, unknown>;
      const configured = getActiveProviders(this.config).some((p) => p.name === providerName);
      if (!configured || !Object.hasOwn(providers, providerName)) {
        return { ok: false, message: `Provider \`${providerName}\` is not configured.` };
      }
      const pc = providers[providerName];
      if (pc && typeof pc === 'object') (pc as { model?: string }).model = model;
    }
    return this.switchSessionProvider(providerName);
  }

  /**
   * Apply provider settings saved elsewhere (desktop Settings, dashboard)
   * without a restart. Re-reads mercury.yaml so this in-memory config can't
   * later write a stale key back over the new one, then reloads the shared
   * registry in place.
   */
  async reloadProviders(): Promise<{ ok: boolean; providers: string[]; default: string; model: string }> {
    const fresh = loadConfig();
    Object.assign(this.config.providers, fresh.providers);
    this.config.memory.learning = { ...this.config.memory.learning, provider: fresh.memory.learning?.provider };
    if (fresh.bots?.fleets && this.config.bots?.fleets) this.config.bots.fleets.crewProvider = fresh.bots.fleets.crewProvider;
    const { registered } = await this.providers.reload(this.config, getCloudTokenStore());
    const current = this.getCurrentProvider();
    updateCliProviderStatus(this.channels.get('cli'), current.name, current.model);
    return { ok: registered.length > 0, providers: registered, default: current.name, model: current.model };
  }

  async birth(): Promise<void> {
    this.lifecycle.transition('birthing');
    logger.info({ name: this.config.identity.name }, 'Mercury is being born...');
    this.lifecycle.transition('onboarding');
  }

  async wake(): Promise<void> {
    this.lifecycle.transition('onboarding');
    this.lifecycle.transition('idle');
    if (!this.terminalOnly) {
      this.scheduler.restorePersistedTasks();
      this.scheduler.startHeartbeat();
    }
    await this.channels.startAll();
    this.running = true;
    this.governor.start(() => this.governedTurns());

    if (!this.terminalOnly) {
      const recovered = this.workLedger.recoverInterrupted();
      for (const entry of recovered) this.queueMessage(entry.message, entry.key);
      await this.replayUndeliveredResponses();
    }
    this.startOutboxRetry();
    void this.processQueue();

    const activeChannels = this.channels.getActiveChannels();
    const toolNames = this.capabilities.getToolNames();
    logger.info({ channels: activeChannels, tools: toolNames }, 'Mercury is awake');
  }

  async sleep(): Promise<void> {
    this.running = false;
    this.governor.stop();
    if (this.outboxRetryTimer) {
      clearInterval(this.outboxRetryTimer);
      this.outboxRetryTimer = null;
    }
    this.scheduler.stopAll();
    await this.channels.stopAll();
    this.lifecycle.transition('sleeping');
    logger.info('Mercury is sleeping');
  }

  private async replayUndeliveredResponses(): Promise<void> {
    if (this.replayingOutbox) return;
    this.replayingOutbox = true;
    try {
      for (const entry of this.workLedger.getUndeliveredResponses()) {
        await this.deliverLedgerEntry(entry);
      }
    } finally {
      this.replayingOutbox = false;
    }
  }

  private startOutboxRetry(): void {
    if (this.outboxRetryTimer) return;
    this.outboxRetryTimer = setInterval(() => {
      if (this.running) void this.replayUndeliveredResponses();
    }, 30_000);
    this.outboxRetryTimer.unref?.();
  }

  private async deliverLedgerEntry(entry: WorkEntry): Promise<void> {
    const channel = this.channels.getChannelForMessage(entry.message);
    if (!channel || !entry.finalResponse) return;
    const requestId = typeof entry.message.metadata?.requestId === 'string' ? entry.message.metadata.requestId : undefined;
    const isCloudRequest = channel instanceof WebChannel
      && typeof entry.message.metadata?.externalConversationId === 'string'
      && requestId;
    if (isCloudRequest && !channel.hasCloudEventHandler(requestId)) return;
    try {
      if (entry.status === 'failed' && channel instanceof WebChannel) {
        if (!channel.sendError(entry.finalResponse, entry.message.channelId)) throw new Error('Cloud WebSocket could not accept the terminal error');
      } else {
        await channel.send(entry.finalResponse, entry.message.channelId);
      }
      if (!isCloudRequest) this.workLedger.markDelivered(entry.key);
    } catch (error) {
      this.workLedger.markDeliveryError(entry.key, error);
      logger.warn({ error, workKey: entry.key }, 'Durable response replay failed');
    }
  }

  private finalizeChannelTask(msg: ChannelMessage): void {
    const channel = this.channels.getChannelForMessage(msg);
    if (channel instanceof TelegramChannel || channel instanceof SignalChannel || channel instanceof DiscordChannel || channel instanceof SlackChannel) {
      channel.endTask(msg.channelId);
      channel.resetStepCounter(msg.channelId);
    } else if (channel && typeof (channel as { endTask?: unknown }).endTask === 'function') {
      // Any other channel that wants to know a turn finished (plugin channels: a
      // voice call waits for the turn's answer).
      try { (channel as unknown as { endTask: (id: string) => void }).endTask(msg.channelId); } catch { /* best effort */ }
    }
  }

  /**
   * The user's explicit skill pick (ADR-039, ADR-040): `#skill-name …` tells
   * the model to use that skill; an unknown `#tag` is stripped. Nothing else
   * is routed — the model sees every installed skill and its description in
   * the system prompt and picks itself. Mercury used to stop the turn on a
   * skill picker before the first model call, answer that picker itself on
   * voice channels, tell the model "User clarified: use X" although nobody
   * had, run skill batches as sub-agents up front, and later suggest skills
   * from a fuzzy match.
   */
  private applyExplicitSkillPick(msg: ChannelMessage, trimmed: string, messages: Array<{ role: string; content: unknown }>): void {
    if (!this.skillLoader || msg.channelType === 'internal') return;
    const hashMatch = trimmed.match(/^#([a-z0-9_:.-]+)\b\s*(.*)$/i);
    if (!hashMatch) return;
    try {
      const skillName = hashMatch[1];
      const rest = hashMatch[2].trim();
      const knownSkills = this.skillLoader.getDiscovered?.() || [];
      if (knownSkills.some((s: any) => s.name === skillName)) {
        messages[messages.length - 1] = { role: 'user', content: rest || trimmed };
        messages.push({
          role: 'user',
          content: `[Routing] The user explicitly selected the \`${skillName}\` skill via #-prefix. Invoke it via \`use_skill\` with name="${skillName}" before doing anything else, then act on the result.`,
        });
      } else {
        // Unknown #tag: just strip it.
        const stripped = rest || trimmed.replace(/^#\S+\s*/, '');
        if (stripped) messages[messages.length - 1] = { role: 'user', content: stripped };
      }
    } catch (err) {
      logger.warn({ err }, 'Explicit skill pick failed — continuing without it');
    }
  }

  /**
   * Memory retrieved for this message: Second Brain recall, then the shared
   * cloud pool when local recall is weak (fail-open), or long-term facts when
   * Second Brain is off. Returned blocks go into the per-turn system block.
   */
  private async retrieveMemoryContext(msg: ChannelMessage): Promise<string[]> {
    const blocks: string[] = [];
    this.lastInjectedBeliefIds = [];
    if (this.userMemory) {
      // Beliefs relevant to this message (ADR-026): up to 5 held/confirmed
      // ones, with confidence, so the model can lean on them and the next
      // turn can credit them as "acted on without objection".
      try {
        const words = ownerWords(msg.content);
        const selfAsk = asksAboutSelf(words);
        const relevant = selfAsk
          ? this.userMemory.beliefs.strongest(12)
          : this.userMemory.beliefs.searchRelevant(words, 5);
        if (relevant.length > 0) {
          // Only sure beliefs earn "acted on without objection" credit;
          // a candidate the model happened to see proves nothing yet.
          const ids = relevant.map((b) => b.id);
          this.userMemory.beliefs.markUsed(ids);
          this.lastInjectedBeliefIds = relevant.filter((b) => b.status === 'held' || b.status === 'confirmed').map((b) => b.id);
          const line = (b: typeof relevant[number]) => {
            const status = b.status === 'candidate' ? 'unverified, seen once' : b.status;
            return `- (confidence ${b.confidence.toFixed(2)}, ${status}${b.context !== '*' ? `, ${b.context}` : ''}) ${b.statement}`;
          };
          const heading = selfAsk
            ? 'The owner is asking what you know about them. Your strongest beliefs (say which are unverified; the search_memory tool finds more):'
            : 'Beliefs about the owner relevant to this message (treat "unverified" ones as hunches, not facts):';
          blocks.push(heading + '\n' + relevant.map(line).join('\n'));
        }
      } catch (err) {
        logger.debug({ err: (err as Error).message }, 'belief retrieval failed');
      }

      // The beliefs above are the only local recall (ADR-026: one source);
      // their statements are what the pool search dedupes against.
      const localRecall = this.lastInjectedBeliefIds
        .map((id) => this.userMemory?.beliefs.get(id)?.statement)
        .filter((s): s is string => typeof s === 'string');

      // Local-first, then pool: query the cloud SharedMemoryPool for additional
      // context the second brain didn't surface. Gated by config, fails open
      // (any error → proceed with local-only context). 5-min cache per query.
      // Skipped when local recall was already strong: the pool call is an
      // awaited network round-trip on the path to the first token.
      const ck = this.config.memory.collaborativeKnowledge;
      const cloud = this.config.cloud;
      const tokenStore = getCloudTokenStore();
      const localRecallIsStrong = localRecall.length >= 3;
      if (ck?.poolSearch !== false && cloud?.enabled && cloud?.jwt && cloud?.apiUrl && !localRecallIsStrong) {
        try {
          const { searchPool, formatPoolContextBlock, dedupeAgainstLocal } = await import('../cloud/pool-search.js');
          const poolHits = await searchPool(
            cloud.apiUrl,
            cloud.jwt,
            cloud.refreshToken,
            msg.content,
            { limit: 10 },
            (newJwt, newRefresh) => {
              // Route every rotation through the shared store so all
              // consumers see the new tokens. Fallback to direct config
              // mutation if the store isn't initialized (older code path).
              if (tokenStore) {
                tokenStore.setTokensAndPersist(newJwt, newRefresh);
              } else {
                cloud.jwt = newJwt;
                cloud.refreshToken = newRefresh;
                this.config.providers.mercuryCloud.apiKey = newJwt;
                saveConfig(this.config);
              }
            },
          );
          const deduped = dedupeAgainstLocal(poolHits, localRecall);
          const poolBlock = formatPoolContextBlock(deduped, 1500);
          if (poolBlock) blocks.push(poolBlock);
        } catch (err) {
          logger.debug({ err: (err as Error).message }, 'pool search failed (fail-open)');
        }
      }
    } else {
      const relevantFacts = this.longTerm.search(msg.content, 3);
      if (relevantFacts.length > 0) {
        blocks.push('Relevant facts from memory:\n' + relevantFacts.map(f => `- ${f.fact}`).join('\n'));
      }
    }
    return blocks;
  }

  private async handleMessage(msg: ChannelMessage): Promise<void> {
    this.lifecycle.transition('thinking');
    const startTime = Date.now();
    // Short id printed on every terminal message and resolvable with /trace.
    const traceId = (msg.id || '').replace(/[^a-z0-9]/gi, '').slice(-8) || Date.now().toString(36);
    let loopAbortController = new AbortController();
    this.currentAbort = loopAbortController;
    this.currentAbortReason = null;
    const durableCwd = typeof msg.metadata?.workCwd === 'string' ? msg.metadata.workCwd : undefined;
    if (durableCwd && existsSync(durableCwd)) {
      this.capabilities.setCwd(durableCwd);
      this.capabilities.permissions.addTempScope(durableCwd, true, true);
    }
    this.currentActivity = '';
    this.completedStepCount = 0;
    this.stepNarrative = [];
    // A slash command is handled below without the model: no "Processing"
    // block, no heartbeat — those are raised only if it falls through to a
    // real turn. (/memory opens a menu that blocks here for as long as it is
    // open; with the indicator up it read as a hung agent.)
    const isSlashCommand = msg.content.trim().startsWith('/');
    let turnIndicatorUp = false;
    const raiseTurnIndicator = (): void => {
      if (turnIndicatorUp) return;
      turnIndicatorUp = true;
      this.markProgress('Starting...');
      this.pushLiveActivity('Starting task');
    };
    // This chat's folder in ~/mercury-artifacts for the turn, if it gets one (set below).
    let chatFolder: string | null = null;
    let cwdBeforeChatFolder: string | null = null;
    // Research switched on for this chat: this message is the run.
    const researchRun = !isSlashCommand && msg.channelType !== 'internal' && this.researchMode.armedForSession(msg.channelId)
      ? this.researchMode.beginRun(msg.channelId, msg.content, this.saverMode.adjustMaxSteps(MAX_STEPS) * 3)
      : null;
    if (researchRun) this.emitResearch(msg, researchRun);
    if (!isSlashCommand) raiseTurnIndicator();
    const stopHeartbeat = isSlashCommand ? () => {} : this.startForegroundHeartbeat(msg);
    // Memory: the turn governor watches the heap for the whole process (one
    // timer, not one per turn) and stops the newest turn under pressure
    // (ADR-037). At step boundaries this turn checks in deterministically —
    // the timer can't fire while the event loop is flooded.
    const turnId = this.turn()?.id;
    const memoryGovernor = (phase: string): 'ok' | 'abort' | 'exit' => {
      const turns = this.governedTurns();
      const verdict = this.governor.verdict(turns.length);
      if (verdict === 'exit') return 'exit';
      if (verdict === 'ok') return 'ok';
      logger.warn({ phase, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), running: turns.length }, 'Step governor: over the memory line — trimming conversation');
      return 'abort';
    };
    const shouldYieldToMemory = (): boolean => turnId !== undefined && this.governor.shouldShed(turnId, this.governedTurns());
    // Stall watchdog: the memory guard covers heap growth; this covers time.
    // A task that emits nothing (no chunks, no tool events, no steps) for
    // minutes is almost certainly dead — surface it, then abort the attempt
    // so the continuation/approval machinery can inspect and resume.
    const stallWatchdog = new StallWatchdog({
      getHeartbeat: () => this.lastProgressAt,
      getActivity: () => this.currentActivity,
      onSoft: (silentMs, activity) => {
        logger.info({ silentMs, activity }, 'Stall watchdog: soft threshold — surfacing still-working pulse');
        this.pushLiveActivity(
          `Still working — ${activity || 'working'} · ${Math.round(silentMs / 1000)}s silent`,
          'stall watchdog',
        );
      },
      onHard: (silentMs, activity) => {
        if (loopAbortController.signal.aborted) return;
        logger.warn({ silentMs, activity }, 'Stall watchdog: no progress past hard threshold — aborting attempt for inspection/resume');
        loopAbortController.abort(new Error(`Task stalled ${Math.round(silentMs / 60000)} minutes with no progress (was: ${activity || 'unknown'})`));
      },
    });
    stallWatchdog.start();
    let canonicalSessionId: string | undefined;
    let releaseSession: (() => void) | null = null;
    // Bills the turn's model steps to the token budget, once. Set when the
    // turn starts calling models; the finally runs it for turns that end
    // early (all providers failed, an honest pause, a memory stop, a retry
    // scheduled) — their steps were spent too.
    let flushTurnUsage: (() => void) | null = null;

    if (this.supervisor && msg.channelType !== 'internal') {
      const activeAgents = this.supervisor.getActiveAgents();
      const runningAgents = activeAgents.filter(a => a.status === 'running');
      if (runningAgents.length > 0) {
        const channel = this.channels.getChannelForMessage(msg);
        if (channel) {
          const agentLines = runningAgents.map(a => `  🔄 ${a.id}: ${a.task.slice(0, 45)}${a.task.length > 45 ? '...' : ''}`);
          await channel.send(`**Multi-agent mode** — ${runningAgents.length} agent${runningAgents.length > 1 ? 's' : ''} active:\n${agentLines.join('\n')}`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
        }
      }
    }

      const isInternal = msg.channelType === 'internal';
      if (isInternal) {
        // Turn-scoped grant on the root context only (ADR-016): running
        // sub-agents keep their own context and new ones do not inherit it.
        this.capabilities.permissions.beginTurnGrant({ scopes: [{ path: '/', read: true, write: true }] });
      }

    try {
      const trimmed = msg.content.trim();
      if (trimmed.startsWith('/budget')) {
        const subcommand = trimmed.slice('/budget'.length).trim();
        await this.handleBudgetCommand(subcommand || 'status', msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }

      if (trimmed === '/budget_override') {
        await this.handleBudgetCommand('override', msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }
      if (trimmed === '/budget_reset') {
        await this.handleBudgetCommand('reset', msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }
      if (trimmed.startsWith('/budget_set')) {
        const args = trimmed.slice('/budget_set'.length).trim();
        await this.handleBudgetCommand('set ' + args, msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }
      if (trimmed.startsWith('/stream')) {
        const sub = trimmed.slice('/stream'.length).trim().toLowerCase();
        if (sub === 'off') {
          this.telegramStreaming = false;
        } else if (sub === 'on') {
          this.telegramStreaming = true;
        } else {
          this.telegramStreaming = !this.telegramStreaming;
        }
        const ch = this.channels.get(msg.channelType as any);
        const streamingLabel = msg.channelType === 'discord' ? 'Discord' : msg.channelType === 'slack' ? 'Slack' : 'Telegram';
        if (ch) await ch.send(
          this.telegramStreaming
            ? `${streamingLabel} streaming enabled. Responses will appear progressively.`
            : `${streamingLabel} streaming disabled. Responses will arrive as a single message.`,
          msg.channelId,
        );
        this.lifecycle.transition('idle');
        return;
      }

      if (await this.handleChatCommand(trimmed, msg.channelType, msg.channelId)) {
        this.lifecycle.transition('idle');
        return;
      }

      if (await this.handleWorkspaceNaturalLanguage(trimmed, msg.channelType, msg.channelId)) {
        this.lifecycle.transition('idle');
        return;
      }

      if (this.tokenBudget.isOverBudget()) {
        const channel = this.channels.getChannelForMessage(msg);
        if (channel && msg.channelType !== 'internal') {
          if (msg.channelType === 'cli') {
            if (['1', '2', '3', '4'].includes(trimmed)) {
              await this.handleBudgetCommand(trimmed, msg.channelType, msg.channelId);
              this.lifecycle.transition('idle');
              return;
            }
            await this.handleBudgetOverrideCLI(channel, msg);
          } else {
            await channel.send(
              `I've exceeded my daily token budget (${this.tokenBudget.getStatusText()}).\n\nYou can override this:\n• /budget override — allow one more request\n• /budget reset — reset usage to zero\n• /budget set <number> — change daily budget`,
              msg.channelId,
            );
          }
        }
        this.lifecycle.transition('idle');
        return;
      }

      // Token Saver Mode auto-engagement check. When usage crosses the
      // configured threshold (default 75%), saver activates and the user
      // is notified once so they understand response style may change.
      {
        const transition = this.saverMode.evaluateAuto(this.tokenBudget.getUsagePercentage());
        if (transition.activated) {
          const notice = this.saverMode.consumeAutoActivationNotice();
          if (notice && msg.channelType !== 'internal') {
            const ch = this.channels.get(msg.channelType as any);
            if (ch) await ch.send(notice, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
          }
          this.syncSaverToCli();
        } else if (transition.deactivated && msg.channelType !== 'internal') {
          const ch = this.channels.get(msg.channelType as any);
          if (ch) await ch.send('⚡ Token Saver Mode auto-disengaged (usage dropped). Normal response settings restored.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
          this.syncSaverToCli();
        }
      }

      const suppliedSessionId = msg.sessionId ?? (typeof msg.metadata?.sessionId === 'string' ? msg.metadata.sessionId : undefined);
      const externalConversationId = msg.channelType === 'cli'
        ? 'current'
        : typeof msg.metadata?.externalConversationId === 'string' ? msg.metadata.externalConversationId : msg.channelId;
      const canonicalSession = this.sessions.getOrCreateBound(msg.channelType, externalConversationId, suppliedSessionId);
      canonicalSessionId = canonicalSession.id;
      // Two lanes can reach one stored conversation (the terminal resuming a
      // chat the desktop has open): their turns take it one at a time, so
      // its history never interleaves (ADR-037).
      releaseSession = await this.lockSession(canonicalSession.id);

      // A normal chat that would write loose files into the home folder (the
      // daemon's folder) writes into its own folder in ~/mercury-artifacts.
      // Code sessions, workspaces, a terminal opened in a project: unchanged.
      if (!isSlashCommand && msg.channelType !== 'internal' && !this.programmingMode.isActive()
        && path.resolve(this.capabilities.getCwd()) === path.resolve(homedir())) {
        try {
          const firstWords = canonicalSession.messages.find((m) => m.role === 'user')?.content ?? msg.content;
          // A real title when the chat has one; otherwise its first words (titles come after the first reply).
          const label = canonicalSession.title && canonicalSession.titleSource !== 'fallback' ? canonicalSession.title : fallbackSessionTitle(firstWords) || firstWords;
          const dir = this.chatFolders().open(canonicalSession.id, label, canonicalSession.createdAt || Date.now());
          cwdBeforeChatFolder = this.capabilities.getCwd();
          chatFolder = dir;
          this.capabilities.setCwd(dir);
          this.capabilities.permissions.addTempScope(dir, true, true);
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Chat folder unavailable; working in the home folder');
        }
      }

      // Set this turn's caller before exposing tools or routing a skill. A
      // previous local/owner turn must not determine remote recall access.
      this.capabilities.setChannelContext(msg.channelId, msg.channelType, canonicalSession.id);
      this.capabilities.permissions.setCurrentSenderRole(msg.senderRole);

      // Stable part = the cached system prefix; the parts that change between
      // turns (owner brief, bots, clock, cwd, memory count) go in the per-turn
      // block after it, so a new turn still hits the provider's cache (ADR-039).
      const promptParts = this.buildSystemPromptParts();
      let systemPrompt = promptParts.stable;
      if (chatFolder) systemPrompt += `\n- Files you make go in the working directory (this chat's folder in the owner's Mercury artifacts folder), unless the owner names another place. Use relative paths or that folder; never write loose files into the home folder.`;
      if (msg.metadata?.workContinuation === true) {
        const attempt = typeof msg.metadata.continuationAttempt === 'number' ? msg.metadata.continuationAttempt : 1;
        const reason = typeof msg.metadata.continuationReason === 'string' ? msg.metadata.continuationReason : 'The prior execution was interrupted.';
        const activity = typeof msg.metadata.continuationActivity === 'string' ? msg.metadata.continuationActivity : 'unknown';
        const summary = typeof msg.metadata.continuationSummary === 'string' ? msg.metadata.continuationSummary : 'No structured progress summary is available.';
        const cwd = typeof msg.metadata.workCwd === 'string' ? msg.metadata.workCwd : this.capabilities.getCwd();
        systemPrompt += `\n\n[SYSTEM: DURABLE CONTINUATION ${attempt}] Do not restart this task. Continue from the artifacts and side effects already present. First inspect the current filesystem and relevant external state, especially ${cwd}. Prior interruption: ${reason}. Last activity: ${activity}. Recorded progress: ${summary}. Do not repeat the failed strategy. If a file or tool payload was too large, use a different bounded approach: inspect what exists, generate smaller components, append or patch in small verified chunks, or generate repetitive content programmatically. Verify each existing artifact before changing it. Keep working until there is a usable final deliverable, then clearly report its location and validation result.`;
      } else if (msg.metadata?.workRecovered === true) {
        systemPrompt += '\n\n[SYSTEM: RECOVERED WORK] This request was recovered after the agent restarted or its prior run was interrupted. Inspect the current filesystem, external state, and conversation before acting. Do not repeat side effects that may already have completed. Continue from observed state, and explicitly report any ambiguity you cannot safely resolve.';
      }
      const canonicalMessageId = typeof msg.metadata?.canonicalMessageId === 'string' ? msg.metadata.canonicalMessageId : undefined;
      const requestId = typeof msg.metadata?.requestId === 'string' ? msg.metadata.requestId : undefined;
      this.sessions.appendMessage(canonicalSession.id, {
        id: canonicalMessageId,
        role: 'user',
        content: msg.content,
        timestamp: msg.timestamp,
        externalMessageId: msg.id,
        metadata: {
          channelType: msg.channelType,
          channelId: msg.channelId,
          workCwd: this.capabilities.getCwd(),
          ...(requestId ? { requestId } : {}),
          // Not the owner's words: the learning passes skip it (ADR-044).
          ...(msg.senderRole === 'member' ? { senderRole: 'member' } : {}),
          ...(msg.metadata?.channelAccess === 'general' ? { channelAccess: 'general' } : {}),
          // Files the owner sent with this turn, as refs a client can fetch back.
          ...(() => { const refs = attachmentRefs(msg.metadata?.attachments); return refs.length ? { attachments: refs } : {}; })(),
        },
      });
      // One read of the session per turn (it used to be re-read three times).
      const activeSession = this.sessions.get(canonicalSession.id);
      if (msg.channelType === 'cli') {
        const cliChannel = this.channels.get('cli');
        if (cliChannel instanceof CLIChannel) cliChannel.setCurrentSession(activeSession);
      }
      // Context window v2: history is budgeted by tokens rather than a fixed
      // ten messages, and includes the compact tool trace written at the end
      // of each turn, so this turn remembers what the previous one read and
      // wrote instead of starting blind.
      const recentMemory = selectHistoryWindow(
        activeSession.messages,
        this.saverMode.isActive() ? HISTORY_TOKEN_BUDGET_SAVER : HISTORY_TOKEN_BUDGET,
      );

      const history = buildModelHistory(recentMemory);
      const messages: any[] = [...history.messages];
      // Per-turn context (tool history, retrieved memory, loop warnings)
      // goes into a second, volatile system block instead of being staged as
      // fake user/assistant dialogue: the fake "Noted. I'll keep this in
      // mind." turns primed terse acknowledgements and polluted history.
      const contextBlocks: string[] = [];
      contextBlocks.push(budgetContext(this.tokenBudget.getStatusText(), this.tokenBudget.getUsagePercentage()));

      const loopWarning = detectRepetitionLoop(history.messages);
      if (loopWarning) contextBlocks.push(loopWarning);

      // Chat channels can carry an access level and guidance (plugin API 1.1,
      // e.g. WhatsApp): "general" means no tools, no personal memory and no
      // learning from the turn; the guidance tells the model where it is and
      // how to write for it.
      // A scheduled task the owner approved with specific plugin tools runs them unattended.
      this.capabilities.permissions.setTurnPluginGrants(
        msg.senderId === 'system' && Array.isArray(msg.metadata?.allowTools) ? (msg.metadata.allowTools as unknown[]).filter((t): t is string => typeof t === 'string') : [],
      );
      const generalAccess = msg.metadata?.channelAccess === 'general';
      this.capabilities.setToolsDisabled(generalAccess);
      const guidance = typeof msg.metadata?.channelGuidance === 'string' ? msg.metadata.channelGuidance.slice(0, 2000) : '';
      if (guidance) contextBlocks.unshift(guidance);
      if (!generalAccess) contextBlocks.push(...(await this.retrieveMemoryContext(msg)));

      if (history.toolContext) contextBlocks.push(history.toolContext);

      if (!canonicalSessionId) messages.push({ role: 'user', content: msg.content });

      const volatileSystem = [
        promptParts.dynamic,
        contextBlocks.length > 0 ? `## Context for this turn\n\n${contextBlocks.join('\n\n')}` : '',
      ].filter(Boolean).join('\n\n');
      // Mode-aware tool exposure: niche tool groups (Spotify) are left out of
      // the request unless the turn is about them. Schemas are re-sent on
      // every step, so this saves tokens on every step of every turn.
      const activeTools = selectActiveTools(
        Object.keys(this.capabilities.getTools()),
        msg.content,
        recentMemory.map((m) => m.content),
      );

      // A command that reached the model is a real turn after all.
      raiseTurnIndicator();
      // `#skill-name` is the user's explicit pick; any other skill choice is
      // the model's (ADR-040).
      this.applyExplicitSkillPick(msg, trimmed, messages);
      // `/image …` or the desktop's Image switch: an image model makes it (ADR-042).
      applyMediaIntent(msg, trimmed, messages);

      this.lifecycle.transition('responding');

      const channel = this.channels.getChannelForMessage(msg);
      if (channel) {
        await channel.typing(msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
        this.markProgress();
      }

      const toolDiscovery = new ToolDiscovery(
        () => this.programmingMode.isPlan() ? this.capabilities.getPlanTools() : this.capabilities.getTools(),
        this.config.toolDiscovery?.enabled === true,
      );

      const providerContextId = msg.sessionId ?? (typeof msg.metadata?.sessionId === 'string' ? msg.metadata.sessionId : msg.channelId);
      const channelOverride = this.channelProviderOverrides.get(providerContextId);
      const fallbackIterator = channelOverride
        ? [channelOverride.provider, ...this.providers.getFallbackIterator(channelOverride.providerName)]
          .filter((provider, index, list) => list.findIndex((item) => item.name === provider.name && item.getModel() === provider.getModel()) === index)
          [Symbol.iterator]()
        : this.providers.getFallbackIterator();
      let result: any = null;
      // Every model step this turn adds its own usage here (main loop,
      // continuations, guard, verification). Report THIS, never result.usage:
      // that is the SDK's last step only, and later rounds replace result.
      const turnUsage = new TurnUsage();
      let usedProvider: { name: string; model: string } | null = null;
      // The provider most recently called, even if that attempt never
      // completed (/stop, abort, error). Set before every model call (main
      // loop, guard, resume, verification): each step's usage is billed to
      // it, so steps from a provider that failed before a fallback stay
      // billed to that provider, and a stopped turn isn't filed as "unknown".
      let attemptedProvider: { name: string; model: string } | null = null;
      let usageRecorded: { turnTotals: TurnUsageTotals; usageEntries: SourceUsageTotals[]; billedProvider: { name: string; model: string } | null } | null = null;
      const recordTurnUsage = (lastResultUsage?: StepUsageLike) => {
        if (usageRecorded) return usageRecorded;
        // Who billed this turn: the provider that completed, else the last one
        // called (a stopped or failed attempt still billed its finished steps).
        const billedProvider = usedProvider ?? attemptedProvider;
        // Whole-turn usage: every step of every round. Fall back to the last
        // result only if no step reported (a path without step callbacks).
        const turnTotals = turnUsage.totals().steps > 0
          ? turnUsage.totals()
          : (() => {
            const fallback = new TurnUsage();
            fallback.add(lastResultUsage);
            return fallback.totals();
          })();
        // One budget entry per provider+model: a turn that fell back bills the
        // failed provider for its finished steps and the fallback for the rest.
        const usageEntries = billingEntries(
          turnTotals,
          turnUsage.totals().steps > 0 ? turnUsage.bySource() : [],
          billedProvider,
        );
        for (const entry of usageEntries) {
          this.tokenBudget.recordUsage({
            provider: entry.provider,
            model: entry.model,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.totalTokens,
            // The split lets tokens.cachedWeight discount cache hits in the budget.
            cachedInputTokens: entry.cachedInputTokens,
            noCacheInputTokens: entry.noCacheInputTokens,
            channelType: msg.channelType,
            agentId: this.config.cloud.agentId || undefined,
          });
        }
        usageRecorded = { turnTotals, usageEntries, billedProvider };
        return usageRecorded;
      };
      flushTurnUsage = () => { if (turnUsage.totals().steps > 0) recordTurnUsage(); };
      let lastError: any = null;
      let hasCompletedTool = false;
      let hasStreamedOutput = false;
      let cliResponseStreamed = false;
      let requiresContinuationApproval = false;
      let memoryPressureStop = false;
      // Why a research run is ending before its article ("you asked it to finish now").
      let researchCut: string | null = null;
      const loopDetector = new ToolCallLoopDetector();
      let loopWarningSent = false;
      let selfCheckCount = 0;
      // Execute-mode completion guard: every tool invoked this turn, so a
      // narration-only turn cannot be celebrated as "Task complete".
      // toolsSucceeded records whether each mutating tool produced at least
      // one non-error result — a failed write is not "work done".
      const executeTurnToolsUsed = new Set<string>();
      const executeToolSucceeded = new Map<string, boolean>();
      let executeGuardRounds = 0;
      // Completion-contract state: how did the FINAL round end, and what
      // evidence exists that the work actually finished?
      const executeCommandsRun: string[] = [];
      let lastVerificationNote = '';
      // Evidence tracking: the LAST verification command and whether it
      // actually passed, plus the step of the last successful mutation. A
      // verification only counts as evidence when it ran clean AND after the
      // last edit — a failing or timed-out `npm test`, or a test that ran
      // before five more files were written, is not "verified".
      let lastVerification: { command: string; ok: boolean; step: number } | null = null;
      let lastMutationStep = -1;
      const recordVerification = (command: string, resultText: string): void => {
        const ok = isVerificationOutputOk(resultText);
        lastVerification = { command, ok, step: this.completedStepCount };
        lastVerificationNote = `${command.slice(0, 60)} ${ok ? '✓' : '✗'}`;
      };
      const verifiedAfterLastMutation = (): boolean =>
        lastVerification != null && lastVerification.ok && lastVerification.step >= lastMutationStep;
      // Compact per-turn tool trace, written to the session at turn end so
      // the next turn's history carries what was read and written.
      const turnToolTrace: string[] = [];
      // The same steps as data: a turn that ends without text is answered
      // with what it did instead of "(no text response)".
      const turnActions: TurnAction[] = [];
      // Files this turn makes that are worth keeping (images, PDFs, reports…): artifacts of the conversation.
      const artifactCollector = new ArtifactCollector({
        startedAt: Date.now(),
        cwd: this.capabilities.getCwd(),
        surface: this.programmingMode.isActive() ? 'code' : 'chat',
        mercuryHome: getMercuryHome(),
      });
      // Research runs: every search and page read, shown live as it happens.
      const observeResearch = (tool: string, input: unknown, value: unknown): void => {
        if (!researchRun) return;
        try {
          researchRun.observe(tool, input, value);
          this.emitResearch(msg, researchRun);
        } catch { /* watching must never break a turn */ }
      };
      const noteToolSteps = (toolCalls: readonly any[] | undefined, toolResults: readonly any[] | undefined): void => {
        if (!toolCalls || !toolResults) return;
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          const raw = toolResultValue(resultFor(toolCalls, toolResults, i));
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
          turnToolTrace.push(formatToolTraceLine({
            tool: tc.toolName,
            args: summarizeToolArgs(tc.input),
            outcome: summarizeToolResult(raw, !isFailedToolResult(text)),
          }));
          turnActions.push({ tool: tc.toolName, input: tc.input, ok: !isFailedToolResult(text) });
        }
      };
      let lastStepHadToolCalls = false;
      let lastRoundSteps = 0;
      let stepBudgetContinuations = 0;
      let verificationContinuations = 0;
      // Second wind: when the first full set of guard rounds fails to start
      // the work, the agent does not pause — it wakes the task up with a
      // blunt, maximally-constrained retry cycle before reporting honestly.
      let narrationSecondWind = false;
      let lastGuardToolFailure = '';
      // OpenCode practice: on memory pressure, COMPACT and continue — the
      // task gets one aggressive compaction chance before any abort.
      let memoryCompactedForTask = false;

      const recordExecuteToolResult = (toolName: string, resultText: unknown): void => {
        const text = typeof resultText === 'string' ? resultText : JSON.stringify(resultText ?? '');
        const ok = !isFailedToolResult(text);
        executeToolSucceeded.set(toolName, (executeToolSucceeded.get(toolName) ?? false) || ok);
        if (ok && EXECUTE_MUTATING_TOOLS.has(toolName)) lastMutationStep = this.completedStepCount;
      };

      const canStream = msg.channelType === 'cli' || msg.channelType === 'web' || (msg.channelType === 'telegram' && this.telegramStreaming) || msg.channelType === 'signal' || (msg.channelType === 'discord' && this.config.channels.discord.streaming) || (msg.channelType === 'slack' && this.config.channels.slack.streaming);

      // One feedback contract for every channel (see core/task-surface.ts):
      // begin → steps → done-with-evidence | pause | fail. The per-channel
      // if/else chains that used to live here drifted apart; now channels
      // render and the agent decides.
      const surface = createTaskSurface(channel, msg.channelType, msg.channelId);
      surface.begin();

      // Research, plan first: propose the sub-questions, let the owner edit
      // them, and start (or not) on their word. Only screens that can show
      // an editable plan get this; elsewhere the run starts straight away.
      if (researchRun?.planFirst) {
        if (channel instanceof WebChannel) {
          const suffixBefore = this.researchMode.getSystemPromptSuffix();
          const go = await this.planResearch(msg, channel, researchRun);
          // The prompt was built before the plan existed: give the model the approved one.
          if (go && suffixBefore) systemPrompt = systemPrompt.replace(suffixBefore, this.researchMode.getSystemPromptSuffix());
          if (!go) {
            if (this.currentWorkKey) {
              this.workLedger.markCompleted(this.currentWorkKey, 'Research cancelled before it started.');
              this.workLedger.markDelivered(this.currentWorkKey);
            }
            await channel.send('Research cancelled. Nothing was searched.', msg.channelId).catch(() => {});
            this.lifecycle.transition('idle');
            return;
          }
        }
        researchRun.phase = 'searching';
        this.emitResearch(msg, researchRun);
      }

      /**
       * A research run that can't finish normally (a stop with "write the
       * report now", the step budget, every provider failing) still gives
       * the owner a report: written from the pages it read, with what it
       * couldn't cover. False when there's nothing to write from, or the
       * writing failed too; the caller's own ending then applies.
       */
      const deliverResearchReport = async (cut: string): Promise<boolean> => {
        if (!researchRun || !channel || msg.channelType === 'internal' || researchRun.readCount() === 0) return false;
        researchRun.phase = 'writing';
        this.emitResearch(msg, researchRun);
        this.markProgress('Writing the report from what was gathered...');
        const body = await this.writeResearchFromNotes(researchRun).catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Research: writing the report from notes failed');
          return null;
        });
        if (!body) return false;
        const unanswered = unansweredFrom(channel instanceof WebChannel ? channel.plans.get(msg.channelId)?.steps : undefined);
        researchRun.markCited(body);
        const coverage = coverageSection(researchRun, { cut, unanswered });
        const text = coverage ? `${body}\n\n${coverage}` : body;
        researchRun.end('partial', cut);
        const saved = canonicalSessionId ? this.saveResearchReport(researchRun, text, canonicalSessionId) : null;
        if (canonicalSessionId) {
          this.sessions.appendMessage(canonicalSessionId, {
            role: 'assistant',
            content: text,
            externalMessageId: `${msg.id}:assistant`,
            metadata: {
              channelType: msg.channelType, channelId: msg.channelId, traceId,
              elapsedMs: Date.now() - startTime, steps: this.completedStepCount,
              research: researchRun.snapshot(),
              ...(saved ? { artifacts: [artifactRef(saved)] } : {}),
            },
          });
        }
        if (saved) this.announceArtifacts(channel, [saved], msg.channelId);
        if (this.currentWorkKey) this.workLedger.markCompleted(this.currentWorkKey, text);
        const reportDone: DoneInput = {
          finalText: text,
          elapsedMs: Date.now() - startTime,
          stepCount: this.completedStepCount,
          meta: { provider: 'unknown', model: 'unknown', inputTokens: 0, outputTokens: 0, totalTokens: 0, budgetUsed: this.tokenBudget.getDailyUsed(), budgetTotal: this.tokenBudget.getBudget(), budgetPercentage: this.tokenBudget.getUsagePercentage() },
          traceId,
          alreadyStreamed: false,
        };
        await surface.done(reportDone);
        if (this.currentWorkKey) this.workLedger.markDelivered(this.currentWorkKey);
        this.lifecycle.transition('idle');
        return true;
      };

      // Saver-mode-aware request limits. When saver is off these resolve to
      // the original constants (byte-identical to pre-saver behavior).
      let effectiveMaxOutputTokens = this.saverMode.adjustMaxOutputTokens(MODEL_OUTPUT_TOKEN_LIMIT);
      const effectiveMaxSteps = this.saverMode.adjustMaxSteps(MAX_STEPS) * this.researchMode.getMaxStepsMultiplier();
      const saverWasActive = this.saverMode.isActive();

      const providersForAttempt = [...fallbackIterator];
      // Per-provider failure ledger: when EVERY provider fails, the final
      // error must show WHY each one failed (dead token, bad key, rate
      // limit) — showing only the last error hides the real fix from the
      // user.
      const providerFailures = new Map<string, string>();
      // Per-turn dedupe for the whitelabeled fallback notices — the same
      // provider failing repeatedly (guard rounds, retries) must not spam the
      // transcript with identical lines.
      const noticedProviderFailures = new Set<string>();
      // Guard-round provider rotation cursor (round 1 = current provider,
      // then walks the fallback chain — a narration-locked model is not the
      // only worker the agent has).
      let guardProviderCursor = 0;
      // One step handler for both model-call paths (streaming and
      // non-streaming): they were two ~295-line copies that differed only
      // in their memory-checkpoint label and drifted on every change. The
      // continuation rounds (resume / verification) share a lighter handler.
      const stepHandler = (path: 'stream' | 'gen') => async ({ toolCalls, toolResults, usage }: { toolCalls?: any[]; toolResults?: any[]; usage?: StepUsageLike }): Promise<void> => {
                this.completedStepCount++;
                turnUsage.add(usage, attemptedProvider);
                // Completion-contract tracking: per-round step usage and how
                // the step ended (tool calls pending = work in progress).
                lastRoundSteps++;
                lastStepHadToolCalls = !!(toolCalls && toolCalls.length > 0);
                this.cliFeed()?.bumpLiveActivitySteps();
                // Every tool step goes into the per-turn trace (session history
                // and /trace), not only the guard/continuation rounds.
                noteToolSteps(toolCalls, toolResults);
                // Step-level memory checkpoint: deterministic, runs even when
                // the event loop is saturated (unlike the wall-clock guard).
                const verdict = memoryGovernor(`${path}-step-${this.completedStepCount}`);
                if (verdict === 'exit') {
                  try {
                    const { writeCrashFlag } = await import('./crash-flag.js');
                    writeCrashFlag({ reason: 'Step governor: heap beyond exit threshold mid-step', timestamp: Date.now() });
                  } catch { /* best effort */ }
                  process.exit(0);
                }
                if (verdict === 'abort' && !loopAbortController.signal.aborted && this.currentAbortReason !== 'memory-pressure') {
                  // Compact FIRST, continue (OpenCode's compact-on-overflow
                  // practice): a long coding task must not die at memory
                  // pressure when old tool bulk can be summarized away.
                  if (!memoryCompactedForTask) {
                    memoryCompactedForTask = true;
                    try {
                      const freed = compactConversation(messages);
                      logger.warn({ freedChars: freed, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) }, 'Step governor: memory pressure — compacted conversation, continuing');
                      this.pushLiveActivity('Freeing memory — compacting the conversation', 'auto-compact');
                    } catch { /* compaction is best-effort */ }
                    return;
                  }
                  // Already compacted: give way only if this is the turn the
                  // governor picks (the newest); an older one keeps working.
                  if (!shouldYieldToMemory()) return;
                  this.currentAbortReason = 'memory-pressure';
                  loopAbortController.abort(new Error(`Task stopped at ${Math.round(process.memoryUsage().heapUsed / 1048576)}MB heap usage (step governor)`));
                  return;
                }
                if (toolCalls && toolCalls.length > 0) {
                  for (const tc of toolCalls as any[]) {
                    this.stepNarrative.push({ tool: tc.toolName, label: formatToolStep(tc.toolName, tc.input as Record<string, any> || {}) });
                  }
                  const labels = toolCalls.map((tc: any) => formatToolStep(tc.toolName, tc.input as Record<string, any> || {}));
                  this.markProgress(labels.join(' → '));
                  this.pushLiveActivity(labels[labels.length - 1]);
                } else {
                  this.markProgress('Thinking...');
                  this.pushLiveActivity('Thinking', 'model reasoning');
                }
                if (toolCalls && toolResults && toolCalls.length > 0) {
                  if (toolResults.length > 0) hasCompletedTool = true;
                  const names = toolCalls.map((tc: any) => tc.toolName).join(', ');
                  logger.info({ tools: names }, 'Tool call step');
                  for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    executeTurnToolsUsed.add(tc.toolName);
                    if (tc.toolName === 'run_command') {
                      const cmd = (tc.input as any)?.command;
                      if (typeof cmd === 'string') {
                      executeCommandsRun.push(cmd);
                      if (VERIFICATION_COMMAND_PATTERN.test(cmd)) {
                        const vResult = toolResultValue(resultFor(toolCalls, toolResults, i));
                        const vText = typeof vResult === 'string' ? vResult : JSON.stringify(vResult ?? '');
                        recordVerification(cmd, vText);
                      }
                    }
                    }
                    const trValue = toolResultValue(resultFor(toolCalls, toolResults, i));
                    recordExecuteToolResult(tc.toolName, trValue);
                    this.maybeShowFileChange(channel, msg, tc.toolName, tc.input, trValue);
                    this.maybeRecordPlanProgress(channel, tc.toolName, tc.input, msg.channelId);
                    artifactCollector.observe(tc.toolName, tc.input, trValue, this.capabilities.getCwd());
                    observeResearch(tc.toolName, tc.input, trValue);
                    const resultStr = typeof trValue === 'string' ? trValue : JSON.stringify(trValue ?? '');
                    const failed = resultStr.length < 5000 && (
                      resultStr.startsWith('Error:') ||
                      resultStr.startsWith('⚠') ||
                      resultStr.includes('exited with code') ||
                      resultStr.includes('Command failed') ||
                      resultStr.startsWith('Command exited with code')
                    );
                    loopDetector.record(tc.toolName, tc.input as Record<string, any>, failed);
                  }
                  if (loopDetector.detectAbsoluteLimit()) {
                    logger.warn('Absolute tool call limit reached — aborting');
                    if (channel && msg.channelType !== 'internal') {
                      await channel.send('⚠ Tool call limit reached (25 calls). Stopping to prevent runaway loop.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  if (toolCalls.some((tc: any) => tc.toolName === 'use_skill')) {
                    loopDetector.reset();
                  }
                  const hardLoop = loopDetector.detectIdentical();
                  if (hardLoop) {
                    logger.warn({ tool: hardLoop.tool, count: hardLoop.count }, 'Hard loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`☿ **Mercury Autopilot** · Identical call loop — ${hardLoop.tool} called ${hardLoop.count}x with same params. Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const similarLoop = loopDetector.detectSimilarLoop();
                  if (similarLoop) {
                    logger.warn({ tool: similarLoop.tool, count: similarLoop.count }, 'Failing loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`☿ **Mercury Autopilot** · Failing loop — ${similarLoop.tool} called ${similarLoop.count}x, all failing. Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  // ── Mercury Autopilot: intelligent repetition analysis ──
                  const analysis = loopDetector.analyzeRepetition();
                  if (analysis && !loopWarningSent && channel && msg.channelType !== 'internal') {
                    if (analysis.verdict === 'productive') {
                      // Productive iteration — diverse params, high success rate
                      // Let it run, just log for transparency
                      logger.info({
                        tool: analysis.tool,
                        count: analysis.count,
                        diversity: analysis.paramDiversity.toFixed(2),
                        successRate: analysis.successRate.toFixed(2),
                      }, 'Mercury Autopilot: productive iteration detected — continuing');
                    } else if (analysis.verdict === 'suspicious') {
                      // Suspicious but not definitively stuck — observe further
                      if (this.capabilities.permissions.isAutoApproveAll()) {
                        selfCheckCount++;
                        if (selfCheckCount >= MAX_SELF_CHECKS) {
                          // Escalate: ask AI for final verdict
                          const recentCalls = loopDetector.getRecentCallSummaries();
                          const shouldContinue = await this.aiSelfCheck({
                            toolName: analysis.tool,
                            callCount: analysis.count,
                            recentCalls,
                            taskDescription: msg.content.slice(0, 300),
                          });
                          if (!shouldContinue) {
                            logger.warn({ tool: analysis.tool, count: analysis.count }, 'Mercury Autopilot: AI verdict — unproductive, aborting');
                            await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} repeated ${analysis.count}x with low progress (${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                            loopAbortController.abort();
                            return;
                          }
                        }
                        // Not yet at check limit — let it continue with a note
                        loopDetector.reset();
                        loopWarningSent = false;
                        await this.sendProgressNote(channel, `☿ **Mercury Autopilot** · Observing ${analysis.tool} (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity). Continuing under monitoring.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      } else {
                        loopWarningSent = true;
                        const shouldContinue = await channel.askToContinue(
                          `☿ Mercury Autopilot: ${analysis.tool} called ${analysis.count}x (${Math.round(analysis.paramDiversity * 100)}% param diversity, ${Math.round(analysis.successRate * 100)}% success rate). Continue?`,
                          msg.channelId,
                        ).catch(() => false);
                        if (shouldContinue) {
                          loopDetector.reset();
                          loopWarningSent = false;
                        } else {
                          loopAbortController.abort();
                        }
                      }
                    } else {
                      // verdict === 'stuck'
                      if (this.capabilities.permissions.isAutoApproveAll()) {
                        logger.warn({ tool: analysis.tool, count: analysis.count, diversity: analysis.paramDiversity, successRate: analysis.successRate }, 'Mercury Autopilot: stuck loop detected');
                        await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} is stuck (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                        loopAbortController.abort();
                        return;
                      } else {
                        loopWarningSent = true;
                        const shouldContinue = await channel.askToContinue(
                          `☿ Mercury Autopilot: ${analysis.tool} appears stuck (${analysis.count} calls, ${Math.round(analysis.successRate * 100)}% success). Continue anyway?`,
                          msg.channelId,
                        ).catch(() => false);
                        if (shouldContinue) {
                          loopDetector.reset();
                          loopWarningSent = false;
                        } else {
                          loopAbortController.abort();
                        }
                      }
                    }
                  }
                  if (channel && msg.channelType !== 'internal') {
                    if (channel instanceof CLIChannel) {
                      for (const tc of toolCalls) {
                        void (channel as CLIChannel).sendToolFeedback(tc.toolName, tc.input as Record<string, any>).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = resultFor(toolCalls, toolResults, i) as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            (channel as CLIChannel).sendStepDone(tcName, toolResultValue(tr));
                          }
                        }
                      }
                    } else if (channel instanceof TelegramChannel) {
                      const tgCh = channel as TelegramChannel;
                      for (const tc of toolCalls) {
                        void tgCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = resultFor(toolCalls, toolResults, i) as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            void tgCh.sendStepDone(tcName, toolResultValue(tr), msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else if (channel instanceof SignalChannel) {
                      const sigCh = channel as SignalChannel;
                      for (const tc of toolCalls) {
                        void sigCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = resultFor(toolCalls, toolResults, i) as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            void sigCh.sendStepDone(tcName, toolResultValue(tr), msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else if (channel instanceof WebChannel) {
                      // Sent live, as each tool starts and ends (pushLiveToolEvent).
                    } else if (channel instanceof DiscordChannel) {
                      const dcCh = channel as DiscordChannel;
                      for (const tc of toolCalls) {
                        void dcCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = resultFor(toolCalls, toolResults, i) as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            void dcCh.sendStepDone(tcName, toolResultValue(tr), msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else if (channel instanceof SlackChannel) {
                      const slCh = channel as SlackChannel;
                      for (const tc of toolCalls) {
                        void slCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId);
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = resultFor(toolCalls, toolResults, i) as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            void Promise.resolve(slCh.sendStepDone(tcName, toolResultValue(tr), msg.channelId)).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else {
                      if ((channel as { quietProgress?: boolean }).quietProgress) void channel.typing(msg.channelId).catch(() => {});
                      else void channel.send(`  [Using: ${names}]`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    this.markProgress();
                  }
                } else if (toolResults === undefined || (toolCalls === undefined)) {
                  const stepText_step = (toolResults as any)?.text ?? '';
                  if (stepText_step) {
                    loopDetector.recordStepText(String(stepText_step));
                  }
                  const noActionLoop = loopDetector.recordNoActionResult();
                  if (noActionLoop) {
                    logger.warn('Reasoning loop detected — model keeps thinking without acting, aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await this.sendProgressNote(channel, '⚠ I\'m stuck in a reasoning loop (thinking without taking action). Stopping.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const textRepeat = loopDetector.detectTextRepetition();
                  if (textRepeat) {
                    logger.warn({ pattern: textRepeat.pattern, count: textRepeat.count }, 'Text repetition loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send('⚠ I keep generating the same response. Stopping to prevent repetition.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                  }
                }
              };
      const continuationStepHandler = async (toolCalls: any[] | undefined, toolResults: any[] | undefined, usage?: StepUsageLike): Promise<void> => {
              this.completedStepCount++;
              turnUsage.add(usage, attemptedProvider);
              lastRoundSteps++;
              lastStepHadToolCalls = !!(toolCalls && toolCalls.length > 0);
              this.cliFeed()?.bumpLiveActivitySteps();
              if (toolCalls && toolResults && toolCalls.length > 0) {
                hasCompletedTool = true;
                noteToolSteps(toolCalls, toolResults);
                for (let i = 0; i < toolCalls.length; i++) {
                  const tc = toolCalls[i];
                  executeTurnToolsUsed.add(tc.toolName);
                  if (tc.toolName === 'run_command') {
                    const cmd = (tc.input as any)?.command;
                    if (typeof cmd === 'string') {
                      executeCommandsRun.push(cmd);
                      if (VERIFICATION_COMMAND_PATTERN.test(cmd)) {
                        const vResult = toolResultValue(resultFor(toolCalls, toolResults, i));
                        const vText = typeof vResult === 'string' ? vResult : JSON.stringify(vResult ?? '');
                        recordVerification(cmd, vText);
                      }
                    }
                  }
                  recordExecuteToolResult(tc.toolName, toolResultValue(resultFor(toolCalls, toolResults, i)));
                  this.maybeShowFileChange(channel, msg, tc.toolName, tc.input, toolResultValue(resultFor(toolCalls, toolResults, i)));
                  this.maybeRecordPlanProgress(channel, tc.toolName, tc.input, msg.channelId);
                  artifactCollector.observe(tc.toolName, tc.input, toolResultValue(resultFor(toolCalls, toolResults, i)), this.capabilities.getCwd());
                  observeResearch(tc.toolName, tc.input, toolResultValue(resultFor(toolCalls, toolResults, i)));
                  loopDetector.record(tc.toolName, tc.input as Record<string, any>, false);
                }
              }
            };

      const providerChain = [...providersForAttempt, ...providersForAttempt];
      for (const provider of providerChain) {
        // Per-attempt latency accounting: the only way to answer "why is
        // coding slow" with data instead of guesses.
        const attemptStartedAt = Date.now();
        let firstResponse: { received(): void; clear(): void } | null = null;
        attemptedProvider = { name: provider.name, model: provider.getModel() };
        try {
          const providerDeadlineAt = Date.now() + MAX_PROVIDER_ATTEMPT_MS;
          this.markProgress(`Calling ${provider.name}...`);
          this.pushLiveActivity(`Calling ${provider.name}`, provider.getModel());
          if (this.cliFeed()) updateCliProviderStatus(this.channels.get('cli'), provider.name, provider.getModel());
          const deepseekProviderOptions = provider instanceof DeepSeekProvider && provider.isReasoner
            ? { deepseek: { thinking: { type: 'enabled' as const } } }
            : undefined;
          // DeepSeek thinking models require prior reasoning_content to be
          // passed back with assistant turns (issue #24); other providers
          // get plain text.
          // Photos and PDFs from the chat go to models that can take them.
          const seesImages = modelSeesImages(provider.name, provider.getModel(), provider.seesImages);
          // How screenshots reach this model, and at what size (ADR-043): inside
          // tool results, as an image message after them, or not at all.
          const vision = visionProfile({ model: provider.getModel(), seesImages, toolResultImages: provider.supportsToolResultImages() });
          setToolVision(vision);
          logger.debug({ provider: provider.name, model: provider.getModel(), route: vision.route, box: vision.box }, 'Screenshot route for this model');
          const providerMessages = withAttachments(
            deepseekProviderOptions ? withReasoningParts(messages) : messages,
            msg,
            provider.name,
            provider.getModel(),
            provider.seesImages,
          );
          // Per-provider output ceiling: a 32K request is rejected outright by
          // providers with smaller limits and burned a halve-and-retry round.
          const providerMaxOutputTokens = Math.min(effectiveMaxOutputTokens, provider.getMaxOutputTokens() ?? Infinity);

          logger.info({ provider: provider.name, model: provider.getModel(), steps: MAX_STEPS, stream: canStream }, 'Generating agentic response');

          // Ensure Mercury Cloud token is fresh before getting model instance
          if ('ensureFreshToken' in provider && typeof (provider as any).ensureFreshToken === 'function') {
            await this.withProviderDeadline((provider as any).ensureFreshToken(), loopAbortController, providerDeadlineAt);
          }

          if (canStream && channel) {
            let streamError: unknown;
            let streamAborted = false;
            // A provider that accepts the request and then sends nothing (rate
            // limited upstream, overloaded, a dead connection) used to hold the
            // turn at "Starting" until the stall watchdog — minutes. Nothing
            // within the first-response window → this attempt is stalled and
            // the next provider in the chain takes over (ADR-039).
            firstResponse = this.armFirstResponseTimer(provider.name, loopAbortController);
            const streamResult = streamText({
              model: provider.getModelInstance(),
              // Mercury builds this system message itself (trusted, not user input);
              // opting in stops the SDK printing a warning on every call.
              allowSystemInMessages: true,
              messages: this.withCachedSystem(systemPrompt, providerMessages, volatileSystem),
              ...toolDiscovery.request(activeTools),
              maxOutputTokens: providerMaxOutputTokens,
              stopWhen: stepCountIs(effectiveMaxSteps),
              abortSignal: loopAbortController.signal,
              // Memory: the SDK retains a structuredClone of the whole
              // conversation (plus raw HTTP bodies) in every step of its
              // `steps` array. With 75 steps × file-size tool outputs that
              // is O(N²) heap growth → V8 OOM on long coding tasks. We never
              // read the raw bodies, so exclude them. (SDK default: true.)
              experimental_include: { requestBody: false },
              onError: ({ error }) => {
                streamError = error;
              },
              onAbort: () => {
                streamAborted = true;
              },
              onChunk: () => firstResponse?.received(),
              // Real-time feedback: these fire at TOOL EXECUTION time, not
              // step completion — the TUI live block shows what is actually
              // running during long tool calls instead of nothing.
              experimental_onToolCallStart: ({ toolCall }) => {
                const tc = toolCall as any;
                const label = formatToolStep(tc.toolName, tc.input as Record<string, any> || {});
                this.markProgress(label);
                this.pushLiveToolEvent(tc.toolCallId ?? `${tc.toolName}:${Date.now()}`, tc.toolName, tc.input as Record<string, any> || {}, 'running');
              },
              experimental_onToolCallFinish: ({ toolCall, success, output, error, durationMs }) => {
                const tc = toolCall as any;
                this.pushLiveToolEvent(
                  tc.toolCallId ?? `${tc.toolName}:${Date.now()}`,
                  tc.toolName,
                  success ? output : error,
                  success ? 'done' : 'error',
                  durationMs,
                );
              },
              ...(deepseekProviderOptions ? { providerOptions: deepseekProviderOptions } : {}),
              onStepFinish: stepHandler('stream'),
            });

            const cliChThinking = channel instanceof CLIChannel ? channel : null;
            // Clients that show the thought process live (Mercury Desktop) get the reasoning text.
            const reasoningSink = this.reasoningSink(channel, msg.channelId);
            const trackedStream = this.withProgressStream((async function* () {
              for await (const chunk of (stepAwareTextStream(streamResult.fullStream, reasoningSink))) {
                if (chunk) hasStreamedOutput = true;
                cliChThinking?.showThinkingPreview(null);
                yield chunk;
              }
            })());
            const streamedText = await this.withProviderDeadline(
              channel.stream(trackedStream, msg.channelId),
              loopAbortController,
              providerDeadlineAt,
            );
            cliResponseStreamed = channel instanceof CLIChannel;
            firstResponse.clear();

            // Surface the REAL provider error BEFORE awaiting the result
            // promises: a stream that errored (401, invalid key) records zero
            // steps, and the SDK's flush then rejects usage/finishReason with
            // a generic "No output generated" — which would mask the actual
            // auth failure.
            if (streamError) throw streamError;
            if (streamAborted) {
              throw new Error('Model stream was aborted before completion');
            }

            const [usage, finishReason, streamReasoning] = await this.withProviderDeadline(
              Promise.all([
                streamResult.usage,
                streamResult.finishReason,
                streamResult.reasoning,
              ]),
              loopAbortController,
              providerDeadlineAt,
            );
            // Stream integrity: 'other'/missing finish means the provider
            // dropped the connection mid-generation (no terminal chunk was
            // emitted). Treating it as success produced silent cut-offs with
            // "Task complete" banners. Throw so fallback/retry engages.
            const completion = classifyStreamCompletion({
              finishReason,
              hasText: streamedText.length > 0,
            });
            if (completion === 'interrupted') {
              logger.error({ provider: provider.name, finishReason, streamedChars: streamedText.length }, 'Stream ended without a provider finish signal — treating as interrupted');
              throw new Error(`${provider.name} stream was interrupted before completion (no finish signal from provider)`);
            }
            const truncated = isLengthTruncation(finishReason);
            const fullText = truncated
              ? `${streamedText}\n\n[Response truncated: the model reached its output limit. Ask me to continue from this point.]`
              : streamedText;

            result = { text: fullText, usage, reasoning: streamReasoning, finishReason };
            loopDetector.recordStepText(fullText);

            // Auto-continuation: a length-truncated response in code mode
            // means the implementation stopped mid-way. Nudge the model to
            // resume (bounded attempts), instead of dead-stopping at
            // "Ask me to continue".
            if (truncated && this.programmingMode.isExecute() && !loopAbortController.signal.aborted) {
              let continuationRound = 0;
              const MAX_STREAM_CONTINUATIONS = 6;
              let continuationText = streamedText;
              let stillTruncated = true;
              while (stillTruncated && continuationRound < MAX_STREAM_CONTINUATIONS && !loopAbortController.signal.aborted) {
                continuationRound++;
                this.markProgress('Writing the next section...');
                this.pushLiveActivity('Finishing the write — continuing past the size limit', 'auto-resume');
                const continueResult: Awaited<ReturnType<typeof streamText>> = await this.withProviderDeadline(
                  Promise.resolve(streamText({
                    model: provider.getModelInstance(),
                    // Mercury builds this system message itself (trusted, not user input);
                    // opting in stops the SDK printing a warning on every call.
                    allowSystemInMessages: true,
                    messages: this.withCachedSystem(systemPrompt, [
                      ...providerMessages,
                      { role: 'assistant', content: continuationText },
                      { role: 'user', content: lastStepHadToolCalls
                        ? toolTruncationContinuationPrompt(msg.content)
                        : truncationContinuationPrompt(msg.content) },
                    ], volatileSystem),
                    ...toolDiscovery.request(),
                    maxOutputTokens: effectiveMaxOutputTokens,
                    // FULL budget: a one-step round can only read files — the
                    // model could never reach the write, which is exactly the
                    // 'drops in the middle' loop.
                    stopWhen: stepCountIs(effectiveMaxSteps),
                    abortSignal: loopAbortController.signal,
                    experimental_include: { requestBody: false },
                    // Billed like any other step: count it in the turn total.
                    onStepFinish: ({ usage }) => { turnUsage.add(usage, attemptedProvider); },
                  })),
                  loopAbortController,
                  providerDeadlineAt,
                );
                const chunk: string[] = [];
                for await (const c of stepAwareTextStream(continueResult.fullStream, this.reasoningSink(channel, msg.channelId))) chunk.push(c);
                const piece = chunk.join('');
                const cFinish: string = await continueResult.finishReason;
                if (cFinish === 'error') throw new Error('Continuation stream ended with an error');
                const cCompletion = classifyStreamCompletion({ finishReason: cFinish, hasText: piece.length > 0 });
                if (cCompletion === 'interrupted') {
                  logger.error({ provider: provider.name, finishReason: cFinish }, 'Continuation stream interrupted');
                  break;
                }
                continuationText += piece;
                result = {
                  text: continuationText + (cCompletion === 'truncated' ? '\n\n[Response truncated: the model reached its output limit. Ask me to continue from this point.]' : ''),
                  usage: await continueResult.usage,
                  reasoning: streamReasoning,
                };
                stillTruncated = cCompletion === 'truncated';
                if (channel instanceof CLIChannel) {
                  await channel.stream((async function* () { yield piece; })(), msg.channelId).catch((e) => logger.warn({ e }, 'continuation stream delivery failed'));
                }
                loopDetector.recordStepText(piece);
              }
              if (stillTruncated && channel && msg.channelType !== 'internal') {
                await channel.send('⚠ Response reached the output limit again — ask me to continue for the remainder.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
              }
            }
          } else {
            result = await this.withProviderDeadline(generateText({
              model: provider.getModelInstance(),
              // Mercury builds this system message itself (trusted, not user input);
              // opting in stops the SDK printing a warning on every call.
              allowSystemInMessages: true,
              messages: this.withCachedSystem(systemPrompt, providerMessages, volatileSystem),
              ...toolDiscovery.request(activeTools),
              maxOutputTokens: providerMaxOutputTokens,
              stopWhen: stepCountIs(effectiveMaxSteps),
              abortSignal: loopAbortController.signal,
              // Same O(N²) step retention as streamText (see comment above).
              experimental_include: { requestBody: false, responseBody: false },
              ...(deepseekProviderOptions ? { providerOptions: deepseekProviderOptions } : {}),
              experimental_onToolCallStart: ({ toolCall }) => {
                const tc = toolCall as any;
                const label = formatToolStep(tc.toolName, tc.input as Record<string, any> || {});
                this.markProgress(label);
                this.pushLiveToolEvent(tc.toolCallId ?? `${tc.toolName}:${Date.now()}`, tc.toolName, tc.input as Record<string, any> || {}, 'running');
              },
              experimental_onToolCallFinish: ({ toolCall, success, output, error, durationMs }) => {
                const tc = toolCall as any;
                this.pushLiveToolEvent(
                  tc.toolCallId ?? `${tc.toolName}:${Date.now()}`,
                  tc.toolName,
                  success ? output : error,
                  success ? 'done' : 'error',
                  durationMs,
                );
              },
              onStepFinish: stepHandler('gen'),
            }), loopAbortController, providerDeadlineAt);
            if (result.finishReason === 'error') throw new Error('Model generation ended with an error');
            if (result.finishReason === 'length') {
              result = { ...result, text: `${result.text}\n\n[Response truncated: the model reached its output limit. Ask me to continue from this point.]` };
            }
            if (channel instanceof CLIChannel) {
              await channel.send(result.text, msg.channelId, Date.now() - startTime);
              cliResponseStreamed = true;
            }
          }

          usedProvider = { name: provider.name, model: provider.getModel() };
          logger.info({ provider: provider.name, durationMs: Date.now() - attemptStartedAt, steps: this.completedStepCount }, 'Provider attempt succeeded');
          if (channel instanceof WebChannel) {
            (channel as WebChannel).sendProviderInfo(usedProvider.name, usedProvider.model, msg.channelId);
          }
          if (!channelOverride) {
            this.providers.markSuccess(provider.name);
            // Respect the configured default: when a fallback provider served
            // the turn instead of it, SAY SO. The fallback used to be silent —
            // combined with markSuccess stickiness the user's doctor choice
            // was invisibly overridden for the rest of the session. One
            // notice per (default → served) pair per runtime keeps it visible
            // without spamming every turn.
            if (provider.name !== this.config.providers.default && msg.channelType !== 'internal') {
              const noticeKey = `${this.config.providers.default}→${provider.name}`;
              if (this.lastFallbackNoticeKey !== noticeKey) {
                this.lastFallbackNoticeKey = noticeKey;
                const failureReason = providerFailures.get(this.config.providers.default)
                  ?? 'not registered — run `mercury doctor`';
                await channel?.send(
                  `⚠ Configured default \`${this.config.providers.default}\` unavailable (${failureReason}) — served by \`${provider.name}\` this time.`,
                  msg.channelId,
                ).catch((e) => logger.warn({ e }, 'channel send failed'));
              }
            }
          }
          break;
        } catch (err: any) {
          firstResponse?.clear();
          if (this.currentAbortReason === 'memory-pressure') {
            lastError = loopAbortController.signal.reason instanceof Error
              ? loopAbortController.signal.reason
              : new Error('Task stopped by the memory safety limit');
            requiresContinuationApproval = true;
            this.currentAbortReason = null;
            logger.error({ provider: provider.name, err: lastError }, 'Provider attempt stopped before heap exhaustion');
            // Memory pressure is not a retryable failure: re-running the same
            // request would grow the heap again and repeat the OOM. Stop the
            // whole fallback loop and surface a paused state instead.
            memoryPressureStop = true;
            break;
          }
          if (this.currentAbortReason === 'time-limit') {
            lastError = new Error(`${provider.name} exceeded the 10-minute provider-attempt limit`);
            requiresContinuationApproval = true;
            this.currentAbortReason = null;
            logger.warn({ provider: provider.name }, 'Provider attempt reached hard deadline; waiting for user decision');
            break;
          }
          if (this.currentAbortReason === 'stalled' && !hasCompletedTool) {
            lastError = new Error(`${provider.name} stalled without progress`);
            this.currentAbortReason = null;
            loopAbortController = new AbortController();
            this.currentAbort = loopAbortController;
            this.markProgress(`Retrying after ${provider.name} stalled...`);
            this.pushLiveActivity('Retrying after stall', provider.name);
            logger.warn({ provider: provider.name }, 'Provider stalled; retrying with another healthy attempt');
            continue;
          }
          if (this.currentAbortReason === 'backgrounded') {
            researchRun?.end('stopped', 'it was moved to the background');
            result = { text: stopNoteFor('backgrounded'), usage: undefined };
            break;
          }
          if (this.currentAbortReason === 'stopped' && researchRun?.finishRequested && researchRun.readCount() > 0) {
            // "Write the report now": stop searching, keep what was read.
            this.currentAbortReason = null;
            researchCut = 'you asked it to finish now';
            break;
          }
          if (this.currentAbortReason === 'stopped' || this.currentAbortReason === 'halted') {
            researchRun?.end('stopped', 'you stopped it');
            result = { text: stopNoteFor(this.currentAbortReason), usage: undefined };
            this.currentAbortReason = null;
            break;
          }
          if (loopDetector.isHardAborted() || loopAbortController.signal.aborted) {
            lastError = new Error(hasCompletedTool
              ? 'Generation was interrupted after one or more tools completed. Current side effects may be partial; inspect state before retrying.'
              : 'Generation was aborted by progress or loop safety controls.');
            logger.info({ hasCompletedTool }, 'Generation aborted; recording an explicit failed state');
            break;
          }
          lastError = err;
          // Some providers reject a maxOutputTokens above their model's
          // native limit. Halve and let the next attempt in the chain use
          // the smaller cap — the task continues instead of dying on a
          // configuration argument.
          const limitErr = `${err?.message || ''} ${typeof (err as any)?.responseBody === 'string' ? (err as any).responseBody : ''}`;
          if (/max[_ -]?tokens|output.?limit|too large|exceed/i.test(limitErr) && effectiveMaxOutputTokens > 4096) {
            effectiveMaxOutputTokens = Math.max(4096, Math.floor(effectiveMaxOutputTokens / 2));
            logger.warn({ provider: provider.name, newCap: effectiveMaxOutputTokens }, 'Provider rejected the output cap — clamping for subsequent attempts');
          }
          if (!providerFailures.has(provider.name)) {
            providerFailures.set(provider.name, (err?.message || String(err)).slice(0, 140));
          }
          logger.warn({ provider: provider.name, durationMs: Date.now() - attemptStartedAt }, 'Provider attempt failed');
          if (hasStreamedOutput) {
            // Partial visible output: silently combining two different
            // provider responses would be worse than failing loudly. Report
            // the cut-off honestly instead of emitting "Task complete".
            lastError = new Error(`Provider stream was interrupted after partial output. Original error: ${err?.message || String(err)}`);
            logger.error({ provider: provider.name, err }, 'Provider stream interrupted after visible output; fallback suppressed');
            break;
          }
          if (hasCompletedTool) {
            lastError = new Error(`Provider failed after a tool completed; refusing fallback to avoid duplicate side effects. Original error: ${err?.message || String(err)}`);
            logger.error({ provider: provider.name, err }, 'Provider interrupted after tool completion; fallback suppressed');
            break;
          }
          logger.warn({ provider: provider.name, err: err.message }, 'Provider failed, trying fallback');
          // Whitelabeled, durable notice: the user sees WHICH provider failed,
          // WHY (one respectful line, no stack), and WHERE the task continues —
          // rendered in Mercury Code too (heartbeat rows are filtered there).
          // Same provider failing twice in one turn does not repeat the line.
          const failureKey = `${provider.name}:${(err?.message || String(err)).slice(0, 80)}`;
          if (!noticedProviderFailures.has(failureKey)) {
            noticedProviderFailures.add(failureKey);
            const nextName = providerChain[providerChain.indexOf(provider) + 1]?.name;
            const line = nextName
              ? `⚠ ${provider.name}: ${whitelabelProviderError(err)} — switching to \`${nextName}\` and continuing.`
              : `⚠ ${provider.name}: ${whitelabelProviderError(err)} — no fallback left; retrying the chain.`;
            await this.sendFallbackNotice(msg, line).catch((e) => logger.warn({ e }, 'channel send failed'));
          }
        }
      }

      // Stopped by the owner however the attempt ended (mid-tool, between
      // steps, in a fallback): the answer is the stop note — never a retry,
      // a continuation or a failure report (ADR-038).
      const ownerStop = this.turn()?.cancelled ?? null;
      if (!result && ownerStop) {
        researchRun?.end('stopped', ownerStop === 'backgrounded' ? 'it was moved to the background' : 'you stopped it');
        result = { text: stopNoteFor(ownerStop), usage: undefined };
      }

      if (!result && researchRun && !memoryPressureStop) {
        const cut = researchCut ?? (lastError ? `of an error (${whitelabelProviderError(lastError)})` : 'it was interrupted');
        if (await deliverResearchReport(cut)) return;
        researchRun.end('failed', cut);
      }

      if (!result) {
        const failureBlock = providerFailures.size > 0
          ? `\nPer-provider:\n- ${[...providerFailures.entries()].slice(0, 8).map(([name, reason]) => `${name}: ${reason}`).join('\n- ')}`
          : '';
        let errMsg = hasCompletedTool
          ? `Work stopped in an interrupted/ambiguous state to avoid repeating completed tool side effects. ${lastError?.message || ''}`.trim()
          : `All LLM providers failed. Last error: ${lastError?.message || 'unknown'}${failureBlock}`;
        if (memoryPressureStop) {
          errMsg = `Task stopped before the heap limit: ${lastError?.message || 'memory safety limit'}`;
          logger.error({ err: lastError }, errMsg);
          if (this.currentWorkKey) this.workLedger.markFailed(this.currentWorkKey, errMsg, errMsg);
          if (channel && msg.channelType !== 'internal') {
            await channel.send(
              `⚠ I stopped this task early — memory was growing toward the process limit (likely a very large analysis). `
              + `Nothing was lost: completed tool work is checkpointed. Try narrowing the request to specific files/directories, or split it into smaller steps.`,
              msg.channelId,
            ).catch((e) => logger.warn({ e }, 'channel send failed'));
          }
          this.lifecycle.transition('idle');
          return;
        }
        logger.error({ err: lastError }, errMsg);
        if (this.currentWorkKey && !msg.metadata?.scheduledTaskId && (hasCompletedTool || hasStreamedOutput || requiresContinuationApproval)) {
          const continuationAttempt = typeof msg.metadata?.continuationAttempt === 'number' ? msg.metadata.continuationAttempt : 0;
          const needsApproval = needsContinuationApproval(continuationAttempt, requiresContinuationApproval);
          if (needsApproval) {
            this.markProgress('Waiting for your decision...');
            this.pushLiveActivity('Waiting for your decision', 'continuation requires approval');
            const reason = `Mercury has already made ${continuationAttempt} automatic continuation attempts without completing the task (the runaway backstop).`;
            const shouldContinue = channel && msg.channelType !== 'internal'
              ? await channel.askToContinue(
                `${reason} Existing files and completed tool work have been preserved. Continue with another inspected attempt?`,
                msg.channelId,
              ).catch(() => false)
              : false;
            if (!shouldContinue) {
              errMsg = `${reason} Work is paused with existing artifacts preserved. Send "continue" when you want Mercury to inspect the current state and resume.`;
            } else {
              const delayMs = this.scheduleDurableRetry(msg, this.currentWorkKey, lastError || errMsg, true);
              await this.sendProgressNotice(
                msg,
                `Progress remains checkpointed. Mercury will inspect the existing artifacts and continue in ${Math.round(delayMs / 1000)} seconds.`,
              ).catch((error) => logger.warn({ error }, 'Unable to send continuation notice'));
              this.lifecycle.transition('idle');
              return;
            }
          } else {
            const delayMs = this.scheduleDurableRetry(msg, this.currentWorkKey, lastError || errMsg, true);
            await this.sendProgressNotice(
              msg,
              `Progress was checkpointed. Mercury will inspect the existing artifacts and continue with a different approach in ${Math.round(delayMs / 1000)} seconds.`,
            ).catch((error) => logger.warn({ error }, 'Unable to send continuation notice'));
            this.lifecycle.transition('idle');
            return;
          }
        }
        if (this.currentWorkKey && !msg.metadata?.scheduledTaskId && !hasCompletedTool && !hasStreamedOutput && this.isRetryableProviderError(lastError)) {
          const attempts = this.workLedger.get(this.currentWorkKey)?.attempts ?? 1;
          const shouldContinue = !needsRetryApproval(attempts) || (
            channel && msg.channelType !== 'internal'
              ? await channel.askToContinue(
                `All providers have failed ${attempts} attempts. No tool side effects were recorded. Retry again?`,
                msg.channelId,
              ).catch(() => false)
              : false
          );
          if (shouldContinue) {
            const delayMs = this.scheduleDurableRetry(msg, this.currentWorkKey, lastError);
            await this.sendProgressNotice(
              msg,
              `All providers are temporarily unavailable. This request is safely queued and will retry in ${Math.round(delayMs / 1000)} seconds.`,
            ).catch((error) => logger.warn({ error }, 'Unable to send durable retry notice'));
            this.lifecycle.transition('idle');
            return;
          }
          errMsg = `All providers failed ${attempts} attempts. Work is paused. Send "continue" when you want Mercury to try again.`;
        }
        if (this.currentWorkKey) this.workLedger.markFailed(this.currentWorkKey, errMsg, errMsg);
        if (channel && msg.channelType !== 'internal') {
          // Failure is a persistent message with the reason (TaskSurface.fail
          // ends the task first so it is never a status-card notice).
          const delivered = await surface.fail(`${errMsg}\n\n_/trace ${traceId}_`);
          const awaitsCloudAck = msg.channelType === 'web'
            && typeof msg.metadata?.externalConversationId === 'string'
            && typeof msg.metadata?.requestId === 'string';
          if (this.currentWorkKey && delivered && !awaitsCloudAck) this.workLedger.markDelivered(this.currentWorkKey);
          if (this.currentWorkKey && !delivered) this.workLedger.markDeliveryError(this.currentWorkKey, 'Terminal error delivery was not accepted');
        }
        this.lifecycle.transition('idle');
        return;
      }

      const preGuardText = (result.text || '').trim() || '(no text response)';
      this.markProgress('Finalizing response...');
      this.pushLiveActivity('Finalizing response');

      // ── Delivery completion guard ──
      // In Mercury Code execute mode, a narration-only turn ("Building X per
      // its spec. Reading it first.") with zero mutating tool calls must NOT
      // be celebrated as "Task complete".
      //
      // Execute mode ONLY. This guard used to run in plain chat as well, and
      // IMPLEMENTATION_PATTERN is broad enough ("make", "add", "test",
      // "continue", "do it") that ordinary requests — "make me a workout
      // plan", "add that to my list" — were forced through up to ten
      // tool-only rounds and then paused with "I couldn't get started on
      // this one yet". In chat the model may use tools when it wants to;
      // it is never forced to.
      while (
        !loopAbortController.signal.aborted
        && this.programmingMode.isExecute()
        && !this.capabilities.areToolsDisabled()
        && executeGuardRounds < (narrationSecondWind ? MAX_EXECUTE_CONTINUATIONS * 2 : MAX_EXECUTE_CONTINUATIONS)
        // A turn that ends by asking the user something in plain text is a
        // legitimate pause — forcing rounds here looped the model forever
        // (it re-searched and re-asked instead of waiting for the answer).
        && !responseAsksUser(result.text || '')
        && shouldForceExecuteContinuation({
          taskText: msg.content,
          hasApprovedPlan: this.programmingMode.getLastPlan() != null,
          toolsUsed: executeTurnToolsUsed,
          toolsSucceeded: executeToolSucceeded,
        })
      ) {
        executeGuardRounds++;
        logger.warn(
          { rounds: executeGuardRounds, toolsUsed: [...executeTurnToolsUsed], task: msg.content.slice(0, 120) },
          'Execute-mode guard: turn ended without any mutating tool call — forcing continuation',
        );
        this.markProgress('Work not started — continuing...');
        this.pushLiveActivity('Resuming — no file changes yet', 'execute guard');
        // Deduplicate consecutive guard warnings: back-to-back narration
        // rounds stacked identical banners in the transcript (visual noise
        // during exactly the moments the user is watching for action).
        const cliChGuard = this.channels.get('cli');
        const lastGuardMsg = cliChGuard instanceof CLIChannel
          ? cliChGuard.getTuiState().chatMessages[cliChGuard.getTuiState().chatMessages.length - 1]
          : undefined;
        const isDuplicateWarning = lastGuardMsg?.role === 'agent'
          && lastGuardMsg.content.startsWith('Getting started on the real build now');
        if (channel && msg.channelType !== 'internal' && !isDuplicateWarning) {
          await this.sendProgressNote(channel, 
            `Alright — getting started on the real build now (attempt ${executeGuardRounds} of ${MAX_EXECUTE_CONTINUATIONS})...`,
            msg.channelId,
          ).catch((e) => logger.warn({ e }, 'channel send failed'));
        }
        // Inject the narration + the guard nudge into the conversation, then
        // run one more inline generation round with the full tool loop. This
        // keeps work-ledger/session state intact and the live activity block
        // alive instead of tearing the task down and re-queueing it.
        const currentText = (result.text || '').trim();
        if (currentText && currentText !== '(no text response)') messages.push({ role: 'assistant', content: currentText });
        // Harness-level grounding on the FIRST forced round: the agent
        // executes a deterministic directory listing itself (no LLM), so a
        // narration-prone model cannot claim it lacks context for where the
        // work goes.
        if (executeGuardRounds === 1) {
          try {
            const cwd = this.capabilities.getCwd();
            const entries = readdirSync(cwd, { withFileTypes: true })
              .slice(0, 30)
              .map((e: import('node:fs').Dirent) => `${e.isDirectory() ? 'dir' : 'file'}: ${e.name}`)
              .join('\n');
            messages.push({
              role: 'user',
              content: `[SYSTEM: GROUNDING — agent-executed, not model-generated] Current working directory: ${cwd}\nContents:\n${entries || '(empty)'}\nThis is real, current state. Use it: create/edit files HERE with your tools.`,
            });
          } catch { /* grounding is best-effort */ }
        }
        messages.push({ role: 'user', content: executeContinuationPrompt(msg.content) });
        // Provider rotation across guard rounds: a model that repeatedly
        // narrates without acting should not keep being handed the task —
        // the agent moves to the next model in the chain. The agent makes
        // things happen; it does not depend on one LLM's cooperation.
        if (guardProviderCursor === undefined) guardProviderCursor = 0;
        const guardProvider = providersForAttempt[guardProviderCursor % providersForAttempt.length];
        guardProviderCursor++;
        if (!guardProvider) break;
        attemptedProvider = { name: guardProvider.name, model: guardProvider.getModel() };
        try {
          this.markProgress(`Resuming with ${guardProvider.name}...`);
          const guardDeadlineAt = Date.now() + MAX_PROVIDER_ATTEMPT_MS;
          const guardStream = streamText({
            model: guardProvider.getModelInstance(),
            // Mercury builds this system message itself (trusted, not user input);
            // opting in stops the SDK printing a warning on every call.
            allowSystemInMessages: true,
            messages: this.withCachedSystem(systemPrompt, messages, volatileSystem),
            ...toolDiscovery.request(undefined, { forceFirstTool: true, firstStepTools: FORCED_ACTION_TOOLS }),
            maxOutputTokens: effectiveMaxOutputTokens,
            stopWhen: stepCountIs(effectiveMaxSteps),
            // Mechanical enforcement, not a polite nudge: the first step of
            // this round MUST contain a tool call. Text nudges alone let
            // narration-only models loop for every round; a provider-enforced
            // toolChoice converts "describing the work" into doing it.
            experimental_onToolCallStart: ({ toolCall }) => {
              const tc = toolCall as any;
              this.markProgress(formatToolStep(tc.toolName, tc.input as Record<string, any> || {}));
              this.pushLiveToolEvent(tc.toolCallId ?? `${tc.toolName}:${Date.now()}`, tc.toolName, tc.input as Record<string, any> || {}, 'running');
            },
            experimental_onToolCallFinish: ({ toolCall, success, output, error, durationMs }) => {
              const tc = toolCall as any;
              this.pushLiveToolEvent(
                tc.toolCallId ?? `${tc.toolName}:${Date.now()}`,
                tc.toolName,
                success ? output : error,
                success ? 'done' : 'error',
                durationMs,
              );
            },
            abortSignal: loopAbortController.signal,
            experimental_include: { requestBody: false },
            onStepFinish: async ({ toolCalls, toolResults, usage }) => {
              this.completedStepCount++;
              turnUsage.add(usage, attemptedProvider);
              // Completion-contract tracking for the guard round.
              lastRoundSteps++;
              lastStepHadToolCalls = !!(toolCalls && toolCalls.length > 0);
              this.cliFeed()?.bumpLiveActivitySteps();
              if (toolCalls && toolResults && toolCalls.length > 0) {
                hasCompletedTool = true;
                noteToolSteps(toolCalls, toolResults);
                for (let i = 0; i < toolCalls.length; i++) {
                  const tc = toolCalls[i];
                  executeTurnToolsUsed.add(tc.toolName);
                  const guardToolResult = toolResultValue(resultFor(toolCalls, toolResults, i));
                  recordExecuteToolResult(tc.toolName, guardToolResult);
                  // Remember WHY the work did not land, so an honest pause
                  // can tell the user what actually blocked it.
                  const guardResultText = typeof guardToolResult === 'string' ? guardToolResult : JSON.stringify(guardToolResult ?? '');
                  if (EXECUTE_MUTATING_TOOLS.has(tc.toolName) && isFailedToolResult(guardResultText || '')) {
                    lastGuardToolFailure = `${tc.toolName}: ${guardResultText.slice(0, 120)}`;
                  }
                  this.maybeShowFileChange(channel, msg, tc.toolName, tc.input, guardToolResult);
                  this.maybeRecordPlanProgress(channel, tc.toolName, tc.input, msg.channelId);
                  artifactCollector.observe(tc.toolName, tc.input, guardToolResult, this.capabilities.getCwd());
                  observeResearch(tc.toolName, tc.input, guardToolResult);
                  loopDetector.record(tc.toolName, tc.input as Record<string, any>, false);
                }
              }
            },
          });
          const guardText = channel
            ? await this.withProviderDeadline(
              channel.stream(stepAwareTextStream(guardStream.fullStream, this.reasoningSink(channel, msg.channelId)), msg.channelId),
              loopAbortController,
              guardDeadlineAt,
            )
            : '';
          const gFinish = await this.withProviderDeadline(
            guardStream.finishReason,
            loopAbortController,
            guardDeadlineAt,
          );
          if (gFinish === 'error') throw new Error('Guard continuation stream ended with an error');
          const gCompletion = classifyStreamCompletion({ finishReason: gFinish, hasText: guardText.length > 0 });
          if (gCompletion === 'interrupted') {
            throw new Error('Guard continuation stream was interrupted (no finish signal from provider)');
          }
          if (guardText.trim()) result = { text: guardText, usage: await guardStream.usage, reasoning: guardStream.reasoning, finishReason: await guardStream.finishReason };
          cliResponseStreamed = channel instanceof CLIChannel;
        } catch (guardErr: any) {
          // The guard nudge is best-effort: never let it turn a delivered
          // narration into a hard failure. Log and fall through with the
          // original result so the user still gets a response.
          logger.warn({ err: guardErr?.message || String(guardErr) }, 'Execute-mode guard continuation failed; keeping original response');
          break;
        }
        // WAKE-UP CALL: the first full guard cycle failed to start the work.
        // The agent does not give up — it resets the cycle with a blunt,
        // maximally-constrained directive before reporting honestly.
        if (
          executeGuardRounds >= MAX_EXECUTE_CONTINUATIONS
          && !narrationSecondWind
          && !loopAbortController.signal.aborted
          && shouldForceExecuteContinuation({
            taskText: msg.content,
            hasApprovedPlan: this.programmingMode.getLastPlan() != null,
            toolsUsed: executeTurnToolsUsed,
            toolsSucceeded: executeToolSucceeded,
          })
        ) {
          narrationSecondWind = true;
          logger.warn({ rounds: executeGuardRounds }, 'Narration guard: first cycle exhausted — issuing wake-up call');
          this.pushLiveActivity('Trying a different approach', 'wake-up call');
          if (channel && msg.channelType !== 'internal') {
            await channel.send('Taking a completely different run at this — forcing the first move...', msg.channelId)
              .catch((e) => logger.warn({ e }, 'channel send failed'));
          }
          messages.push({ role: 'user', content: wakeUpPrompt(msg.content) });
          // Fresh grounding for the second cycle too.
          try {
            const cwd = this.capabilities.getCwd();
            const entries2 = readdirSync(cwd, { withFileTypes: true })
              .slice(0, 30)
              .map((e: import('node:fs').Dirent) => `${e.isDirectory() ? 'dir' : 'file'}: ${e.name}`)
              .join('\n');
            messages.push({ role: 'user', content: `[SYSTEM: GROUNDING] Directory ${cwd}: ${entries2 || '(empty)'}. Your next response MUST begin with a create_file, write_file, edit_file, or run_command tool call.` });
          } catch { /* best effort */ }
        }
      }

      // ── Completion contract ──
      // A turn that ends because the step budget ran out mid-tool-work is a
      // PAUSE, not a completion. Bounded auto-continuation resumes it with a
      // fresh budget; past the bound the user is asked — the task is never
      // wrapped in a "Task complete" banner while work remains.
      const turnEnd = (): LoopEndCause => classifyTurnEnd({
        stepsUsed: lastRoundSteps,
        maxSteps: effectiveMaxSteps,
        lastStepHasToolCalls: lastStepHadToolCalls,
        finishReason: (result as any)?.finishReason,
        aborted: loopAbortController.signal.aborted,
      });

      while (
        !loopAbortController.signal.aborted
        && stepBudgetContinuations < MAX_AUTOMATIC_CONTINUATIONS
        && turnEnd() === 'steps-exhausted'
      ) {
        stepBudgetContinuations++;
        logger.warn(
          { rounds: stepBudgetContinuations, steps: lastRoundSteps, budget: effectiveMaxSteps },
          'Step budget exhausted mid-task — forcing continuation with a fresh budget',
        );
        this.markProgress('Step budget reached — continuing...');
        this.pushLiveActivity('Resuming with a fresh step budget', 'step budget');
        if (channel && msg.channelType !== 'internal') {
          await this.sendProgressNote(channel, 
            `This one's a bigger build than a single pass — picking up right where I left off...`,
            msg.channelId,
          ).catch((e) => logger.warn({ e }, 'channel send failed'));
        }
        const resumeText = (result.text || '').trim();
        if (resumeText && resumeText !== '(no text response)') messages.push({ role: 'assistant', content: resumeText });
        messages.push({ role: 'user', content: stepsExhaustedPrompt(msg.content) });
        const resumeProvider = usedProvider
          ? (providersForAttempt.find((p) => p.name === usedProvider!.name && p.getModel() === usedProvider!.model) ?? providersForAttempt[0])
          : providersForAttempt[0];
        if (!resumeProvider) break;
        attemptedProvider = { name: resumeProvider.name, model: resumeProvider.getModel() };
        lastRoundSteps = 0;
        try {
          const round = await this.runInlineContinuationRound({
            messages,
            systemPrompt,
            volatileSystem,
            provider: resumeProvider,
            maxOutputTokens: effectiveMaxOutputTokens,
            maxSteps: effectiveMaxSteps,
            abortController: loopAbortController,
            channel,
            channelId: msg.channelId,
            toolDiscovery,
            onStep: continuationStepHandler,
          });
          if (round.text.trim()) result = { text: round.text, usage: round.usage, reasoning: round.reasoning, finishReason: round.finishReason };
          cliResponseStreamed = channel instanceof CLIChannel;
        } catch (resumeErr: any) {
          logger.warn({ err: resumeErr?.message || String(resumeErr) }, 'Step-budget continuation failed; falling through to honest pause');
          break;
        }
      }

      // ── Verification gate ──
      // Implementation work happened, but nothing objectively verified it
      // (no build/test/typecheck ran clean after the last edit). Force one
      // bounded evidence round. Execute mode only: in plain chat "write my
      // notes to notes.md" must not trigger "running the build/tests now".
      if (
        !loopAbortController.signal.aborted
        && turnEnd() === 'text-stop'
        && this.programmingMode.isExecute()
        && !this.capabilities.areToolsDisabled()
        && verificationContinuations < MAX_VERIFICATION_CONTINUATIONS
        && shouldRequireVerification({
          taskText: msg.content,
          hasApprovedPlan: this.programmingMode.getLastPlan() != null,
          commandsRun: executeCommandsRun,
          toolsSucceeded: executeToolSucceeded,
          verifiedOk: verifiedAfterLastMutation(),
        })
      ) {
        verificationContinuations++;
        logger.warn(
          { commandsRun: executeCommandsRun.slice(-5) },
          'Verification gate: changes landed but nothing verified them — forcing verification round',
        );
        this.markProgress('Verifying changes...');
        this.pushLiveActivity('Verifying the work', 'verification gate');
        if (channel && msg.channelType !== 'internal') {
          await this.sendProgressNote(channel, 
            'Checking my work before I call it done — running the build/tests now...',
            msg.channelId,
          ).catch((e) => logger.warn({ e }, 'channel send failed'));
        }
        const verifyText = (result.text || '').trim();
        if (verifyText && verifyText !== '(no text response)') messages.push({ role: 'assistant', content: verifyText });
        messages.push({ role: 'user', content: verificationPrompt(msg.content) });
        const verifyProvider = usedProvider
          ? (providersForAttempt.find((p) => p.name === usedProvider!.name && p.getModel() === usedProvider!.model) ?? providersForAttempt[0])
          : providersForAttempt[0];
        if (verifyProvider) {
          attemptedProvider = { name: verifyProvider.name, model: verifyProvider.getModel() };
          lastRoundSteps = 0;
          try {
            const round = await this.runInlineContinuationRound({
              messages,
              systemPrompt,
              volatileSystem,
              provider: verifyProvider,
              maxOutputTokens: effectiveMaxOutputTokens,
              maxSteps: effectiveMaxSteps,
              abortController: loopAbortController,
              channel,
              channelId: msg.channelId,
              // Verification must produce evidence, not prose about evidence.
              forceFirstTool: true,
              toolDiscovery,
              onStep: continuationStepHandler,
            });
            if (round.text.trim()) result = { text: round.text, usage: round.usage, reasoning: round.reasoning, finishReason: round.finishReason };
            cliResponseStreamed = channel instanceof CLIChannel;
          } catch (verifyErr: any) {
            logger.warn({ err: verifyErr?.message || String(verifyErr) }, 'Verification continuation failed; keeping original response');
          }
        }
      }

      // ── Final verdict: a step-budget stop past the continuation bound is
      // an honest pause, never a completion banner. ──
      const pauseHonestly = async (banner: string, reason: string): Promise<void> => {
        logger.warn({ banner, task: msg.content.slice(0, 120) }, 'Completion contract: pausing task honestly');
        this.markProgress('Task paused');
        this.pushLiveActivity('Paused', 'completion contract');
        if (this.currentWorkKey) {
          this.workLedger.markPaused(this.currentWorkKey, reason);
        }
        if (channel && msg.channelType !== 'internal') {
          // Persistent banner, deferred text flushed first (see TaskSurface.pause).
          await surface.pause(`${banner}\n\n_/trace ${traceId}_`);
          if (this.currentWorkKey) this.workLedger.markDelivered(this.currentWorkKey);
        }
        this.lifecycle.transition('idle');
      };

      if (!loopAbortController.signal.aborted && turnEnd() === 'steps-exhausted') {
        logger.warn({ steps: lastRoundSteps, budget: effectiveMaxSteps }, 'Step budget exhausted past continuation bound — pausing task honestly');
        if (await deliverResearchReport(`it used its whole step budget (${effectiveMaxSteps} steps)`)) return;
        researchRun?.end('failed', `it used its whole step budget (${effectiveMaxSteps} steps)`);
        await pauseHonestly(
          STEPS_PAUSED_BANNER,
          'Step budget reached with work pending. Send "continue" to resume with a fresh budget.',
        );
        return;
      }

      // Narration-guard exhaustion: after all forced continuation rounds the
      // turn STILL contains zero mutating work (rounds failed on flaky
      // providers, or the model kept narrating). That must never read as
      // "Task complete" — pause and let "continue" re-engage.
      if (
        !loopAbortController.signal.aborted
        && this.programmingMode.isExecute()
        && !this.capabilities.areToolsDisabled()
        && !responseAsksUser(result.text || '')
        && shouldForceExecuteContinuation({
          taskText: msg.content,
          hasApprovedPlan: this.programmingMode.getLastPlan() != null,
          toolsUsed: executeTurnToolsUsed,
          toolsSucceeded: executeToolSucceeded,
        })
      ) {
        logger.warn({ task: msg.content.slice(0, 120), blocker: lastGuardToolFailure }, 'Narration guard exhausted (both cycles) — pausing instead of completing');
        const blockerNote = lastGuardToolFailure
          ? `\n\nWhat blocked it: ${lastGuardToolFailure}`
          : '';
        await pauseHonestly(
          WORK_NOT_STARTED_BANNER + blockerNote,
          `No implementation work was performed across two guard cycles.${lastGuardToolFailure ? ` Last blocker: ${lastGuardToolFailure}` : ''} Send "continue" to resume with tools.`,
        );
        return;
      }

      // Verification failed or is stale: in execute mode, a build/test/
      // typecheck ran but did not pass, or passed and was then followed by
      // more edits. Either way there is no evidence the work is correct —
      // that is an honest pause, never a "Task complete" banner.
      if (
        !loopAbortController.signal.aborted
        && this.programmingMode.isExecute()
        && !this.capabilities.areToolsDisabled()
        && lastVerification != null
        && !verifiedAfterLastMutation()
        && !responseAsksUser(result.text || '')
      ) {
        const stale = lastVerification.ok;
        logger.warn({ verification: lastVerificationNote, stale }, 'Completion contract: verification failed or stale — pausing instead of completing');
        await pauseHonestly(
          `${VERIFICATION_FAILED_BANNER}\n\nLast check: ${lastVerificationNote}${stale ? ' (ran before the latest changes)' : ''}`,
          `Verification ${stale ? 'is stale' : 'failed'}: ${lastVerificationNote}. Send "continue" to resume.`,
        );
        return;
      }

      // Recompute AFTER the guard: the continuation's output (not the
      // original narration) must be what reaches the session store, the
      // work ledger, and the final delivery.
      // Stopped during a continuation or verification round: deliver the
      // stop note, never the earlier answer dressed up as complete.
      {
        const stoppedAs = this.turn()?.cancelled ?? null;
        if (stoppedAs && (result.text || '').trim() !== stopNoteFor(stoppedAs)) {
          if (researchRun?.outcome === 'running') researchRun.end('stopped', stoppedAs === 'backgrounded' ? 'it was moved to the background' : 'you stopped it');
          result = { ...result, text: stopNoteFor(stoppedAs) };
        }
      }
      // No text from the model (it ended on tool calls): say what was done.
      const modelWroteText = (result.text || '').trim().length > 0;
      let finalText = modelWroteText ? (result.text || '').trim() : summarizeSilentTurn(turnActions);
      let researchReportText: string | null = null;

      // A research run: an empty answer still gets a report from what was
      // read; a finished one says what it couldn't read and is kept as a file.
      if (researchRun && researchRun.outcome === 'running') {
        if (!(result.text || '').trim()) {
          if (await deliverResearchReport('the model returned no text')) return;
          researchRun.end('failed', 'the model returned no text');
        } else {
          researchReportText = reportBody(finalText, researchRun.writtenArticle);
          researchRun.markCited(researchReportText);
          const coverage = coverageSection(researchRun);
          if (coverage) {
            finalText = `${finalText}\n\n${coverage}`;
            researchReportText = `${researchReportText}\n\n${coverage}`;
          }
          researchRun.end('done');
        }
      }

      // Store plan output when in plan mode for later execution
      if (this.programmingMode.isPlan() && preGuardText !== '(no text response)') {
        this.programmingMode.storePlan(preGuardText);
        logger.info({ planLength: preGuardText.length }, 'Plan captured from plan-mode response');
      }

      // Who billed this turn: the provider that completed, else the last one
      // called (a stopped or failed attempt still billed its finished steps).
      const { turnTotals, usageEntries, billedProvider } = recordTurnUsage(result.usage);
      logger.info({
        provider: billedProvider?.name,
        model: billedProvider?.model,
        inputTokens: turnTotals.inputTokens,
        cachedInputTokens: turnTotals.cachedInputTokens,
        noCacheInputTokens: turnTotals.noCacheInputTokens,
        outputTokens: turnTotals.outputTokens,
        reasoningTokens: turnTotals.reasoningTokens,
        steps: this.completedStepCount,
        usageSteps: turnTotals.steps,
        ...(usageEntries.length > 1 ? { usageByProvider: usageEntries.map((e) => ({ provider: e.provider, model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens })) } : {}),
        toolCalls: turnToolTrace.length,
        historyEntries: recentMemory.length,
        activeTools: activeTools?.length ?? 'all',
        elapsedMs: Date.now() - startTime,
      }, 'Turn usage');
      this.syncTokenInfoToCli();

      // Estimate tokens saved by Saver Mode (cap headroom + history trim).
      // Rough: (default_cap - actual_output) when capped, plus history-window delta.
      if (saverWasActive) {
        const actualOutput = turnTotals.outputTokens;
        const outputHeadroom = Math.max(0, MODEL_OUTPUT_TOKEN_LIMIT - effectiveMaxOutputTokens);
        const outputSaved = Math.max(0, Math.min(outputHeadroom, MODEL_OUTPUT_TOKEN_LIMIT - actualOutput));
        // Rough proxy: each trimmed history message ~120 tokens average.
        const historyTrimMessages = Math.max(0, NORMAL_HISTORY_WINDOW - this.saverMode.adjustHistoryWindow(NORMAL_HISTORY_WINDOW));
        const historySaved = historyTrimMessages * 120;
        const estimated = outputSaved + historySaved;
        if (estimated > 0) {
          this.tokenBudget.recordSavings(estimated);
          this.syncSaverToCli();
        }
      }

      // Keep this turn's artifacts with the conversation (Mercury's copies, deleted with the thread).
      let turnArtifacts: Artifact[] = [];
      if (canonicalSessionId && artifactCollector.size > 0) {
        try { turnArtifacts = artifactCollector.finalize(canonicalSessionId, artifactStore()); } catch (err) { logger.warn({ err }, 'Keeping artifacts failed'); }
      }
      if (researchRun?.outcome === 'done' && canonicalSessionId) {
        const saved = this.saveResearchReport(researchRun, researchReportText ?? finalText, canonicalSessionId);
        if (saved) turnArtifacts = [saved, ...turnArtifacts.filter((a) => a.id !== saved.id)];
      }
      if (canonicalSessionId) {
        if (turnToolTrace.length > 0) {
          this.sessions.appendMessage(canonicalSessionId, {
            role: 'assistant',
            kind: TOOL_TRACE_KIND,
            content: formatToolTrace(turnToolTrace),
            externalMessageId: `${msg.id}:tools`,
            metadata: { channelType: msg.channelType, channelId: msg.channelId, toolCalls: turnToolTrace.length },
          });
        }
        this.sessions.appendMessage(canonicalSessionId, {
          role: 'assistant',
          content: finalText,
          externalMessageId: `${msg.id}:assistant`,
          tokenCount: turnTotals.totalTokens,
          reasoning: typeof result.reasoning === 'string'
            ? result.reasoning
            : result.reasoning
              ? JSON.stringify(result.reasoning)
              : undefined,
          metadata: {
            channelType: msg.channelType,
            channelId: msg.channelId,
            ...(typeof msg.metadata?.requestId === 'string' ? { requestId: msg.metadata.requestId } : {}),
            ...(billedProvider ? { provider: billedProvider.name, model: billedProvider.model } : {}),
            // The thought process as shown live, for the reopened chat.
            ...(() => { const t = this.turn(); const trace = t?.trace.snapshot(t.startedAt); return trace ? { trace } : {}; })(),
            // Per-turn trace, shown by /trace <id>.
            traceId,
            elapsedMs: Date.now() - startTime,
            steps: this.completedStepCount,
            inputTokens: turnTotals.inputTokens,
            cachedInputTokens: turnTotals.cachedInputTokens,
            noCacheInputTokens: turnTotals.noCacheInputTokens,
            outputTokens: turnTotals.outputTokens,
            ...(lastVerificationNote ? { verification: lastVerificationNote } : {}),
            ...(turnArtifacts.length ? { artifacts: turnArtifacts.map(artifactRef) } : {}),
            ...(researchRun ? { research: researchRun.snapshot() } : {}),
          },
        });
        if (turnArtifacts.length && channel) this.announceArtifacts(channel, turnArtifacts, msg.channelId);
        if (msg.channelType !== 'internal' && msg.senderId !== 'system' && usedProvider) {
          this.scheduleSessionTitleGeneration(canonicalSessionId, usedProvider.name);
        }
      } else {
        this.shortTerm.add(msg.channelId, { id: msg.id, timestamp: msg.timestamp, role: 'user', content: msg.content });
        this.shortTerm.add(msg.channelId, {
          id: Date.now().toString(36), timestamp: Date.now(), role: 'assistant', content: finalText,
          tokenCount: turnTotals.totalTokens, reasoning: result.reasoning || undefined,
        });
      }

      this.episodic.record({
        type: 'message',
        summary: `User: ${msg.content.slice(0, 100)} | Agent: ${finalText.slice(0, 100)}`,
        channelType: msg.channelType,
      });

      // The learning loop runs fire-and-forget; a "☿ Noted" line, when one is
      // due, waits for the reply to be delivered first so it never lands ahead of it.
      let replyDelivered: () => void = () => {};
      const delivered = new Promise<void>((resolve) => { replyDelivered = resolve; });
      if (msg.channelType !== 'internal' && msg.metadata?.channelAccess !== 'general') {
        // What the turn read, taken now: the learning pass runs after the turn's scope (ADR-044).
        this.extractMemory(msg.content, finalText, { msg, channel, sessionId: canonicalSessionId, toolTrace: turnToolTrace, delivered, exposure: exposure() }).catch(err => {
          logger.warn({ err }, 'Memory extraction failed');
        });
        this.scheduleStatusVerbRefresh(channel, msg.content);
      }

      if (this.currentWorkKey) this.workLedger.markCompleted(this.currentWorkKey, finalText);

      if (channel && msg.channelType !== 'internal') {
        const elapsed = Date.now() - startTime;
        const stepCount = this.completedStepCount;
        const completionMeta = {
          provider: billedProvider?.name ?? 'unknown',
          model: billedProvider?.model ?? 'unknown',
          inputTokens: turnTotals.inputTokens,
          outputTokens: turnTotals.outputTokens,
          totalTokens: turnTotals.totalTokens,
          cachedInputTokens: turnTotals.cachedInputTokens,
          budgetUsed: this.tokenBudget.getDailyUsed(),
          budgetTotal: this.tokenBudget.getBudget(),
          budgetPercentage: this.tokenBudget.getUsagePercentage(),
        };
        const isMercuryCodeExecution = channel instanceof CLIChannel
          && channel.getTuiState().mode === 'mercury-code'
          && (channel.getTuiState().programmingMode === 'execute' || channel.getTuiState().programmingMode === 'auto');
        logger.info({ channelType: msg.channelType, targetId: msg.channelId, surface: surface.kind, traceId }, 'Delivering final response');
        await surface.done({
          finalText,
          elapsedMs: elapsed,
          stepCount,
          meta: completionMeta,
          verificationNote: lastVerificationNote || undefined,
          traceId,
          // Nothing was streamed when the model wrote no text: the summary
          // of what was done must be sent, or the screen shows nothing.
          alreadyStreamed: modelWroteText && !this.turnCancelled() && !requiresFinalSend(msg.channelType, cliResponseStreamed),
          forceBanner: isMercuryCodeExecution,
        });
        replyDelivered();
        // Progress, without the typing refresh: a "thinking" event after the
        // reply would make a screen think a new turn started.
        this.lastProgressAt = Date.now();
        // A chat-app reply can follow as a voice note (ADR-042 phase 2).
        if (channel) void this.maybeVoiceReply(channel, msg, finalText);
      } else {
        replyDelivered();
        logger.debug('Internal prompt processed, no channel response needed');
      }


      const awaitsCloudAck = msg.channelType === 'web'
        && typeof msg.metadata?.externalConversationId === 'string'
        && typeof msg.metadata?.requestId === 'string';
      if (this.currentWorkKey && !awaitsCloudAck) this.workLedger.markDelivered(this.currentWorkKey);

      this.lifecycle.transition('idle');
    } catch (err) {
      logger.error({ err }, 'Error handling message');
      const ledgerEntry = this.currentWorkKey ? this.workLedger.get(this.currentWorkKey) : undefined;
      if (this.currentWorkKey) {
        if (ledgerEntry?.status === 'completed') this.workLedger.markDeliveryError(this.currentWorkKey, err);
        else if (ledgerEntry?.status !== 'failed') {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.workLedger.markFailed(
            this.currentWorkKey,
            err,
            `I encountered an unexpected error and couldn't finish: ${errMsg.slice(0, 200)}`,
          );
        }
      }
      if (ledgerEntry?.status === 'completed') {
        logger.warn({ err, workKey: this.currentWorkKey }, 'Final response persisted but delivery did not complete; retaining for replay');
        return;
      }
      // Always notify the user — they should never have to re-prompt
      // to find out their task died.
      const catchChannel = this.channels.getChannelForMessage(msg);
      if (catchChannel && msg.channelType !== 'internal') {
        const errMsg = err instanceof Error ? err.message : String(err);
        try {
          const finalError = `I encountered an unexpected error and couldn't finish: ${errMsg.slice(0, 200)}`;
          const delivered = catchChannel instanceof WebChannel ? catchChannel.sendError(finalError, msg.channelId) : true;
          if (!(catchChannel instanceof WebChannel)) await catchChannel.send(finalError, msg.channelId);
          const awaitsCloudAck = msg.channelType === 'web'
            && typeof msg.metadata?.externalConversationId === 'string'
            && typeof msg.metadata?.requestId === 'string';
          if (this.currentWorkKey && delivered && !awaitsCloudAck) this.workLedger.markDelivered(this.currentWorkKey);
          if (this.currentWorkKey && !delivered) this.workLedger.markDeliveryError(this.currentWorkKey, 'Terminal error delivery was not accepted');
        } catch (sendErr) {
          if (this.currentWorkKey) this.workLedger.markDeliveryError(this.currentWorkKey, sendErr);
          logger.warn({ sendErr }, 'Failed to notify user of handler error');
        }
      }
      // Write crash flag so next startup also reports the failure.
      try {
        const { writeCrashFlag } = await import('./crash-flag.js');
        writeCrashFlag({
          reason: `Unhandled agent error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
          timestamp: Date.now(),
          activeTask: this.currentActivity || undefined,
          channelId: msg.channelId || undefined,
          channelType: msg.channelType || undefined,
        });
      } catch { /* best effort */ }
      this.lifecycle.transition('idle');
    } finally {
      releaseSession?.();
      try { flushTurnUsage?.(); } catch (err) { logger.warn({ err }, 'Recording turn token usage failed'); }
      if (chatFolder) {
        if (cwdBeforeChatFolder && this.capabilities.getCwd() === chatFolder) this.capabilities.setCwd(cwdBeforeChatFolder);
        this.chatFolders().close(chatFolder);
      }
      if (researchRun) {
        researchRun.end('failed', 'it ended before writing a report');
        // Close the checklist the run worked through (models rarely tick the last step).
        const planChannel = this.channels.getChannelForMessage(msg);
        if (researchRun.planned && planChannel instanceof WebChannel) {
          const closed = closePlan(planChannel.plans.get(msg.channelId)?.steps ?? [], researchRun.outcome);
          if (closed) planChannel.sendPlan(closed, msg.channelId);
        }
        this.emitResearch(msg, researchRun);
        this.researchMode.endRun(msg.channelId);
      }
      stallWatchdog.stop();
      stopHeartbeat();
      this.finalizeChannelTask(msg);
      this.capabilities.setToolsDisabled(false);
      this.capabilities.permissions.setTurnPluginGrants([]);
      this.currentAbort = null;
      this.currentAbortReason = null;
      this.currentActivity = '';
      this.completedStepCount = 0;
      this.stepNarrative = [];
      this.cliFeed()?.clearLiveActivity();
      if (isInternal) {
        this.capabilities.permissions.endTurnGrant();
      }
      this.capabilities.permissions.clearElevation();
    }
  }

  /**
   * Prompt caching: the system prompt is the large, stable prefix of every
   * model call (identity, skills, bot roster, guidelines; with ~50 tool
   * schemas it is roughly 10K tokens) and it is re-sent on every one of up
   * to 75 steps. Sending it as a system *message* carrying an Anthropic
   * cache_control marker lets Anthropic serve it from cache across steps
   * and turns; providers that do not know the option ignore it, and the
   * AI SDK treats a leading system message exactly like `system:`.
   */
  private withCachedSystem(systemPrompt: string, messages: unknown[], volatileSystem = ''): any[] {
    return [
      {
        role: 'system',
        content: systemPrompt,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      // Per-turn context lives in its own block AFTER the cache marker so it
      // never invalidates the stable prefix.
      ...(volatileSystem ? [{ role: 'system', content: volatileSystem }] : []),
      ...messages,
    ];
  }

  /** The whole system prompt; assembly lives in core/system-prompt.ts. */
  private buildSystemPrompt(): string {
    return assembleSystemPrompt(this.systemPromptInputs());
  }

  /** Stable (cached) and per-turn parts of the system prompt (ADR-039). */
  private buildSystemPromptParts(): { stable: string; dynamic: string } {
    return buildSystemPromptParts(this.systemPromptInputs());
  }

  private systemPromptInputs(): SystemPromptInputs {
    const summary = this.userMemory ? this.userMemory.getSummary() : null;
    const ownerName = this.config.identity.owner || 'the owner';
    return {
      identityPrompt: this.identity.getSystemPrompt(this.config.identity),
      ownerSections: this.userMemory ? this.ownerSections(this.userMemory.beliefs, ownerName) : null,
      ownerName,
      skillContext: this.capabilities.getSkillContext(),
      botSection: this.botManager ? this.botManager.getSystemPromptSection() : '',
      programmingSuffix: this.programmingMode.getSystemPromptSuffix(),
      researchSuffix: this.researchMode.getSystemPromptSuffix(),
      saverSuffix: this.saverMode.getSystemPromptSuffix(),
      cwd: this.capabilities.getCwd(),
      now: new Date(),
      platform: process.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      memorySummary: summary ? { total: summary.total, learningPaused: summary.learningPaused } : null,
      toolNames: this.capabilities.getToolNames(),
      github: this.config.github,
    };
  }

  async processInternalPrompt(prompt: string, channelId?: string, channelType?: string, opts: { allowTools?: string[]; scheduledTaskId?: string; scheduledRunId?: string } = {}): Promise<void> {
    const syntheticMsg: ChannelMessage = {
      id: opts.scheduledRunId ? `scheduled-${opts.scheduledRunId}` : `internal-${Date.now().toString(36)}`,
      channelId: channelId || 'internal',
      channelType: (channelType || 'internal') as ChannelType,
      senderId: 'system',
      content: prompt,
      timestamp: Date.now(),
      ...(opts.allowTools?.length || opts.scheduledTaskId
        ? { metadata: { ...(opts.allowTools?.length ? { allowTools: opts.allowTools } : {}), ...(opts.scheduledTaskId ? { scheduledTaskId: opts.scheduledTaskId, scheduledRunId: opts.scheduledRunId } : {}) } }
        : {}),
    };
    if (opts.scheduledTaskId) {
      // A scheduled prompt is work, never an interactive slash command/dialog answer.
      const accepted = this.workLedger.accept(syntheticMsg);
      if (accepted.accepted) {
        this.queueMessage(syntheticMsg, accepted.entry.key);
        void this.processQueue();
      }
    } else {
      this.enqueueMessage(syntheticMsg);
    }
  }

  private async handleScheduledTask(manifest: ScheduledTaskManifest, runId: string): Promise<ScheduledDispatch> {
    // Bot routines run on the bot lane, never through the main agent loop
    // (BOTS-ARCHITECTURE.md §2.3 — cron lane).
    if (manifest.botId) {
      if (!this.botManager) {
        throw new Error('Bot routine fired but BotManager is not wired');
      }
      logger.info({ task: manifest.id, botId: manifest.botId }, 'Bot routine firing');
      const result = this.botManager.enqueue(manifest.botId, {
        trigger: 'cron',
        prompt: manifest.prompt || manifest.description,
        routineId: manifest.id,
      });
      if (!result.accepted) {
        // Gate skips (busy, too soon, paused) are the governor working, not faults.
        const level = result.reasonCode === 'busy' || result.reasonCode === 'too_soon' || result.reasonCode === 'routine_paused' ? 'info' : 'warn';
        logger[level]({ botId: manifest.botId, task: manifest.id, reasonCode: result.reasonCode }, 'Bot routine tick skipped');
        if (['busy', 'too_soon', 'routine_paused', 'stopped', 'target_disabled'].includes(result.reasonCode ?? '')) return 'skipped';
        throw new Error(`Bot schedule was not accepted: ${result.reasonCode ?? 'unknown error'}`);
      }
      return 'dispatched';
    }
    logger.info({ task: manifest.id, channel: manifest.sourceChannelType }, 'Processing scheduled task');
    try {
      const channel = manifest.sourceChannelType
        ? this.channels.get(manifest.sourceChannelType as ChannelType)
        : this.channels.getNotificationChannel();

      if (channel && manifest.sourceChannelType !== 'internal') {
        const skillInfo = manifest.skillName ? ` (${manifest.skillName})` : '';
        await channel.send(
          ` Scheduled task started${skillInfo}: ${manifest.description}\nExisting tool permissions apply to this run.`,
          manifest.sourceChannelId,
        ).catch((e) => logger.warn({ e }, 'channel send failed'));
      }

      let prompt = manifest.prompt || '';
      if (manifest.skillName) {
        const skillHint = `Invoke the skill "${manifest.skillName}" using the use_skill tool and follow its instructions.`;
        prompt = prompt ? `${prompt} ${skillHint}` : `Scheduled task triggered. ${skillHint}`;
      }
      if (!prompt) {
        prompt = `Execute scheduled task: ${manifest.description}`;
      }
      await this.processInternalPrompt(prompt, manifest.sourceChannelId, manifest.sourceChannelType, { allowTools: manifest.allowTools, scheduledTaskId: manifest.id, scheduledRunId: runId });
      return 'queued';
    } catch (err) {
      logger.error({ err, task: manifest.id }, 'Scheduled task execution failed');
      throw err;
    }
  }

  /**
   * Run the reflection pass now (heartbeat, and shutdown from index.ts). It
   * only calls the model when at least one session has a new owner message
   * since the last pass; concurrent calls share one run.
   */
  /**
   * The provider the Owner Model learns on (ADR-026): `memory.learning.provider`
   * when it names a usable provider, else the chat default. Resolved per call so
   * a key added at runtime or a changed default is picked up.
   */
  private learningProviders(): { getDefault(): ReturnType<ProviderRegistry['getDefault']> } {
    return {
      getDefault: () => {
        const requested = this.config.memory.learning?.provider?.trim();
        if (requested) {
          const getUsable = typeof this.providers.getUsable === 'function' ? this.providers.getUsable.bind(this.providers) : (name?: string) => (name ? this.providers.get(name) : undefined);
          const provider = getUsable(requested);
          if (provider) return provider;
          if (!this.warnedLearningProvider) {
            this.warnedLearningProvider = true;
            logger.warn({ requested }, 'memory.learning.provider is not registered or not usable — learning on the default provider');
          }
        }
        return this.providers.getDefault();
      },
    };
  }
  private warnedLearningProvider = false;

  async reflectNow(): Promise<void> {
    if (!this.userMemory) return;
    if (this.reflectionInFlight) return this.reflectionInFlight;
    const userMemory = this.userMemory;
    const force = userMemory.beliefs.getMeta('reflection_force') === '1';
    if (force) userMemory.beliefs.setMeta('reflection_force', '0');
    this.reflectionInFlight = runReflection({
      beliefs: userMemory.beliefs,
      sessions: this.sessions,
      providers: this.learningProviders(),
      tokenBudget: this.tokenBudget,
      learningPaused: () => userMemory.isLearningPaused(),
      ownerName: this.config.identity.owner || 'the owner',
      agentId: this.config.cloud.agentId || undefined,
    }, { force }).then((result) => {
      if (result.ran) this.syncTokenInfoToCli();
    }).finally(() => {
      this.reflectionInFlight = null;
    });
    return this.reflectionInFlight;
  }

  private async heartbeat(): Promise<void> {
    logger.debug('Heartbeat tick');

    const pruned = this.episodic.prune(7);
    if (pruned > 0) {
      logger.info({ pruned }, 'Episodic memory pruned');
    }

    if (this.skillLoader) {
      // Self-made skills nobody used again go dormant (ADR-027); cheap, file-only.
      try {
        const { selfMadeHygiene } = await import('../skills/self-made.js');
        const { dormant } = selfMadeHygiene(this.skillLoader.rootDir());
        if (dormant.length > 0) this.skillLoader.discover();
      } catch (err) {
        logger.debug({ err }, 'self-made skill hygiene failed');
      }
    }

    if (this.userMemory) {
      // The reflection pass (ADR-026): one model call over the owner's turns
      // since the last pass, then decay; a no-op when nothing new was said.
      // It is the only maintenance the Second Brain gets — one source.
      await this.reflectNow().catch((err) => logger.warn({ err }, 'Reflection pass failed'));
    }

    const notifications: string[] = [];

    const usagePct = this.tokenBudget.getUsagePercentage();
    if (usagePct >= 80) {
      notifications.push(`Token budget at ${Math.round(usagePct)}% — ${this.tokenBudget.getRemaining().toLocaleString()} tokens remaining today.`);
    }

    const pendingSchedules = this.scheduler.getManifests();
    const now = Date.now();
    for (const task of pendingSchedules) {
      if (task.delaySeconds && task.executeAt) {
        const executeAt = new Date(task.executeAt).getTime();
        const diffMin = Math.round((executeAt - now) / 60000);
        if (diffMin > 0 && diffMin <= 5) {
          notifications.push(`Task "${task.description}" fires in ${diffMin} minute${diffMin !== 1 ? 's' : ''}.`);
        }
      }
    }

    if (notifications.length > 0) {
      const channel = this.channels.getNotificationChannel();
      if (channel) {
        const msg = notifications.join('\n');
        try {
          await channel.send(msg, 'notification');
        } catch (err) {
          logger.warn({ err }, 'Failed to send heartbeat notification');
        }
      }
    }
  }

  /** Learn from a conversation that didn't happen as chat turns (e.g. a voice call). */
  learnFromConversation(ownerSaid: string, mercurySaid: string): void {
    void this.extractMemory(ownerSaid, mercurySaid, {}).catch((err) => logger.warn({ err }, 'Learning from a call failed'));
  }

  /** Who Mercury is, for a voice that isn't the main model: identity, about, and the owner's profile. */
  voiceBriefing(): string {
    const parts = [this.identity.getSystemPrompt(this.config.identity)];
    if (this.userMemory) {
      try {
        const ownerName = this.config.identity.owner || 'your owner';
        const sections = this.ownerSections(this.userMemory.beliefs, ownerName);
        const text = [sections?.about, sections?.howToWork].filter((s): s is string => Boolean(s && s.trim())).join('\n\n');
        if (text) parts.push(`# What you know about ${ownerName} (from your Second Brain)\n${text.slice(0, 4000)}`);
      } catch { /* memory unavailable: identity alone */ }
    }
    return parts.join('\n\n');
  }

  /**
   * The per-turn learning loop (ADR-026, docs/owner-model.md §3.4): the
   * turn's signals plus one small model call become belief operations
   * applied to the belief store, and at most one "☿ Noted" line goes back
   * on the channel after the reply. The legacy `memories` table is no
   * longer written here; only the explicit save_memory tool writes it.
   */
  private async extractMemory(
    userMessage: string,
    agentResponse: string,
    ctx: {
      msg?: ChannelMessage;
      channel?: { send(content: string, targetId?: string): Promise<void> };
      sessionId?: string;
      /** The turn's tool-trace lines (formatToolTraceLine). */
      toolTrace?: readonly string[];
      /** Resolves once the reply reached the channel; the note is sent after it. */
      delivered?: Promise<void>;
      /** The untrusted content the turn read (ADR-044). */
      exposure?: Exposure;
    } = {},
  ): Promise<void> {
    if (!this.userMemory) return;
    // Someone else's words are never evidence about the owner.
    if (ctx.msg?.senderRole === 'member') return;
    if (this.userMemory.isLearningPaused()) return;
    const beliefs = this.userMemory.beliefs;
    const channelAccess = typeof ctx.msg?.metadata?.channelAccess === 'string' ? ctx.msg.metadata.channelAccess : undefined;
    if (channelAccess === 'general') return;

    // The session's earlier turns, role-labelled: context for the extractor
    // and the source for "same request again" detection.
    const history: ExtractTurn[] = [];
    if (ctx.sessionId && ctx.msg) {
      try {
        const thisTurn = new Set([ctx.msg.id, `${ctx.msg.id}:assistant`, `${ctx.msg.id}:tools`]);
        for (const m of this.sessions.get(ctx.sessionId).messages) {
          if (m.kind !== 'message' || (m.role !== 'user' && m.role !== 'assistant')) continue;
          if (m.externalMessageId && thisTurn.has(m.externalMessageId)) continue;
          if (m.role === 'user' && m.metadata?.senderRole === 'member') continue;
          history.push({ role: m.role === 'user' ? 'owner' : 'mercury', content: m.content });
        }
      } catch (err) {
        logger.debug({ err }, 'Session history unavailable for learning');
      }
    }
    const signals = collectTurnSignals({
      message: userMessage,
      previousUserMessages: history.filter((t) => t.role === 'owner').map((t) => t.content),
      toolTrace: parseToolTraceLines(ctx.toolTrace ?? []),
      allowAllActive: this.capabilities.permissions.isAutoApproveAll(),
      permissionAnswers: this.capabilities.permissions.drainAnswers(),
      channelType: ctx.msg?.channelType,
      sessionId: ctx.sessionId,
      cwd: this.capabilities.getCwd(),
    });

    // Validation loop (§3.1): the beliefs the previous turn acted on earn
    // weak support once the owner's next message in the same session shows
    // no correction. Then remember what this turn acted on.
    // Per session (ADR-037): another chat's turn in between no longer resets it.
    if (ctx.sessionId) {
      const pending = this.pendingActedOn.get(ctx.sessionId);
      if (pending && pending.length > 0 && !signals.correction.detected) {
        try { beliefs.actedOnOk(pending, ctx.sessionId); } catch (err) { logger.debug({ err }, 'actedOnOk failed'); }
      }
      this.pendingActedOn.delete(ctx.sessionId);
      this.pendingActedOn.set(ctx.sessionId, [...(this.lastInjectedBeliefIds ?? [])]);
      if (this.pendingActedOn.size > 200) {
        const oldest = this.pendingActedOn.keys().next().value;
        if (oldest !== undefined) this.pendingActedOn.delete(oldest);
      }
    }

    // A turn that read instructions written to an AI learns nothing: whatever
    // it would take away could be what the page wanted remembered.
    if (ctx.exposure?.suspicious) {
      logger.info({ sources: ctx.exposure.sources.map((s) => s.label) }, 'Learning skipped: the turn read content with instructions to an AI');
      return;
    }

    try {
      const ops = await extractBeliefOperations({
        providers: this.learningProviders(),
        tokenBudget: this.tokenBudget,
        beliefs,
        learningPaused: () => this.userMemory?.isLearningPaused() ?? true,
        agentId: this.config.cloud.agentId || undefined,
      }, {
        ownerMessage: userMessage,
        mercuryReply: agentResponse,
        recentTurns: history.slice(-6),
        signals,
        ownerName: this.config.identity.owner || 'the owner',
        pendingQuestion: pendingQuestion(beliefs),
        channelAccess,
        sessionId: ctx.sessionId,
        turnRef: ctx.msg?.id,
        untrusted: !!ctx.exposure?.sources.length,
      });
      this.syncTokenInfoToCli();
      if (ops.length === 0) return;

      const results: ApplyResult[] = [];
      for (const op of ops) {
        try {
          const r = beliefs.apply(op);
          if (r) results.push(r);
        } catch (err) {
          logger.warn({ err, op: op.op }, 'Belief operation failed');
        }
      }
      if (results.length > 0) logger.info({ changes: results.map((r) => `${r.change}:${r.belief.kind}`) }, 'Beliefs updated from turn');

      const note = composeLearnedNote(results, { beliefs });
      if (!note || !ctx.channel || !ctx.msg) return;
      const notedAt = this.lastNotedAt.get(ctx.msg.channelId) ?? 0;
      if (Date.now() - notedAt < NOTE_COOLDOWN_MS) return;
      this.lastNotedAt.set(ctx.msg.channelId, Date.now());
      // After the reply, never ahead of it (capped so a stuck delivery can't hold the note forever).
      await Promise.race([
        ctx.delivered ?? Promise.resolve(),
        new Promise<void>((resolve) => { setTimeout(resolve, 20_000).unref(); }),
      ]);
      await ctx.channel.send(note, ctx.msg.channelId);
      // "forget that" right after the note undoes exactly this belief.
      const noted = results.find((r) => r.behaviorChanging)?.belief.id;
      if (noted) this.lastNotedBeliefId.set(ctx.msg.channelId, noted);
    } catch (err) {
      logger.warn({ err }, 'Memory extraction error');
    }
  }

  /**
   * Mark all queued/running work as user-cancelled (terminal state).
   * Used by deliberate-stop paths (TUI Ctrl+C, /exit, SIGTERM) so the
   * next start does not auto-resume killed tasks. Crash recovery is
   * unaffected — this is only invoked on intentional exits.
   */
  /**
   * Stop only the work started from one place (e.g. a desktop voice session,
   * "desktop:call:<id>"): the running turn if it's theirs, and anything
   * queued for it. Other chats keep going. Returns whether anything stopped.
   */
  stopWorkFor(channelPrefix: string, reason = 'Stopped by the owner.'): boolean {
    let stopped = this.dropWaiting((m) => m.channelId.startsWith(channelPrefix), reason) > 0;
    for (const turn of this.activeTurns.values()) {
      if (turn.message.channelId.startsWith(channelPrefix) && this.abortTurn(turn, 'stopped', reason)) stopped = true;
    }
    if (stopped) logger.info({ channelPrefix }, 'Work stopped for one channel');
    return stopped;
  }

  cancelActiveWork(reason = 'Cancelled by the user.'): number {
    try {
      return this.workLedger.cancelActive(reason);
    } catch (error) {
      logger.warn({ error }, 'Failed to cancel active work');
      return 0;
    }
  }

  async shutdown(): Promise<void> {
    // Deliberate shutdown: never resume this work on restart.
    try { this.workLedger.cancelActive('Mercury was shut down.'); } catch { /* best effort */ }
    if (this.supervisor) {
      await this.supervisor.haltAll();
    }
    this.backgroundTasks.destroy();
    await this.capabilities.closeBrowserSessions();
    this.providers.destroy();
    await this.sleep();
    logger.info('Mercury has shut down');
  }

  /**
   * Notify all active channels with a message. Used before forced exits
   * (SIGTERM, crash, watchdog kill) so the user is never left wondering
   * what happened to their task.
   */
  async notifyAllChannels(message: string): Promise<void> {
    const outcome = await this.alertGate.run(message, () => this.broadcastToChannels(message));
    if (outcome !== 'sent') logger.warn({ outcome, message: message.slice(0, 120) }, 'Broadcast not sent');
  }

  /** Broadcasts never nest or repeat (see AlertGate). */
  private alertGate = new AlertGate();

  private async broadcastToChannels(message: string): Promise<void> {
    const active = this.channels.getActiveChannels();
    const sends = active.map((type) => {
      const ch = this.channels.get(type);
      if (!ch || ch.noBroadcast) return Promise.resolve();
      return ch.send(message).catch((e) => {
        logger.warn({ e, channel: type }, 'Failed to notify channel before exit');
      });
    });
    await Promise.allSettled(sends);
  }

  /**
   * AI self-check: ask the model itself whether repeated tool usage is productive or a loop.
   * Used in allow-all mode instead of prompting the user.
   * Returns true if the AI thinks it should continue, false if it should stop.
   */
  private async aiSelfCheck(context: {
    toolName: string;
    callCount: number;
    recentCalls: string[];
    taskDescription: string;
  }): Promise<boolean> {
    try {
      const provider = this.providers.getDefault();
      if (!provider) return true; // no provider = let it continue

      const selfCheckResult = await generateText({
        model: provider.getModelInstance(),
        system: `You are Mercury Autopilot, a monitoring system inside an AI coding agent. Your job is to determine whether repeated tool usage is productive iteration or a stuck loop.

Productive patterns (CONTINUE):
- Fetching multiple different URLs (e.g., scraping articles, reading docs)
- Reading multiple different files to understand a codebase
- Editing different sections of code across files
- Running different commands (build, test, lint, deploy)
- Creating multiple files for a project

Stuck patterns (STOP):
- Same exact call repeated with identical parameters
- Retrying the same failing operation with minor variations
- Reading the same file over and over
- Running the same failing command repeatedly

Respond with ONLY "CONTINUE" or "STOP" followed by a one-line reason.`,
        messages: [{
          role: 'user',
          content: `Tool "${context.toolName}" called ${context.callCount} times consecutively.

User's task: ${context.taskDescription}

Recent calls (newest last):
${context.recentCalls.join('\n')}

Is this productive iteration or a stuck loop?`,
        }],
        maxOutputTokens: 80,
      });

      const answer = (selfCheckResult.text || '').trim().toUpperCase();
      const shouldContinue = answer.startsWith('CONTINUE');
      logger.info({
        toolName: context.toolName,
        count: context.callCount,
        decision: shouldContinue ? 'continue' : 'stop',
        reason: selfCheckResult.text?.trim().slice(0, 120),
      }, 'Mercury Autopilot verdict');
      return shouldContinue;
    } catch (err) {
      logger.warn({ err }, 'Mercury Autopilot self-check failed — defaulting to continue');
      return true; // on failure, be permissive
    }
  }

  setSpotifyClient(client: SpotifyClient): void {
    this.spotifyClient = client;
  }

  async presentChoice(question: string, choices: string[], channelId: string, channelType: string): Promise<string> {
    const channel = this.channels.get(channelType as any);

    if (channelType === 'cli' && channel instanceof CLIChannel) {
      const options = choices.map((label, i) => ({
        value: String(i),
        label,
      }));

      const selected = await channel.presentChoicePrompt(question, options);
      const index = parseInt(selected, 10);
      return isNaN(index) ? choices[0] : (choices[index] ?? choices[0]);
    }

    if (channelType === 'web' && channel instanceof WebChannel) {
      const options = choices.map((label, i) => ({
        value: String(i),
        label,
      }));

      const selected = await channel.presentChoicePrompt(question, options, channelId);
      const index = parseInt(selected, 10);
      return isNaN(index) ? choices[0] : (choices[index] ?? choices[0]);
    }

    if (channelType === 'telegram' && channel instanceof TelegramChannel) {
      const options = choices.map((label, i) => ({
        value: String(i),
        label,
      }));

      const selected = await channel.presentChoicePrompt(question, options, channelId);
      const index = parseInt(selected, 10);
      return isNaN(index) ? choices[0] : (choices[index] ?? choices[0]);
    }

    await channel?.send(`${question}\n${choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`, channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
    return choices[0];
  }

  private async handleBudgetOverrideCLI(channel: import('../channels/base.js').Channel, msg: ChannelMessage): Promise<void> {
    const status = this.tokenBudget.getStatusText();
    await channel.send(
      `Token budget exceeded! ${status}\n\nChoose an option:\n  1 — Override (allow this one request)\n  2 — Reset usage to zero\n  3 — Set a new daily budget (current: ${this.tokenBudget.getBudget().toLocaleString()})\n  4 — Cancel\n\nOr use /budget override, /budget reset, /budget set <number> anytime.`,
      msg.channelId,
    );
  }

  async handleBudgetCommand(subcommand: string, channelType: string, channelId: string): Promise<void> {
    const channel = this.channels.get(channelType as any);
    if (!channel) return;

    const parts = subcommand.trim().split(/\s+/);
    const action = parts[0]?.toLowerCase();

    if (action === 'override' || action === '1') {
      this.tokenBudget.forceAllowNext();
      await channel.send('Budget override applied — your next request will proceed.', channelId);
    } else if (action === 'reset' || action === '2') {
      this.tokenBudget.resetUsage();
      this.syncTokenInfoToCli();
      await channel.send(`Usage reset to zero. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (action === 'set' || action === '3') {
      const newBudget = parseInt(parts[1], 10);
      if (isNaN(newBudget) || newBudget <= 0) {
        await channel.send('Please specify the new budget. Usage: `/budget set 100000` or type e.g. `3 100000`', channelId);
        return;
      }
      this.tokenBudget.setBudget(newBudget);
      this.syncTokenInfoToCli();
      await channel.send(`Daily budget updated to ${newBudget.toLocaleString()} tokens. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (action === 'cancel' || action === '4') {
      await channel.send(`Cancelled. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (!action || action === 'status') {
      const split = this.tokenBudget.getCacheSplitText();
      await channel.send(split ? `${this.tokenBudget.getStatusText()}\n${split}` : this.tokenBudget.getStatusText(), channelId);
    } else {
      await channel.send(`Unknown budget command "${action}". Available: /budget, /budget override, /budget reset, /budget set <number>, /budget status`, channelId);
    }
  }

  /**
   * Handle the /saver slash command — Token Saver Mode controls.
   * Subcommands: (empty)|status|on|off|toggle|threshold <n>|auto on|off|routing on|off|stats
   */
  async handleSaverCommand(subcommand: string, channelType: string, channelId: string): Promise<void> {
    return handleSaverCommandImpl(this, subcommand, channelType, channelId);
  }

  /** Push the current saver state to the CLI status bar if present. */
  syncSaverToCli(): void {
    const ch = this.channels.get('cli');
    if (ch && (ch as any).setSaverMode) {
      (ch as any).setSaverMode(
        this.saverMode.getState(),
        this.tokenBudget.getSavedToday(),
        this.tokenBudget.getSavedLifetime(),
      );
    }
  }

  private syncTokenInfoToCli(): void {
    const ch = this.channels.get('cli');
    if (ch && (ch as any).setTokenInfo) {
      (ch as any).setTokenInfo(
        this.tokenBudget.getDailyUsed(),
        this.tokenBudget.getBudget(),
        Math.round(this.tokenBudget.getUsagePercentage()),
      );
    }
  }

  async handleSkillsSlashCommand(
    trimmed: string,
    channel: any,
    channelId: string,
    ctx: { skillNames: () => string[] },
  ): Promise<void> {
    const parts = trimmed.split(/\s+/).slice(1);
    const sub = (parts[0] || 'list').toLowerCase();
    const args = parts.slice(1);
    const arg = args.join(' ').trim();

    const { RegistryClient, isValidSkillId, searchFeed } = await import('../skills/registry.js');
    const { SkillStore } = await import('../skills/store.js');
    const registry = new RegistryClient();
    const store = new SkillStore({ registry });

    try {
      switch (sub) {
        case 'help':
        case '-h':
        case '--help': {
          await channel.send(
            [
              '**Mercury Skills — in-chat commands**',
              '',
              '`/skills` — list installed skills',
              '`/skills search <query>` — search the registry',
              '`/skills view <id>` — show details + registry URL',
              '`/skills install <id>` — install from the registry',
              '`/skills install <url>` — install raw SKILL.md from a URL',
              '`/skills remove <id>` — uninstall',
              '`/skills self-made` — the skills Mercury wrote for itself, with use counts',
              '`/skills self-made enable|disable|remove <name>`',
              '',
              'Browse the full catalog at https://skills.mercuryagent.sh',
            ].join('\n'),
            channelId,
          );
          return;
        }

        case 'list': {
          const names = ctx.skillNames();
          if (names.length === 0) {
            await channel.send(
              'No skills installed. Try `/skills search <query>` to browse https://skills.mercuryagent.sh.',
              channelId,
            );
            return;
          }
          const lines = [
            `**${names.length} skill${names.length > 1 ? 's' : ''} installed:**`,
            '',
            ...names.map((n) => `• ${n}`),
            '',
            '_Run `/skills search <query>` to find more on the registry._',
          ];
          await channel.send(lines.join('\n'), channelId);
          return;
        }

        case 'self-made':
        case 'self':
        case 'mine': {
          const { listSelfMade } = await import('../skills/self-made.js');
          const root = this.skillLoader?.rootDir();
          if (!root) { await channel.send('Skills are not available in this session.', channelId); return; }
          const action = (args[0] || '').toLowerCase();
          const target = args.slice(1).join(' ').trim();
          if ((action === 'enable' || action === 'disable' || action === 'remove') && target) {
            const entry = listSelfMade(root).find((s) => s.name === target);
            if (!entry) { await channel.send(`No self-made skill named "${target}".`, channelId); return; }
            if (action === 'remove') { this.skillLoader!.deleteSkill(target); await channel.send(`Removed self-made skill "${target}".`, channelId); return; }
            this.skillLoader!.setSkillActive(target, action === 'enable');
            await channel.send(`${action === 'enable' ? 'Enabled' : 'Disabled'} self-made skill "${target}".`, channelId);
            return;
          }
          const entries = listSelfMade(root);
          if (entries.length === 0) {
            await channel.send('No self-made skills yet. After a long task works, Mercury saves the procedure here (create_skill) so the next time is one step.', channelId);
            return;
          }
          const fmt = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'never');
          const lines = [`**${entries.length} self-made skill${entries.length > 1 ? 's' : ''}** (Mercury wrote these; unverified until used again):`, ''];
          for (const s of entries) {
            lines.push(`${s.active ? '•' : '◦'} **${s.name}** — ${s.description}`);
            lines.push(`   made ${fmt(s.made)} · used ${s.uses}× · last ${fmt(s.lastUsed)}${s.active ? '' : ' · dormant'}`);
          }
          lines.push('', '_`/skills self-made enable|disable|remove <name>`. Unused ones go dormant after 30 days; nothing is deleted on its own._');
          await channel.send(lines.join('\n'), channelId);
          return;
        }

        case 'search':
        case 'find': {
          if (!arg) {
            await channel.send('Usage: `/skills search <query>`', channelId);
            return;
          }
          await channel.send(`🔍 Searching the registry for "${arg}"…`, channelId);
          const feed = await registry.getFeed();
          const scored = searchFeed(feed, arg, 5);
          if (scored.length === 0) {
            await channel.send(`No matches for "${arg}".`, channelId);
            return;
          }
          const lines = scored.map(({ skill }) =>
            [
              `• \`${skill.id}\` (v${skill.version})`,
              `  ${skill.description}`,
              `  ${registry.webUrl(skill.id)}`,
            ].join('\n'),
          );
          await channel.send(
            [
              `**Top ${scored.length} matches for "${arg}":**`,
              '',
              lines.join('\n\n'),
              '',
              'Inspect one with `/skills view <id>`, install with `/skills install <id>`.',
            ].join('\n'),
            channelId,
          );
          return;
        }

        case 'view':
        case 'show':
        case 'info': {
          if (!arg) {
            await channel.send('Usage: `/skills view <category/slug>`', channelId);
            return;
          }
          if (!isValidSkillId(arg)) {
            await channel.send('Invalid skill id. Expected `<category>/<slug>`.', channelId);
            return;
          }
          const detail = await registry.getSkill(arg);
          const author = detail.author ? `\n**Author:** ${detail.author}` : '';
          const tags = detail.tags?.length ? `\n**Tags:** ${detail.tags.join(', ')}` : '';
          await channel.send(
            [
              `**${detail.title}** (\`${detail.id}\`)`,
              `**Version:** ${detail.version}`,
              `**Category:** ${detail.category}${author}${tags}`,
              '',
              detail.description,
              '',
              `🔗 ${registry.webUrl(detail.id)}`,
              '',
              `Install with \`/skills install ${detail.id}\``,
            ].join('\n'),
            channelId,
          );
          return;
        }

        case 'install':
        case 'add': {
          if (!arg) {
            await channel.send('Usage: `/skills install <category/slug>` or `/skills install <url>`', channelId);
            return;
          }
          // URL install → delegate to the existing capability path
          if (/^https?:\/\//i.test(arg)) {
            const { SkillLoader } = await import('../skills/loader.js');
            const loader = new SkillLoader();
            await channel.send(`📦 Installing from \`${arg}\`…`, channelId);
            const installed = await loader.installFromUrl(arg);
            await channel.send(
              `✅ Installed \`${installed.name}\` from URL.\n${installed.skillDir}`,
              channelId,
            );
            return;
          }
          if (!isValidSkillId(arg)) {
            await channel.send('Invalid skill id. Expected `<category>/<slug>` or a `https://` URL.', channelId);
            return;
          }
          await channel.send(`📦 Installing \`${arg}\` from the registry…`, channelId);
          const result = await store.install(arg);
          const verb =
            result.status === 'already-installed'
              ? 'Already installed'
              : result.status === 'updated'
                ? 'Updated'
                : result.status === 'reinstalled'
                  ? 'Reinstalled'
                  : 'Installed';
          await channel.send(
            `✅ ${verb} \`${result.id}\` (v${result.version})\n🔗 ${registry.webUrl(result.id)}`,
            channelId,
          );
          return;
        }

        case 'remove':
        case 'rm':
        case 'delete':
        case 'uninstall': {
          if (!arg) {
            await channel.send('Usage: `/skills remove <category/slug>`', channelId);
            return;
          }
          if (!isValidSkillId(arg)) {
            await channel.send('Invalid skill id. Expected `<category>/<slug>`.', channelId);
            return;
          }
          const removed = store.remove(arg);
          await channel.send(
            removed ? `🗑 Removed \`${arg}\`.` : `Skill \`${arg}\` is not installed.`,
            channelId,
          );
          return;
        }

        default:
          await channel.send(
            `Unknown subcommand \`${sub}\`. Try \`/skills help\`.`,
            channelId,
          );
      }
    } catch (err: any) {
      const msg = err?.message || 'Skill registry request failed';
      await channel.send(`⚠️ ${msg}`, channelId);
    }
  }

  async handleChatCommand(content: string, channelType: string, channelId: string): Promise<boolean> {
    return handleChatCommandImpl(this, content, channelType, channelId);
  }

  /** Render the trace for a turn in this chat's session (latest when no id). */
  renderTrace(channelType: ChannelType, channelId: string, idArg = ''): string {
    const bindingId = channelType === 'cli' ? 'current' : channelId;
    const session = this.sessions.getByBinding(channelType, bindingId);
    if (!session) return 'No session is bound to this chat yet.';
    const turns = session.messages.filter((m) => m.role === 'assistant' && m.kind === 'message');
    const wanted = idArg.toLowerCase();
    const target = wanted
      ? [...turns].reverse().find((m) => String((m.metadata as Record<string, unknown> | undefined)?.traceId ?? '').toLowerCase().startsWith(wanted))
      : turns.at(-1);
    if (!target) return wanted ? `No turn found for trace "${idArg}".` : 'No turns in this session yet.';
    const meta = (target.metadata ?? {}) as Record<string, unknown>;
    const baseId = (target.externalMessageId ?? '').replace(/:assistant$/, '');
    const toolEntry = baseId
      ? session.messages.find((m) => m.kind === TOOL_TRACE_KIND && m.externalMessageId === `${baseId}:tools`)
      : undefined;
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    const elapsed = num(meta.elapsedMs);
    return [
      `Trace ${String(meta.traceId ?? target.id.slice(0, 8))} · ${new Date(target.timestamp).toISOString()}`,
      `Provider: ${String(meta.provider ?? 'unknown')} / ${String(meta.model ?? 'unknown')}`,
      `Tokens: ${num(meta.inputTokens) ?? '?'} in (${num(meta.cachedInputTokens) ?? 0} cached) · ${num(meta.outputTokens) ?? '?'} out`,
      `Steps: ${num(meta.steps) ?? '?'} · Elapsed: ${elapsed != null ? `${(elapsed / 1000).toFixed(1)}s` : '?'}`,
      `Verification: ${typeof meta.verification === 'string' ? meta.verification : 'none'}`,
      '',
      toolEntry ? toolEntry.content : 'No tool calls in this turn.',
    ].join('\n');
  }

  async handleSessionCommand(content: string, channelType: ChannelType, channelId: string): Promise<void> {
    return handleSessionCommandImpl(this, content, channelType, channelId);
  }

  private scheduleSessionTitleGeneration(sessionId: string, providerName: string): void {
    if (!this.generateTitle || this.titleGenerationInFlight.has(sessionId)) return;
    const session = this.sessions.get(sessionId);
    const exchange = session.messages.filter((message) => message.kind === 'message' && (message.role === 'user' || message.role === 'assistant'));
    if (session.titleSource !== 'fallback' || exchange[0]?.role !== 'user') return;
    // Name it after the first exchange, unless that opened with only "hi":
    // then after the second, when there is something to name.
    const at = exchange.length === 2 && !isThinOpening(exchange[0].content) ? 0 : exchange.length === 4 ? 2 : -1;
    if (at < 0 || exchange[at].role !== 'user' || exchange[at + 1].role !== 'assistant') return;
    const userText = at === 0 ? exchange[0].content : `${exchange[0].content}\n${exchange[2].content}`;
    this.titleGenerationInFlight.add(sessionId);
    const timer = setTimeout(() => {
      void this.generateSessionTitle(sessionId, userText, exchange[at + 1].content, providerName).finally(() => {
        this.titleGenerationInFlight.delete(sessionId);
      });
    }, 0);
    timer.unref?.();
  }

  /**
   * Fix titles made before titles were checked: a generated title that is
   * really a reply ("I appreciate your request, but…") is written again,
   * and fallback titles are re-cut from the first message. Renames don't
   * count as activity, so nothing moves in the list. Runs once at start-up;
   * fixed titles pass the check, so the next start finds nothing to do.
   */
  async repairSessionTitles(limit = 200): Promise<{ regenerated: number; recut: number }> {
    let regenerated = 0;
    let recut = 0;
    for (const session of this.sessions.list()) {
      const firstUser = session.messages.find((m) => m.role === 'user' && (m.kind ?? 'message') === 'message');
      if (!firstUser) continue;
      // Voice labels are deterministic timestamps/durations, not model titles.
      if (typeof session.messages[0]?.metadata?.voiceCall === 'string') continue;
      if (session.titleSource === 'fallback') {
        const title = fallbackSessionTitle(firstUser.content);
        if (title !== session.title) { this.sessions.updateTitle(session.id, title, 'fallback', { touch: false }); recut++; }
        continue;
      }
      if (session.titleSource !== 'generated') continue;
      const exchange = session.messages.filter((m) => (m.kind ?? 'message') === 'message' && (m.role === 'user' || m.role === 'assistant'));
      const thin = isThinOpening(firstUser.content);
      const tidy = normalizeGeneratedSessionTitle(session.title);
      if (tidy && !(thin && /greeting|check-in|hello/i.test(tidy))) {
        // A good title with wrappers left on ("# Heading"): tidy it, no model call.
        if (tidy !== session.title) { this.sessions.updateTitle(session.id, tidy, 'generated', { touch: false }); recut++; }
        continue;
      }
      if (regenerated >= limit) continue;
      // A chat that opened with "hi" is named after what came next.
      const users = exchange.filter((m) => m.role === 'user');
      const userText = thin && users[1] ? `${firstUser.content}\n${users[1].content}` : firstUser.content;
      const replyAfter = thin && users[1] ? users[1] : firstUser;
      const reply = exchange.find((m) => m.role === 'assistant' && m.sequence > replyAfter.sequence);
      let title: string | null = null;
      if (this.generateTitle && reply) {
        try {
          title = normalizeGeneratedSessionTitle(await this.generateTitle({ userMessage: userText, assistantMessage: reply.content, providerName: '' }));
        } catch { /* fall back below */ }
      }
      if (title) this.sessions.updateTitle(session.id, title, 'generated', { touch: false });
      else this.sessions.updateTitle(session.id, fallbackSessionTitle(firstUser.content), 'fallback', { touch: false });
      regenerated++;
    }
    if (regenerated || recut) logger.info({ regenerated, recut }, 'Repaired session titles');
    return { regenerated, recut };
  }

  private async generateSessionTitle(sessionId: string, userMessage: string, assistantMessage: string, providerName: string): Promise<void> {
    try {
      const rawTitle = await this.generateTitle!({ userMessage, assistantMessage, providerName });
      const title = normalizeGeneratedSessionTitle(rawTitle);
      if (!title) {
        logger.debug({ sessionId }, 'Session title generator returned an unusable title');
        return;
      }
      if (this.sessions.get(sessionId).titleSource !== 'fallback') return;
      const session = this.sessions.updateTitle(sessionId, title, 'generated');
      const currentCliSession = this.sessions.getByBinding('cli', 'current');
      const cliChannel = this.channels.get('cli');
      if (currentCliSession?.id === session.id && cliChannel instanceof CLIChannel) cliChannel.setCurrentSession(session);
      logger.info({ sessionId, title }, 'Generated canonical session title');
    } catch (error) {
      logger.debug({ sessionId, err: error instanceof Error ? error.message : String(error) }, 'Background session title generation failed');
    }
  }

  /**
   * Mercury Code only: at turn end, maybe fire the one-shot LLM status-verb
   * refresh (cadence in core/status-verbs.ts). Fire-and-forget and unref'd —
   * the turn is already done; a slow call must never stall anything. Non-code
   * surfaces are skipped entirely: chat keeps its plain static labels.
   */
  private scheduleStatusVerbRefresh(channel: import('../channels/base.js').Channel | null | undefined, userText: string): void {
    const cliChannel = channel instanceof CLIChannel ? channel : null;
    if (!cliChannel || cliChannel.getTuiState().mode !== 'mercury-code') return;
    this.statusVerbTurnCount += 1;
    const gate = shouldRefreshStatusVerbs({
      turnCount: this.statusVerbTurnCount,
      inFlight: this.statusVerbsInFlight,
      disabled: this.statusVerbsDisabled,
    });
    if (!gate.refresh) return;
    this.statusVerbsInFlight = true;
    const timer = setTimeout(() => {
      void this.refreshStatusVerbs(cliChannel, userText).finally(() => {
        this.statusVerbsInFlight = false;
      });
    }, 0);
    timer.unref?.();
  }

  private async refreshStatusVerbs(cliChannel: CLIChannel, userText: string): Promise<void> {
    try {
      if (this.tokenBudget.canAfford(500)) {
        const provider = this.providers.getDefault();
        if (provider && provider.isAvailable()) {
          const tui = cliChannel.getTuiState();
          const requests = tui.chatMessages
            .filter((m) => m.role === 'user' && m.content.trim())
            .slice(-4)
            .map((m) => m.content);
          const { system, prompt } = buildStatusVerbPrompt({
            userRequests: requests.length > 0 ? requests : [userText],
            projectName: path.basename(tui.projectContext ?? '') || 'this project',
            recentActivity: tui.lastStepLog?.map((s) => s.label),
          });
          const result = await generateText({
            model: provider.getModelInstance(),
            system,
            messages: [{ role: 'user', content: prompt }],
            maxOutputTokens: 400,
          });
          this.tokenBudget.recordUsage({
            provider: provider.name,
            model: provider.getModel(),
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
            channelType: 'internal',
            agentId: this.config.cloud.agentId || undefined,
          });
          const verbs = parseStatusVerbs(result.text ?? '');
          if (verbs) {
            cliChannel.setStatusVerbs(verbs);
            return;
          }
        }
      }
      this.failStatusVerbRefresh(cliChannel, userText);
    } catch (err) {
      logger.debug({ err }, 'Status-verb refresh failed');
      this.failStatusVerbRefresh(cliChannel, userText);
    }
  }

  /** Push the keyword-engine pool once, then the LLM layer is off this session. */
  private failStatusVerbRefresh(cliChannel: CLIChannel, userText: string): void {
    this.statusVerbsDisabled = true;
    // Never downgrade an LLM pool that already landed.
    if (cliChannel.getTuiState().statusVerbs) return;
    cliChannel.setStatusVerbs(verbPoolFor(userText));
  }

  private async handleWorkspaceNaturalLanguage(content: string, channelType: string, channelId: string): Promise<boolean> {
    const channel = this.channels.get(channelType as any);
    if (!channel || channelType !== 'cli' || !(channel instanceof CLIChannel)) return false;

    const trimmed = content.trim();
    const commandMatch = trimmed.match(/^(?:open|use|enter)\s+workspace(?:\s+(.+))?$/i);
    if (!commandMatch) return false;

    const targetRaw = (commandMatch[1] || '').trim();
    const target = targetRaw || this.capabilities.getCwd();
    const opened = channel.openWorkspace(target);
    if (!opened.ok) {
      await channel.send(opened.message, channelId);
      return true;
    }

    const resolved = path.resolve(target.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
    this.capabilities.setCwd(resolved);
    this.capabilities.permissions.addTempScope(resolved, true, true);
    this.programmingMode.setExecute();
    this.programmingMode.setProjectContext(resolved);
    channel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
    await channel.send(`Workspace opened from conversation intent: ${resolved}`, channelId);
    return true;
  }

  async openCliCommandMenu(channel: CLIChannel, channelId: string): Promise<void> {
    return openCliCommandMenuImpl(this, channel, channelId);
  }

  async sendMemoryOverview(channel: any, channelId: string): Promise<void> {
    if (!this.userMemory) return;
    const summary = this.userMemory.getSummary();
    const shareableCount = this.userMemory.countShareable();
    const shareLearning = this.userMemory.isShareLearning();
    const lines = [
      `**Memory Overview**`,
      `Total memories: ${summary.total}`,
      `Learning: ${summary.learningPaused ? 'PAUSED' : 'ACTIVE'}`,
      `Shared learning: ${shareLearning ? 'ON' : 'OFF'} (${shareableCount} shareable)`,
    ];
    if (summary.profileSummary) {
      lines.push(`Profile: ${summary.profileSummary}`);
    }
    if (summary.activeSummary) {
      lines.push(`Active: ${summary.activeSummary}`);
    }
    const typeEntries = Object.entries(summary.byType);
    if (typeEntries.length > 0) {
      lines.push('');
      lines.push('By type:');
      for (const [type, count] of typeEntries) {
        lines.push(`  ${type}: ${count}`);
      }
    }
    // Owner Model (ADR-026): the honest numbers and the last few things learned.
    try {
      const beliefs = this.userMemory.beliefs;
      const now = Date.now();
      lines.push('', formatCounts(beliefs.counts()));
      const recent = beliefs.recentlyLearned(now - 30 * 86_400_000, 3);
      if (recent.length > 0) {
        lines.push('Recently learned:');
        recent.forEach((b, i) => lines.push(`  ${formatLearnedLine(beliefs, i + 1, b, now)}`));
        this.lastBeliefListing.set(channelId, recent.map((b) => b.id));
      }
      lines.push('More: /memory learned, /memory beliefs, /memory contested; /memory confirm|forget|correct <n>.');
    } catch (err) {
      logger.debug({ err }, 'belief overview unavailable');
    }
    await channel.send(lines.join('\n'), channelId);
  }

  async openCliMemoryMenu(channel: CLIChannel, channelId: string, select?: (title: string, options: ArrowSelectOption[]) => Promise<string>): Promise<void> {
    return openCliMemoryMenuImpl(this, channel, channelId, select);
  }

  async openMemoryChoiceMenu(channel: any, channelId: string): Promise<void> {
    return openMemoryChoiceMenuImpl(this, channel, channelId);
  }

  async openCliTelegramMenu(
    channel: CLIChannel,
    channelId: string,
    select: (title: string, options: ArrowSelectOption[]) => Promise<string>,
  ): Promise<void> {
    const ctx = this.capabilities.getChatCommandContext();
    if (!ctx) return;
    const formatTelegramUser = (user: {
      userId: number;
      username?: string;
      firstName?: string;
      pairingCode?: string;
    }) => {
      const username = user.username ? ` (@${user.username})` : '';
      const firstName = user.firstName ? ` ${user.firstName}` : '';
      const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
      return `${user.userId}${username}${firstName}${pairingCode}`;
    };

    const selectFromUsers = async (
      title: string,
      users: Array<{ userId: number; username?: string; firstName?: string; pairingCode?: string }>,
      emptyMessage: string,
      backValue: string = 'back',
    ): Promise<string> => {
      if (users.length === 0) {
        await channel.send(emptyMessage, channelId);
        return backValue;
      }

      return select(title, [
        ...users.map((user) => ({
          value: user.pairingCode || user.userId.toString(),
          label: formatTelegramUser(user),
        })),
        { value: backValue, label: 'Back' },
      ]);
    };

    while (true) {
      const config = ctx.config();
      const action = await select('Telegram Commands', [
        { value: 'overview', label: 'Overview' },
        { value: 'pending', label: `Pending Requests (${config.channels.telegram.pending.length})` },
        { value: 'users', label: `Approved Users (${getTelegramApprovedUsers(config).length})` },
        { value: 'approve', label: 'Approve Request' },
        { value: 'reject', label: 'Reject Request' },
        { value: 'remove', label: 'Remove User' },
        { value: 'promote', label: 'Promote to Admin' },
        { value: 'demote', label: 'Demote Admin' },
        { value: 'reset', label: 'Reset Telegram Access' },
        { value: 'back', label: 'Back' },
        { value: 'exit', label: 'Exit' },
      ]);

      if (action === 'exit') {
        return;
      }

      if (action === 'back') {
        return;
      }

      if (action === 'overview') {
        await this.handleChatCommand('/telegram status', 'cli', channelId);
        continue;
      }

      if (action === 'pending') {
        await this.handleChatCommand('/telegram pending', 'cli', channelId);
        continue;
      }

      if (action === 'users') {
        await this.handleChatCommand('/telegram users', 'cli', channelId);
        continue;
      }

      if (action === 'approve') {
        const pending = getTelegramPendingRequests(config);
        const selected = await selectFromUsers(
          'Approve Telegram Request',
          pending,
          'There are no pending Telegram requests to approve.',
        );

        if (selected === 'back') {
          continue;
        }

        await this.handleChatCommand(`/telegram approve ${selected}`, 'cli', channelId);
        continue;
      }

      if (action === 'reject') {
        const pending = getTelegramPendingRequests(config);
        const selected = await selectFromUsers(
          'Reject Telegram Request',
          pending,
          'There are no pending Telegram requests to reject.',
        );

        if (selected === 'back') {
          continue;
        }

        const request = pending.find((entry) => (entry.pairingCode || entry.userId.toString()) === selected);
        if (!request) {
          await channel.send('That Telegram request is no longer pending.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram reject ${request.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'remove') {
        const approved = getTelegramApprovedUsers(config);
        const selected = await selectFromUsers(
          'Remove Telegram User',
          approved,
          'There are no approved Telegram users to remove.',
        );

        if (selected === 'back') {
          continue;
        }

        const user = approved.find((entry) => entry.userId.toString() === selected);
        if (!user) {
          await channel.send('That Telegram user is no longer approved.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram remove ${user.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'promote') {
        const members = config.channels.telegram.members;
        const selected = await selectFromUsers(
          'Promote Telegram Member',
          members,
          'There are no Telegram members available to promote.',
        );

        if (selected === 'back') {
          continue;
        }

        const member = members.find((entry) => entry.userId.toString() === selected);
        if (!member) {
          await channel.send('That Telegram member is no longer available.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram promote ${member.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'demote') {
        const admins = config.channels.telegram.admins;
        const selected = await selectFromUsers(
          'Demote Telegram Admin',
          admins,
          'There are no Telegram admins available to demote.',
        );

        if (selected === 'back') {
          continue;
        }

        const admin = admins.find((entry) => entry.userId.toString() === selected);
        if (!admin) {
          await channel.send('That Telegram admin is no longer available.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram demote ${admin.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'reset') {
        const confirmation = await select('Reset Telegram Access?', [
          { value: 'cancel', label: 'Cancel' },
          { value: 'confirm', label: 'Reset all Telegram access' },
          { value: 'back', label: 'Back' },
        ]);

        if (confirmation === 'confirm') {
          clearTelegramAccess(config);
          saveConfig(config);
          await channel.send('Telegram access reset. New users can send /start to begin pairing again.', channelId);
        }

        continue;
      }
    }
  }
}

