import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { config as loadDotenv } from 'dotenv';
import type { SignalAccessUser, SignalPendingRequest, DiscordAccessUser, DiscordPendingRequest, SlackAccessUser, SlackPendingRequest } from '../types/channel.js';

const MERCURY_HOME = join(homedir(), '.mercury');

loadDotenv();
const mercuryEnvPath = join(MERCURY_HOME, '.env');
if (existsSync(mercuryEnvPath)) {
  loadDotenv({ path: mercuryEnvPath });
}

export function getMercuryHome(): string {
  return process.env.MERCURY_HOME || MERCURY_HOME;
}

export function getMemoryDir(): string {
  return join(getMercuryHome(), 'memory');
}

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
}

export interface TelegramAccessUser {
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  requestedAt?: string;
  approvedAt: string;
}

export interface TelegramPendingRequest {
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  requestedAt: string;
  pairingCode?: string;
}

export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'grok'
  | 'ollamaCloud'
  | 'ollamaLocal'
  | 'openaiCompat'
  | 'mimo'
  | 'mimoTokenPlan'
  | 'chatgptWeb'
  | 'githubCopilot';

export interface MercuryConfig {
  identity: {
    name: string;
    owner: string;
    creator?: string;
  };
  providers: {
    default: ProviderName;
    openai: ProviderConfig;
    anthropic: ProviderConfig;
    deepseek: ProviderConfig;
    grok: ProviderConfig;
    ollamaCloud: ProviderConfig;
    ollamaLocal: ProviderConfig;
    openaiCompat: ProviderConfig;
    mimo: ProviderConfig;
    mimoTokenPlan: ProviderConfig;
    chatgptWeb: ProviderConfig;
    githubCopilot: ProviderConfig;
  };
  channels: {
    telegram: {
      enabled: boolean;
      botToken: string;
      webhookUrl?: string;
      allowedChatIds?: number[];
      streaming?: boolean;
      admins: TelegramAccessUser[];
      members: TelegramAccessUser[];
      pending: TelegramPendingRequest[];
      pairedUserId?: number;
      pairedChatId?: number;
      pairedUsername?: string;
    };
    signal: {
      enabled: boolean;
      phoneNumber: string;
      mode: string;
      groupId?: string;
      groupName?: string;
      admins: SignalAccessUser[];
      members: SignalAccessUser[];
      pending: SignalPendingRequest[];
    };
    discord: {
      enabled: boolean;
      botToken: string;
      guildId?: string;
      channelId?: string;
      adminRoleName?: string;
      streaming?: boolean;
      admins: DiscordAccessUser[];
      members: DiscordAccessUser[];
      pending: DiscordPendingRequest[];
    };
    slack: {
      enabled: boolean;
      botToken: string;
      appToken: string;
      channelId?: string;
      teamId?: string;
      streaming?: boolean;
      admins: SlackAccessUser[];
      members: SlackAccessUser[];
      pending: SlackPendingRequest[];
    };
  };
  github: {
    username: string;
    email: string;
    defaultOwner: string;
    defaultRepo: string;
  };
  memory: {
    shortTermMaxMessages: number;
    secondBrain: {
      enabled: boolean;
    };
  };
  heartbeat: {
    intervalMinutes: number;
  };
  tokens: {
    dailyBudget: number;
    /** When true, Token Saver Mode is manually enabled. Persisted. */
    saverMode?: boolean;
    /** Percentage of daily budget at which saver auto-engages (0 disables). */
    saverAutoThreshold?: number;
    /** Master switch for automatic engagement (defaults to true). */
    saverAutoEnabled?: boolean;
    /** Lifetime estimated tokens saved by saver mode (informational). */
    saverTokensSavedLifetime?: number;
  };
  subagents: {
    enabled: boolean;
    maxConcurrent: number;
    mode: 'auto' | 'manual';
  };
  spotify: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scopes: string[];
    deviceId: string;
    accountName: string;
    accountId: string;
    product: string;
  };
  web: {
    enabled: boolean;
    port: number;
  };
}

function getEnv(key: string, fallback: string = ''): string {
  return process.env[key] || fallback;
}

