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
  /**
   * Retention janitor for the fleet-shared folder (`_shared/`): files cool
   * down into `_shared/.archive/<yyyy-mm>/` past the hot window, and the
   * archive expires after the archive window. Deliverables moved via
   * `bot_deliver` into `outputs/` are exempt. Enabled by default.
   */
  sandboxJanitor?: {
    enabled?: boolean;
    /** Days a file stays in the working surface (default 7). */
    hotDays?: number;
    /** Days an archived file survives before deletion (default 30). */
    archiveDays?: number;
  };
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
  /**
   * Fleet hierarchy (absent = solo bot, zero drift for existing bots).
   * lead = orchestrates a crew; crew = member of a lead's fleet.
   */
  fleetRole?: 'lead' | 'crew';
  /** Crew bots only: the lead's id. Leads and solos never set this. */
  parent?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Per-bot permission manifest — `~/.mercury/bots/<id>/permissions.yaml`.
 * THE single source of truth for what a bot may do (tool gate + path scopes
 * + shell lists) — bot.yaml carries identity/fleet/schedules only, and the
 * persona carries character only. Deliberately minimal: bots are
 * fail-closed, so only explicit grants exist.
 */
export interface BotPermissionsFile {
  paths?: BotPathScope[];
  blockedCommands?: string[];
  /**
   * Shell command patterns this bot may run without approval (e.g.
   * ["node *", "python3 *"]). Each is merged into the bot registry's
   * shell.autoApproved list and checked per pipeline segment; the global
   * blocked-command list still wins, and patterns also present in
   * needsApproval are treated as denied (needsApproval wins). The literal
   * "*" (allow-all) is rejected.
   */
  autoApproveCommands?: string[];
  /**
   * The tool gate — which capability tools the bot sees at all. Deny wins
   * over allow; a non-empty allow restricts the toolset to exactly that
   * list. Interactive/global-mutation tools are stripped for bots regardless.
   * (Formerly bot.yaml's tools block — migrated here; bot.yaml is legacy.)
   */
  tools?: { allow?: string[]; deny?: string[] };
}

export interface BotPathScope {
  /** Directory (relative to cwd, or absolute) the bot may touch. */
  scope: string;
  read?: boolean;
  write?: boolean;
  /**
   * May run shell commands whose path arguments lie inside this scope
   * (fail-closed bots only; the global blocked-command list still wins).
   */
  execute?: boolean;
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
  /** Escalation marker: this run needs the owner (DLQ'd failure / crash).
   * The newest row's flag is the durable "needs you" state across restarts. */
  needsYou?: boolean;
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
  /** Fleet hierarchy: 'lead' | 'crew' | undefined (solo). */
  fleetRole?: 'lead' | 'crew';
  /** Crew bots: their lead's id. */
  parent?: string;
  /** Leads: how many crew are currently running a turn. */
  crewWorking?: number;
}