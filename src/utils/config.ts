import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { config as loadDotenv } from 'dotenv';

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
      maxRecords: number;
    };
  };
  heartbeat: {
    intervalMinutes: number;
  };
  tokens: {
    dailyBudget: number;
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
        baseUrl: getEnv('OLLAMA_LOCAL_BASE_URL', 'http://127.0.0.1:11434/api'),
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
        maxRecords: getEnvNum('SECOND_BRAIN_MAX_RECORDS', 50),
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
  };
}

const CONFIG_PATH = join(getMercuryHome(), 'mercury.yaml');

export function loadConfig(): MercuryConfig {
  if (existsSync(CONFIG_PATH)) {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const fileConfig = parseYaml(raw) as Partial<MercuryConfig>;
    const defaults = getDefaultConfig();
    return migrateLegacyOllamaCloudBaseUrl(
      migrateLegacyTelegramAccess(deepMerge(defaults, fileConfig)),
    );
  }
  return migrateLegacyTelegramAccess(getDefaultConfig());
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