function getEnvNum(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

function getEnvBool(key: string, fallback: boolean): boolean {
  const val = process.env[key]?.toLowerCase();
  if (val === 'true') return true;
  if (val === 'false') return false;
  return fallback;
}

export function getDefaultConfig(): MercuryConfig {
  const home = getMercuryHome();
  return {
    identity: {
      name: getEnv('MERCURY_NAME', 'Mercury'),
      owner: getEnv('MERCURY_OWNER', ''),
      creator: getEnv('MERCURY_CREATOR', ''),
    },
    providers: {
      default: getEnv('DEFAULT_PROVIDER', 'deepseek') as ProviderName,
      openai: {
        name: 'openai',
        apiKey: getEnv('OPENAI_API_KEY', ''),
        baseUrl: getEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        model: getEnv('OPENAI_MODEL', 'gpt-4o-mini'),
        enabled: getEnvBool('OPENAI_ENABLED', true),
      },
      anthropic: {
        name: 'anthropic',
        apiKey: getEnv('ANTHROPIC_API_KEY', ''),
        baseUrl: getEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
        model: getEnv('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
        enabled: getEnvBool('ANTHROPIC_ENABLED', true),
      },
      deepseek: {
        name: 'deepseek',
        apiKey: getEnv('DEEPSEEK_API_KEY', ''),
        baseUrl: getEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
        model: getEnv('DEEPSEEK_MODEL', 'deepseek-chat'),
        enabled: getEnvBool('DEEPSEEK_ENABLED', true),
      },
      grok: {
        name: 'grok',
        apiKey: getEnv('GROK_API_KEY', ''),
        baseUrl: getEnv('GROK_BASE_URL', 'https://api.x.ai/v1'),
        model: getEnv('GROK_MODEL', 'grok-4'),
        enabled: getEnvBool('GROK_ENABLED', true),
      },
      ollamaCloud: {
        name: 'ollamaCloud',
        apiKey: getEnv('OLLAMA_CLOUD_API_KEY', ''),
        baseUrl: getEnv('OLLAMA_CLOUD_BASE_URL', 'https://ollama.com/v1'),
        model: getEnv('OLLAMA_CLOUD_MODEL', 'gpt-oss:120b'),
        enabled: getEnvBool('OLLAMA_CLOUD_ENABLED', true),
      },
      ollamaLocal: {
        name: 'ollamaLocal',
        apiKey: '',
        baseUrl: getEnv('OLLAMA_LOCAL_BASE_URL', 'http://127.0.0.1:11434/v1'),
        model: getEnv('OLLAMA_LOCAL_MODEL', ''),
        enabled: getEnvBool('OLLAMA_LOCAL_ENABLED', false),
      },
      openaiCompat: {
        name: 'openaiCompat',
        apiKey: getEnv('OPENAI_COMPAT_API_KEY', ''),
        baseUrl: getEnv('OPENAI_COMPAT_BASE_URL', ''),
        model: getEnv('OPENAI_COMPAT_MODEL', ''),
        enabled: getEnvBool('OPENAI_COMPAT_ENABLED', false),
      },
      mimo: {
        name: 'mimo',
        apiKey: getEnv('MIMO_API_KEY', ''),
        baseUrl: getEnv('MIMO_BASE_URL', 'https://api.xiaomimimo.com/v1'),
        model: getEnv('MIMO_MODEL', 'mimo-v2.5-pro'),
        enabled: getEnvBool('MIMO_ENABLED', true),
      },
      mimoTokenPlan: {
        name: 'mimoTokenPlan',
        apiKey: getEnv('MIMO_TOKEN_PLAN_API_KEY', ''),
        baseUrl: getEnv('MIMO_TOKEN_PLAN_BASE_URL', 'https://token-plan-cn.xiaomimimo.com/v1'),
        model: getEnv('MIMO_TOKEN_PLAN_MODEL', 'mimo-v2.5-pro'),
        enabled: getEnvBool('MIMO_TOKEN_PLAN_ENABLED', false),
      },
      chatgptWeb: {
        name: 'chatgptWeb',
        apiKey: '', // not used — auth is via OAuth
        baseUrl: 'https://chatgpt.com/backend-api',
        model: getEnv('CHATGPT_WEB_MODEL', 'gpt-5.4-mini'),
        enabled: getEnvBool('CHATGPT_WEB_ENABLED', false),
      },
      githubCopilot: {
        name: 'githubCopilot',
        apiKey: '', // not used — auth is via GitHub OAuth
        baseUrl: '', // dynamic — resolved from Copilot token exchange
        model: getEnv('GITHUB_COPILOT_MODEL', 'gpt-4o'),
        enabled: getEnvBool('GITHUB_COPILOT_ENABLED', false),
      },
    },
    channels: {
      telegram: {
        enabled: getEnvBool('TELEGRAM_ENABLED', false),
        botToken: getEnv('TELEGRAM_BOT_TOKEN', ''),
        webhookUrl: getEnv('TELEGRAM_WEBHOOK_URL', ''),
        allowedChatIds: getEnv('TELEGRAM_ALLOWED_CHAT_IDS', '')
          .split(',')
          .filter(Boolean)
          .map(Number),
        streaming: getEnvBool('TELEGRAM_STREAMING', true),
        admins: [],
        members: [],
        pending: [],
      },
      signal: {
        enabled: getEnvBool('SIGNAL_ENABLED', false),
        phoneNumber: getEnv('SIGNAL_PHONE_NUMBER', ''),
        mode: getEnv('SIGNAL_MODE', 'group'),
        groupId: getEnv('SIGNAL_GROUP_ID', ''),
        groupName: getEnv('SIGNAL_GROUP_NAME', 'Mercury'),
        admins: [],
        members: [],
        pending: [],
      },
      discord: {
        enabled: getEnvBool('DISCORD_ENABLED', false),
        botToken: getEnv('DISCORD_BOT_TOKEN', ''),
        guildId: getEnv('DISCORD_GUILD_ID', ''),
        channelId: getEnv('DISCORD_CHANNEL_ID', ''),
        adminRoleName: getEnv('DISCORD_ADMIN_ROLE_NAME', 'Mercury Admin'),
        streaming: getEnvBool('DISCORD_STREAMING', true),
        admins: [],
        members: [],
        pending: [],
      },
      slack: {
        enabled: getEnvBool('SLACK_ENABLED', false),
        botToken: getEnv('SLACK_BOT_TOKEN', ''),
        appToken: getEnv('SLACK_APP_TOKEN', ''),
        channelId: getEnv('SLACK_CHANNEL_ID', ''),
        teamId: getEnv('SLACK_TEAM_ID', ''),
        streaming: getEnvBool('SLACK_STREAMING', true),
        admins: [],
        members: [],
        pending: [],
      },
    },
    github: {
      username: getEnv('GITHUB_USERNAME', ''),
      email: getEnv('GITHUB_EMAIL', 'mercury@cosmicstack.org'),
      defaultOwner: getEnv('GITHUB_DEFAULT_OWNER', ''),
      defaultRepo: getEnv('GITHUB_DEFAULT_REPO', ''),
    },
    memory: {
      shortTermMaxMessages: getEnvNum('SHORT_TERM_MAX_MESSAGES', 20),
      secondBrain: {
        enabled: getEnvBool('SECOND_BRAIN_ENABLED', true),
      },
    },
    heartbeat: {
      intervalMinutes: getEnvNum('HEARTBEAT_INTERVAL_MINUTES', 60),
    },
    tokens: {
      dailyBudget: getEnvNum('DAILY_TOKEN_BUDGET', 1_000_000),
    },
    subagents: {
      enabled: getEnvBool('SUBAGENTS_ENABLED', true),
      maxConcurrent: getEnvNum('SUBAGENTS_MAX_CONCURRENT', 0),
      mode: (process.env.SUBAGENTS_MODE as 'auto' | 'manual') || 'auto',
    },
    spotify: {
      enabled: getEnvBool('SPOTIFY_ENABLED', false),
      clientId: getEnv('SPOTIFY_CLIENT_ID'),
      clientSecret: getEnv('SPOTIFY_CLIENT_SECRET'),
      redirectUri: getEnv('SPOTIFY_REDIRECT_URI', 'http://127.0.0.1:8888/callback'),
      accessToken: '',
      refreshToken: '',
      expiresAt: '',
      scopes: [],
      deviceId: '',
      accountName: '',
      accountId: '',
      product: '',
    },
    web: {
      enabled: getEnvBool('MERCURY_WEB_ENABLED', false),
      port: getEnvNum('MERCURY_PORT', 6174),
    },
  };
}

const CONFIG_PATH = join(getMercuryHome(), 'mercury.yaml');

export function loadConfig(): MercuryConfig {
  if (existsSync(CONFIG_PATH)) {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const fileConfig = parseYaml(raw) as Partial<MercuryConfig>;
    const defaults = getDefaultConfig();
    return migrateLegacyDiscordAccess(
      migrateLegacyOllamaLocalBaseUrl(
        migrateLegacyOllamaCloudBaseUrl(
          migrateLegacySignalAccess(
            migrateLegacyTelegramAccess(deepMerge(defaults, fileConfig)),
          ),
        ),
      ),
    );
  }
  return migrateLegacyDiscordAccess(
    migrateLegacyTelegramAccess(getDefaultConfig()),
  );
}

export function saveConfig(config: MercuryConfig): void {
  const dir = getMercuryHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, stringifyYaml(config), 'utf-8');
}

export function isSetupComplete(): boolean {
  if (!existsSync(CONFIG_PATH)) return false;
  const config = loadConfig();
  return config.identity.owner.length > 0;
}

export function ensureCreatorField(config: MercuryConfig): MercuryConfig {
  if (!config.identity.creator && config.identity.owner) {
    config.identity.creator = 'Cosmic Stack';
    saveConfig(config);
  }
  return config;
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    if (source[key] !== undefined && source[key] !== null) {
      if (
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        result[key] = deepMerge(
          target[key] as Record<string, any>,
          source[key] as Record<string, any>
        ) as T[Extract<keyof T, string>];
      } else {
        result[key] = source[key] as T[Extract<keyof T, string>];
      }
    }
  }
  return result;
}

