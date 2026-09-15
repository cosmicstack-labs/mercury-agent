import type { ProviderName } from '../utils/config.js';

/**
 * Mercury Bots — persistent persona-scoped agents (see BOTS-ARCHITECTURE.md).
 *
 * A bot is a profile directory (`~/.mercury/bots/<botId>/`) plus a runtime.
 * This file defines the on-disk manifest types; runtime state lives in
 * bot-manager.ts.
 */

export type BotMemoryScope = 'none' | 'own' | 'shared-read';

export type BotTrigger = 'chat' | 'mailbox' | 'cron' | 'api' | 'cloud' | 'telegram' | 'web';

export type BotRunState = 'completed' | 'failed' | 'halted' | 'paused' | 'denied';

export interface BotModelSelection {
  /** Provider name from the ProviderRegistry; unset = inherit main default. */
  provider?: ProviderName;
  /** Model slug override for the selected provider. */
  model?: string;
}

export interface BotToolAccess {
  /** Tools the bot may use. Empty/undefined = all tools except the deny list. */
  allow?: string[];
  /** Tools the bot must never use. Deny always wins over allow. */
  deny?: string[];
}

export interface BotMemoryConfig {
  /** none = stateless; own = private namespace (default); shared-read = also read listed bots. */
  scope: BotMemoryScope;
  /** Bot ids whose context this bot may search when scope is shared-read. */
  allowCrossBotRecall?: string[];
}

export interface BotCommsConfig {
  /** Bot ids this bot may message. Also injected into its system prompt as its roster. */
  canMessage?: string[];
}

export interface BotScheduleConfig {
  name: string;
  /** 5-field cron expression (node-cron syntax). */
  cron: string;
  prompt: string;
  /** Where the run's output lands. Default 'bot-chat'. */
  deliver?: 'bot-chat' | 'telegram' | 'none';
  /**
   * Cheap pre-check command; if it exits non-zero (nothing changed), the LLM
   * is skipped entirely (Hermes' wakeAgent gate pattern).
   */
  gateScript?: string;
}

export interface BotAutonomyConfig {
  maxConcurrent?: number;
  maxSteps?: number;
  /** Hard daily token cap. Exceeded → the bot pauses until the next day. */
  dailyTokenBudget?: number;
}

export interface BotRetentionConfig {
  transcriptRuns?: number;
  journalRotateBytes?: number;
  journalKeepRotations?: number;
  mailboxTtlHours?: number;
  dlqCap?: number;
  artifactQuotaBytes?: number;
}

/**
 * The machine-readable bot manifest — `~/.mercury/bots/<id>/bot.yaml`.
 * The persona lives in `persona.md`; tool path scopes in `permissions.yaml`.
 */
export interface BotManifest {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Persona file name inside the bot dir. Default 'persona.md'. */
  persona?: string;
  model?: BotModelSelection;
  tools?: BotToolAccess;
  memory?: BotMemoryConfig;
  comms?: BotCommsConfig;
  schedules?: BotScheduleConfig[];
  autonomy?: BotAutonomyConfig;
  retention?: BotRetentionConfig;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Per-bot permission manifest — `~/.mercury/bots/<id>/permissions.yaml`.
 * Deliberately minimal: bots are fail-closed, so only explicit grants exist.
 * There are no auto-approve lists for bots by design (P0-4 wires this into a
 * bot-local PermissionManager).
 */
export interface BotPermissionsFile {
  paths?: BotPathScope[];
  blockedCommands?: string[];
}

export interface BotPathScope {
  /** Directory (relative to cwd, or absolute) the bot may touch. */
  scope: string;
  read?: boolean;
  write?: boolean;
}

/** One journal entry — the permanent compact record of a bot run. */
export interface BotRunRecord {
  runId: string;
  botId: string;
  trigger: BotTrigger;
  state: BotRunState;
  startedAt: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  summary?: string;
  error?: string;
  /** Typed failure code surfaced to senders/channels (e.g. provider_rate_limit). */
  reasonCode?: string;
}

/** Live bot state surfaced by /bots, the status bar, and the API. */
export type BotLiveState = 'disabled' | 'idle' | 'queued' | 'running' | 'paused';

export interface BotStatusSummary {
  id: string;
  name: string;
  enabled: boolean;
  state: BotLiveState;
  activity?: string;
  lastRunAt?: number;
  lastRunState?: BotRunState;
  needsYou: boolean;
}