/**
 * Replay fixture format (ROADMAP P2.3).
 *
 * A fixture is plain data: the conversation so far, the incoming message,
 * the programming mode, the scripted model steps (text or tool calls with
 * recorded results) and the expectations. The runner drives the REAL agent
 * loop with it — nothing in the loop is mocked except the model and the
 * tool outputs that were recorded.
 */
import type { ChannelType } from '../types/channel.js';

export interface ScriptedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface ScriptedToolCall {
  /** Tool name as registered in CapabilityRegistry (write_file, run_command, …). */
  tool: string;
  /** Must satisfy the real tool's input schema — the SDK validates it. */
  input: Record<string, unknown>;
  /**
   * Recorded tool output. When present the real tool is NOT executed and
   * this is returned verbatim; when absent the real tool runs in the
   * scenario's scratch cwd (auto-approved).
   */
  result?: unknown;
}

export type ScriptedStep =
  | { kind: 'text'; text: string; usage?: ScriptedUsage; finishReason?: 'stop' | 'length' }
  | { kind: 'tools'; calls: ScriptedToolCall[]; text?: string; usage?: ScriptedUsage };

export interface ScriptedProviderSpec {
  name: string;
  model?: string;
  /** The first N model calls to this provider throw `failWith`. */
  failFirst?: number;
  failWith?: string;
}

export interface FixtureHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  /** 'tool-call' seeds a prior-turn tool trace entry (see core/context-window.ts). */
  kind?: 'message' | 'tool-call';
}

export type PauseKind = 'steps' | 'work-not-started' | 'verification-failed';

export interface TurnExpectations {
  /** Number of persistent (delivered) messages, not status notices. */
  deliveredCount?: number;
  finalTextIncludes?: string[];
  finalTextExcludes?: string[];
  /** Must appear in SOME channel event (delivered or notice). */
  anyEventIncludes?: string[];
  /** Must appear in NO channel event. */
  noEventIncludes?: string[];
  providerCalls?: number;
  forcedActionRounds?: number;
  verificationRounds?: number;
  stepBudgetContinuations?: number;
  pause?: PauseKind | null;
  usedProvider?: string;
  /** Tool names that must have been invoked, in order of first use. */
  toolsUsed?: string[];
}

export interface ScenarioTurn {
  message: string;
  /** Scripted model output, consumed one step per model call. */
  steps?: ScriptedStep[];
  /** Supplies a step when the script runs out (e.g. endless tool loops). */
  onExhausted?: (callIndex: number) => ScriptedStep;
  /** Answer the agent gets from `askToContinue` prompts (default false). */
  askToContinue?: boolean;
  timeoutMs?: number;
  expect?: TurnExpectations;
}

export interface ScenarioFixture {
  name: string;
  channel?: {
    /** Default 'telegram' — exercises the messaging TaskSurface. */
    type?: ChannelType;
    /** 'messaging' implements the Telegram-style task/status-card contract. */
    style?: 'messaging' | 'plain';
    /** Streaming delivery (default true, matching the real Telegram default). */
    streaming?: boolean;
    id?: string;
  };
  programmingMode?: 'off' | 'plan' | 'execute';
  /** Default: one provider named 'scripted'. Order = fallback order. */
  providers?: ScriptedProviderSpec[];
  /** Seeded into the bound session before the first turn. */
  history?: FixtureHistoryEntry[];
  turns: ScenarioTurn[];
}

// ── Small builders so fixtures stay readable ────────────────────────────────

export function textStep(text: string, usage?: ScriptedUsage): ScriptedStep {
  return { kind: 'text', text, usage };
}

export function toolStep(calls: ScriptedToolCall[], text?: string, usage?: ScriptedUsage): ScriptedStep {
  return { kind: 'tools', calls, text, usage };
}

export function call(tool: string, input: Record<string, unknown>, result?: unknown): ScriptedToolCall {
  return { tool, input, result };
}

export const DEFAULT_USAGE: Required<ScriptedUsage> = { inputTokens: 120, outputTokens: 40, cachedInputTokens: 0 };