export function getActiveProviders(config: MercuryConfig): ProviderConfig[] {
  return Object.values(config.providers)
    .filter((p): p is ProviderConfig => typeof p === 'object' && isProviderConfigured(p));
}

export function isProviderConfigured(provider: ProviderConfig): boolean {
  if (!provider.enabled) return false;
  if (provider.name === 'ollamaLocal') {
    return provider.baseUrl.length > 0 && provider.model.length > 0;
  }
  if (provider.name === 'ollamaCloud') {
    return provider.apiKey.length > 0 && provider.baseUrl.length > 0;
  }
  if (provider.name === 'openaiCompat') {
    return provider.baseUrl.length > 0 && provider.model.length > 0;
  }
  if (provider.name === 'chatgptWeb') {
    // ChatGPT Web uses browser session auth, not API keys.
    // Considered "configured" if enabled with a model selected.
    // Actual session validity is checked at runtime via isAvailable().
    return provider.model.length > 0;
  }
  if (provider.name === 'githubCopilot') {
    // GitHub Copilot uses GitHub OAuth, not API keys.
    // Considered "configured" if enabled with a model selected.
    return provider.model.length > 0;
  }
  return provider.apiKey.length > 0;
}

export function getTelegramApprovedUsers(config: MercuryConfig): TelegramAccessUser[] {
  return [
    ...config.channels.telegram.admins,
    ...config.channels.telegram.members,
  ];
}

export function getTelegramApprovedChatIds(config: MercuryConfig): number[] {
  return [...new Set(getTelegramApprovedUsers(config).map((user) => user.chatId))];
}

export function getTelegramAdmins(config: MercuryConfig): TelegramAccessUser[] {
  return config.channels.telegram.admins;
}

export function getTelegramPendingRequests(config: MercuryConfig): TelegramPendingRequest[] {
  return config.channels.telegram.pending;
}

export function findTelegramApprovedUser(config: MercuryConfig, userId: number): TelegramAccessUser | undefined {
  return getTelegramApprovedUsers(config).find((user) => user.userId === userId);
}

export function findTelegramAdmin(config: MercuryConfig, userId: number): TelegramAccessUser | undefined {
  return config.channels.telegram.admins.find((user) => user.userId === userId);
}

export function findTelegramPendingRequest(config: MercuryConfig, userId: number): TelegramPendingRequest | undefined {
  return config.channels.telegram.pending.find((request) => request.userId === userId);
}

export function findTelegramPendingRequestByPairingCode(
  config: MercuryConfig,
  pairingCode: string,
): TelegramPendingRequest | undefined {
  return config.channels.telegram.pending.find((request) => request.pairingCode === pairingCode);
}

export function hasTelegramAdmins(config: MercuryConfig): boolean {
  return config.channels.telegram.admins.length > 0;
}

export function getTelegramAccessSummary(config: MercuryConfig): string {
  return `${config.channels.telegram.admins.length} admin${config.channels.telegram.admins.length === 1 ? '' : 's'}, `
    + `${config.channels.telegram.members.length} member${config.channels.telegram.members.length === 1 ? '' : 's'}, `
    + `${config.channels.telegram.pending.length} pending`;
}

export function addTelegramPendingRequest(
  config: MercuryConfig,
  request: Omit<TelegramPendingRequest, 'requestedAt'> & { requestedAt?: string },
): TelegramPendingRequest {
  const existing = findTelegramPendingRequest(config, request.userId);
  if (existing) {
    existing.chatId = request.chatId;
    existing.username = request.username || existing.username;
    existing.firstName = request.firstName || existing.firstName;
    existing.pairingCode = request.pairingCode || existing.pairingCode;
    return existing;
  }

  const created: TelegramPendingRequest = {
    ...request,
    requestedAt: request.requestedAt || new Date().toISOString(),
  };
  config.channels.telegram.pending.push(created);
  return created;
}

export function approveTelegramPendingRequest(
  config: MercuryConfig,
  userId: number,
  role: 'admin' | 'member' = 'member',
): TelegramAccessUser | null {
  const request = findTelegramPendingRequest(config, userId);
  if (!request) return null;

  const approvedUser: TelegramAccessUser = {
    userId: request.userId,
    chatId: request.chatId,
    username: request.username,
    firstName: request.firstName,
    requestedAt: request.requestedAt,
    approvedAt: new Date().toISOString(),
  };

  config.channels.telegram.pending = config.channels.telegram.pending
    .filter((entry) => entry.userId !== userId);
  config.channels.telegram.admins = config.channels.telegram.admins
    .filter((entry) => entry.userId !== userId);
  config.channels.telegram.members = config.channels.telegram.members
    .filter((entry) => entry.userId !== userId);

  if (role === 'admin') {
    config.channels.telegram.admins.push(approvedUser);
  } else {
    config.channels.telegram.members.push(approvedUser);
  }

  return approvedUser;
}

export function approveTelegramPendingRequestByPairingCode(
  config: MercuryConfig,
  pairingCode: string,
): TelegramAccessUser | null {
  const request = findTelegramPendingRequestByPairingCode(config, pairingCode);
  if (!request) return null;
  const role = hasTelegramAdmins(config) ? 'member' : 'admin';
  return approveTelegramPendingRequest(config, request.userId, role);
}

export function rejectTelegramPendingRequest(config: MercuryConfig, userId: number): TelegramPendingRequest | null {
  const request = findTelegramPendingRequest(config, userId);
  if (!request) return null;
  config.channels.telegram.pending = config.channels.telegram.pending
    .filter((entry) => entry.userId !== userId);
  return request;
}

export function removeTelegramUser(config: MercuryConfig, userId: number): TelegramAccessUser | null {
  const admin = config.channels.telegram.admins.find((entry) => entry.userId === userId);
  if (admin) {
    config.channels.telegram.admins = config.channels.telegram.admins
      .filter((entry) => entry.userId !== userId);
    return admin;
  }

  const member = config.channels.telegram.members.find((entry) => entry.userId === userId);
  if (member) {
    config.channels.telegram.members = config.channels.telegram.members
      .filter((entry) => entry.userId !== userId);
    return member;
  }

  return null;
}

export function promoteTelegramUserToAdmin(config: MercuryConfig, userId: number): TelegramAccessUser | null {
  const member = config.channels.telegram.members.find((entry) => entry.userId === userId);
  if (!member) return null;
  config.channels.telegram.members = config.channels.telegram.members
    .filter((entry) => entry.userId !== userId);
  config.channels.telegram.admins.push(member);
  return member;
}

export function demoteTelegramAdmin(config: MercuryConfig, userId: number): TelegramAccessUser | null {
  if (config.channels.telegram.admins.length <= 1) {
    return null;
  }

  const admin = config.channels.telegram.admins.find((entry) => entry.userId === userId);
  if (!admin) return null;
  config.channels.telegram.admins = config.channels.telegram.admins
    .filter((entry) => entry.userId !== userId);
  config.channels.telegram.members.push(admin);
  return admin;
}

export function clearTelegramAccess(config: MercuryConfig): MercuryConfig {
  config.channels.telegram.admins = [];
  config.channels.telegram.members = [];
  config.channels.telegram.pending = [];
  delete config.channels.telegram.pairedUserId;
  delete config.channels.telegram.pairedChatId;
  delete config.channels.telegram.pairedUsername;
  return config;
}

export function clearTelegramPairing(config: MercuryConfig): MercuryConfig {
  return clearTelegramAccess(config);
}

export function migrateLegacyTelegramAccess(config: MercuryConfig): MercuryConfig {
  const telegram = config.channels.telegram;
  telegram.admins = telegram.admins || [];
  telegram.members = telegram.members || [];
  telegram.pending = telegram.pending || [];

  if (
    telegram.admins.length === 0
    && telegram.members.length === 0
    && typeof telegram.pairedUserId === 'number'
    && typeof telegram.pairedChatId === 'number'
  ) {
    telegram.admins.push({
      userId: telegram.pairedUserId,
      chatId: telegram.pairedChatId,
      username: telegram.pairedUsername,
      approvedAt: new Date().toISOString(),
    });
  }

  delete telegram.pairedUserId;
  delete telegram.pairedChatId;
  delete telegram.pairedUsername;

  return config;
}

export function migrateLegacyOllamaCloudBaseUrl(config: MercuryConfig): MercuryConfig {
  if (config.providers.ollamaCloud.baseUrl === 'https://ollama.com/api') {
    config.providers.ollamaCloud.baseUrl = 'https://ollama.com/v1';
    saveConfig(config);
  }
  return config;
}

/**
 * Migrate local Ollama base URL from the legacy /api endpoint to /v1.
 * Ollama has supported /v1 (OpenAI-compatible) since v0.1.14, and the
 * /api endpoint is incompatible with AI SDK v6+ when used through
 * ollama-ai-provider (which declares spec version v1).
 */
export function migrateLegacyOllamaLocalBaseUrl(config: MercuryConfig): MercuryConfig {
  const local = config.providers.ollamaLocal.baseUrl;
  if (local === 'http://127.0.0.1:11434/api' || local === 'http://localhost:11434/api') {
    config.providers.ollamaLocal.baseUrl = local.replace('/api', '/v1');
    saveConfig(config);
  }
  return config;
}

// ── Signal access helpers ────────────────────────────────────────

export function getSignalApprovedUsers(config: MercuryConfig): SignalAccessUser[] {
  return [...config.channels.signal.admins, ...config.channels.signal.members];
}

export function findSignalAdmin(config: MercuryConfig, phoneNumber: string): SignalAccessUser | undefined {
  return config.channels.signal.admins.find((u) => u.phoneNumber === phoneNumber);
}

export function findSignalApprovedUser(config: MercuryConfig, phoneNumber: string): SignalAccessUser | undefined {
  return getSignalApprovedUsers(config).find((u) => u.phoneNumber === phoneNumber);
}

export function findSignalPendingRequest(config: MercuryConfig, phoneNumber: string): SignalPendingRequest | undefined {
  return config.channels.signal.pending.find((r) => r.phoneNumber === phoneNumber);
}

export function findSignalPendingRequestByPairingCode(config: MercuryConfig, pairingCode: string): SignalPendingRequest | undefined {
  return config.channels.signal.pending.find((r) => r.pairingCode === pairingCode);
}

export function hasSignalAdmins(config: MercuryConfig): boolean {
  return config.channels.signal.admins.length > 0;
}

export function getSignalAccessSummary(config: MercuryConfig): string {
  return `${config.channels.signal.admins.length} admin${config.channels.signal.admins.length === 1 ? '' : 's'}, `
    + `${config.channels.signal.members.length} member${config.channels.signal.members.length === 1 ? '' : 's'}, `
    + `${config.channels.signal.pending.length} pending`;
}

export function addSignalPendingRequest(
  config: MercuryConfig,
  request: Omit<SignalPendingRequest, 'requestedAt'> & { requestedAt?: string },
): SignalPendingRequest {
  const existing = findSignalPendingRequest(config, request.phoneNumber);
  if (existing) {
    existing.pairingCode = request.pairingCode || existing.pairingCode;
    if (request.uuid) existing.uuid = request.uuid;
    if (request.name) existing.name = request.name;
    return existing;
  }

  const created: SignalPendingRequest = {
    ...request,
    requestedAt: request.requestedAt || new Date().toISOString(),
  };
  config.channels.signal.pending.push(created);
  return created;
}

export function approveSignalPendingRequest(
  config: MercuryConfig,
  phoneNumber: string,
  role: 'admin' | 'member' = 'member',
): SignalAccessUser | null {
  const request = findSignalPendingRequest(config, phoneNumber);
  if (!request) return null;

  const approvedUser: SignalAccessUser = {
    phoneNumber: request.phoneNumber,
    role,
    pairedAt: new Date().toISOString(),
  };

  config.channels.signal.pending = config.channels.signal.pending
    .filter((r) => r.phoneNumber !== phoneNumber);
  config.channels.signal.admins = config.channels.signal.admins
    .filter((u) => u.phoneNumber !== phoneNumber);
  config.channels.signal.members = config.channels.signal.members
    .filter((u) => u.phoneNumber !== phoneNumber);

  if (role === 'admin') {
    config.channels.signal.admins.push(approvedUser);
  } else {
    config.channels.signal.members.push(approvedUser);
  }

  return approvedUser;
}

export function approveSignalPendingRequestByPairingCode(
  config: MercuryConfig,
  pairingCode: string,
): SignalAccessUser | null {
  const request = findSignalPendingRequestByPairingCode(config, pairingCode);
  if (!request) return null;
  const role = hasSignalAdmins(config) ? 'member' : 'admin';
  return approveSignalPendingRequest(config, request.phoneNumber, role);
}

export function rejectSignalPendingRequest(config: MercuryConfig, phoneNumber: string): SignalPendingRequest | null {
  const request = findSignalPendingRequest(config, phoneNumber);
  if (!request) return null;
  config.channels.signal.pending = config.channels.signal.pending
    .filter((r) => r.phoneNumber !== phoneNumber);
  return request;
}

export function clearSignalAccess(config: MercuryConfig): MercuryConfig {
  config.channels.signal.admins = [];
  config.channels.signal.members = [];
  config.channels.signal.pending = [];
  delete config.channels.signal.groupId;
  delete config.channels.signal.groupName;
  return config;
}

export function migrateLegacySignalAccess(config: MercuryConfig): MercuryConfig {
  const signal = config.channels.signal;
  if (!signal) return config;
  signal.admins = signal.admins || [];
  signal.members = signal.members || [];
  signal.pending = signal.pending || [];
  return config;
}

// ── Discord access helpers ────────────────────────────────────────

export function getDiscordApprovedUsers(config: MercuryConfig): DiscordAccessUser[] {
  return [...config.channels.discord.admins, ...config.channels.discord.members];
}

export function getDiscordAdmins(config: MercuryConfig): DiscordAccessUser[] {
  return config.channels.discord.admins;
}

export function getDiscordPendingRequests(config: MercuryConfig): DiscordPendingRequest[] {
  return config.channels.discord.pending;
}

export function findDiscordApprovedUser(config: MercuryConfig, userId: string): DiscordAccessUser | undefined {
  return getDiscordApprovedUsers(config).find((u) => u.userId === userId);
}

export function findDiscordAdmin(config: MercuryConfig, userId: string): DiscordAccessUser | undefined {
  return config.channels.discord.admins.find((u) => u.userId === userId);
}

export function findDiscordPendingRequest(config: MercuryConfig, userId: string): DiscordPendingRequest | undefined {
  return config.channels.discord.pending.find((r) => r.userId === userId);
}

export function findDiscordPendingRequestByPairingCode(config: MercuryConfig, pairingCode: string): DiscordPendingRequest | undefined {
  return config.channels.discord.pending.find((r) => r.pairingCode === pairingCode);
}

export function hasDiscordAdmins(config: MercuryConfig): boolean {
  return config.channels.discord.admins.length > 0;
}

export function getDiscordAccessSummary(config: MercuryConfig): string {
  return `${config.channels.discord.admins.length} admin${config.channels.discord.admins.length === 1 ? '' : 's'}, `
    + `${config.channels.discord.members.length} member${config.channels.discord.members.length === 1 ? '' : 's'}, `
    + `${config.channels.discord.pending.length} pending`;
}

export function addDiscordPendingRequest(
  config: MercuryConfig,
  request: Omit<DiscordPendingRequest, 'requestedAt'> & { requestedAt?: string },
): DiscordPendingRequest {
  const existing = findDiscordPendingRequest(config, request.userId);
  if (existing) {
    existing.username = request.username || existing.username;
    existing.displayName = request.displayName || existing.displayName;
    existing.pairingCode = request.pairingCode || existing.pairingCode;
    return existing;
  }

  const created: DiscordPendingRequest = {
    ...request,
    requestedAt: request.requestedAt || new Date().toISOString(),
  };
  config.channels.discord.pending.push(created);
  return created;
}

export function approveDiscordPendingRequest(
  config: MercuryConfig,
  userId: string,
  role: 'admin' | 'member' = 'member',
): DiscordAccessUser | null {
  const request = findDiscordPendingRequest(config, userId);
  if (!request) return null;

  const approvedUser: DiscordAccessUser = {
    userId: request.userId,
    username: request.username,
    displayName: request.displayName,
    role,
    approvedAt: new Date().toISOString(),
  };

  config.channels.discord.pending = config.channels.discord.pending
    .filter((r) => r.userId !== userId);
  config.channels.discord.admins = config.channels.discord.admins
    .filter((u) => u.userId !== userId);
  config.channels.discord.members = config.channels.discord.members
    .filter((u) => u.userId !== userId);

  if (role === 'admin') {
    config.channels.discord.admins.push(approvedUser);
  } else {
    config.channels.discord.members.push(approvedUser);
  }

  return approvedUser;
}

export function approveDiscordPendingRequestByPairingCode(
  config: MercuryConfig,
  pairingCode: string,
): DiscordAccessUser | null {
  const request = findDiscordPendingRequestByPairingCode(config, pairingCode);
  if (!request) return null;
  const role = hasDiscordAdmins(config) ? 'member' : 'admin';
  return approveDiscordPendingRequest(config, request.userId, role);
}

export function rejectDiscordPendingRequest(config: MercuryConfig, userId: string): DiscordPendingRequest | null {
  const request = findDiscordPendingRequest(config, userId);
  if (!request) return null;
  config.channels.discord.pending = config.channels.discord.pending
    .filter((r) => r.userId !== userId);
  return request;
}

export function removeDiscordUser(config: MercuryConfig, userId: string): DiscordAccessUser | null {
  const admin = config.channels.discord.admins.find((u) => u.userId === userId);
  if (admin) {
    config.channels.discord.admins = config.channels.discord.admins
      .filter((u) => u.userId !== userId);
    return admin;
  }

  const member = config.channels.discord.members.find((u) => u.userId === userId);
  if (member) {
    config.channels.discord.members = config.channels.discord.members
      .filter((u) => u.userId !== userId);
    return member;
  }

  return null;
}

export function promoteDiscordUserToAdmin(config: MercuryConfig, userId: string): DiscordAccessUser | null {
  const member = config.channels.discord.members.find((u) => u.userId === userId);
  if (!member) return null;
  config.channels.discord.members = config.channels.discord.members
    .filter((u) => u.userId !== userId);
  config.channels.discord.admins.push(member);
  return member;
}

export function demoteDiscordAdmin(config: MercuryConfig, userId: string): DiscordAccessUser | null {
  if (config.channels.discord.admins.length <= 1) {
    return null;
  }

  const admin = config.channels.discord.admins.find((u) => u.userId === userId);
  if (!admin) return null;
  config.channels.discord.admins = config.channels.discord.admins
    .filter((u) => u.userId !== userId);
  config.channels.discord.members.push(admin);
  return admin;
}

export function clearDiscordAccess(config: MercuryConfig): MercuryConfig {
  config.channels.discord.admins = [];
  config.channels.discord.members = [];
  config.channels.discord.pending = [];
  return config;
}

export function migrateLegacyDiscordAccess(config: MercuryConfig): MercuryConfig {
  const discord = config.channels.discord;
  if (!discord) return config;
  discord.admins = discord.admins || [];
  discord.members = discord.members || [];
  discord.pending = discord.pending || [];
  return config;
}

// ── Slack access helpers ──────────────────────────────────────────

export function getSlackApprovedUsers(config: MercuryConfig): SlackAccessUser[] {
  return [...config.channels.slack.admins, ...config.channels.slack.members];
}

export function getSlackAdmins(config: MercuryConfig): SlackAccessUser[] {
  return config.channels.slack.admins;
}

export function getSlackPendingRequests(config: MercuryConfig): SlackPendingRequest[] {
  return config.channels.slack.pending;
}

export function findSlackApprovedUser(config: MercuryConfig, userId: string): SlackAccessUser | undefined {
  return getSlackApprovedUsers(config).find((u) => u.userId === userId);
}

export function findSlackAdmin(config: MercuryConfig, userId: string): SlackAccessUser | undefined {
  return config.channels.slack.admins.find((u) => u.userId === userId);
}

export function findSlackPendingRequest(config: MercuryConfig, userId: string): SlackPendingRequest | undefined {
  return config.channels.slack.pending.find((r) => r.userId === userId);
}

export function findSlackPendingRequestByPairingCode(config: MercuryConfig, pairingCode: string): SlackPendingRequest | undefined {
  return config.channels.slack.pending.find((r) => r.pairingCode === pairingCode);
}

export function hasSlackAdmins(config: MercuryConfig): boolean {
  return config.channels.slack.admins.length > 0;
}

export function getSlackAccessSummary(config: MercuryConfig): string {
  return `${config.channels.slack.admins.length} admin${config.channels.slack.admins.length === 1 ? '' : 's'}, `
    + `${config.channels.slack.members.length} member${config.channels.slack.members.length === 1 ? '' : 's'}, `
    + `${config.channels.slack.pending.length} pending`;
}

export function addSlackPendingRequest(
  config: MercuryConfig,
  request: Omit<SlackPendingRequest, 'requestedAt'> & { requestedAt?: string },
): SlackPendingRequest {
  const existing = findSlackPendingRequest(config, request.userId);
  if (existing) {
    existing.userName = request.userName || existing.userName;
    existing.displayName = request.displayName || existing.displayName;
    existing.pairingCode = request.pairingCode || existing.pairingCode;
    return existing;
  }

  const created: SlackPendingRequest = {
    ...request,
    requestedAt: request.requestedAt || new Date().toISOString(),
  };
  config.channels.slack.pending.push(created);
  return created;
}

export function approveSlackPendingRequest(
  config: MercuryConfig,
  userId: string,
  role: 'admin' | 'member' = 'member',
): SlackAccessUser | null {
  const request = findSlackPendingRequest(config, userId);
  if (!request) return null;

  const approvedUser: SlackAccessUser = {
    userId: request.userId,
    userName: request.userName,
    displayName: request.displayName,
    role,
    approvedAt: new Date().toISOString(),
  };

  config.channels.slack.pending = config.channels.slack.pending
    .filter((r) => r.userId !== userId);
  config.channels.slack.admins = config.channels.slack.admins
    .filter((u) => u.userId !== userId);
  config.channels.slack.members = config.channels.slack.members
    .filter((u) => u.userId !== userId);

  if (role === 'admin') {
    config.channels.slack.admins.push(approvedUser);
  } else {
    config.channels.slack.members.push(approvedUser);
  }

  return approvedUser;
}

export function approveSlackPendingRequestByPairingCode(
  config: MercuryConfig,
  pairingCode: string,
): SlackAccessUser | null {
  const request = findSlackPendingRequestByPairingCode(config, pairingCode);
  if (!request) return null;
  const role = hasSlackAdmins(config) ? 'member' : 'admin';
  return approveSlackPendingRequest(config, request.userId, role);
}

export function rejectSlackPendingRequest(config: MercuryConfig, userId: string): SlackPendingRequest | null {
  const request = findSlackPendingRequest(config, userId);
  if (!request) return null;
  config.channels.slack.pending = config.channels.slack.pending
    .filter((r) => r.userId !== userId);
  return request;
}

export function removeSlackUser(config: MercuryConfig, userId: string): SlackAccessUser | null {
  const admin = config.channels.slack.admins.find((u) => u.userId === userId);
  if (admin) {
    config.channels.slack.admins = config.channels.slack.admins
      .filter((u) => u.userId !== userId);
    return admin;
  }

  const member = config.channels.slack.members.find((u) => u.userId === userId);
  if (member) {
    config.channels.slack.members = config.channels.slack.members
      .filter((u) => u.userId !== userId);
    return member;
  }

  return null;
}

export function promoteSlackUserToAdmin(config: MercuryConfig, userId: string): SlackAccessUser | null {
  const member = config.channels.slack.members.find((u) => u.userId === userId);
  if (!member) return null;
  config.channels.slack.members = config.channels.slack.members
    .filter((u) => u.userId !== userId);
  config.channels.slack.admins.push(member);
  return member;
}

export function demoteSlackAdmin(config: MercuryConfig, userId: string): SlackAccessUser | null {
  if (config.channels.slack.admins.length <= 1) {
    return null;
  }

  const admin = config.channels.slack.admins.find((u) => u.userId === userId);
  if (!admin) return null;
  config.channels.slack.admins = config.channels.slack.admins
    .filter((u) => u.userId !== userId);
  config.channels.slack.members.push(admin);
  return admin;
}

export function clearSlackAccess(config: MercuryConfig): MercuryConfig {
  config.channels.slack.admins = [];
  config.channels.slack.members = [];
  config.channels.slack.pending = [];
  return config;
}

export function migrateLegacySlackAccess(config: MercuryConfig): MercuryConfig {
  const slack = config.channels.slack;
  if (!slack) return config;
  slack.admins = slack.admins || [];
  slack.members = slack.members || [];
  slack.pending = slack.pending || [];
  return config;
}
