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

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
}

export interface MercuryConfig {
  identity: {
    name: string;
    owner: string;
    creator?: string;
  };
  providers: {
    default: string;
    openai: ProviderConfig;
    anthropic: ProviderConfig;
    deepseek: ProviderConfig;
  };
  channels: {
    telegram: {
      enabled: boolean;
      botToken: string;
      webhookUrl?: string;
      allowedChatIds?: number[];
      streaming?: boolean;
    };
  };
  github: {
    username: string;
    email: string;
    defaultOwner: string;
    defaultRepo: string;
  };
  memory: {
    dir: string;
    shortTermMaxMessages: number;
  };
  heartbeat: {
    intervalMinutes: number;
  };
  tokens: {
    dailyBudget: number;
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
      default: getEnv('DEFAULT_PROVIDER', 'openai'),
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
      },
    },
    github: {
      username: getEnv('GITHUB_USERNAME', ''),
      email: getEnv('GITHUB_EMAIL', 'mercury@cosmicstack.org'),
      defaultOwner: getEnv('GITHUB_DEFAULT_OWNER', ''),
      defaultRepo: getEnv('GITHUB_DEFAULT_REPO', ''),
    },
    memory: {
      dir: getEnv('MEMORY_DIR', join(home, 'memory')),
      shortTermMaxMessages: getEnvNum('SHORT_TERM_MAX_MESSAGES', 20),
    },
    heartbeat: {
      intervalMinutes: getEnvNum('HEARTBEAT_INTERVAL_MINUTES', 60),
    },
    tokens: {
      dailyBudget: getEnvNum('DAILY_TOKEN_BUDGET', 50000),
    },
  };
}

const CONFIG_PATH = join(getMercuryHome(), 'mercury.yaml');

export function loadConfig(): MercuryConfig {
  if (existsSync(CONFIG_PATH)) {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const fileConfig = parseYaml(raw) as Partial<MercuryConfig>;
    const defaults = getDefaultConfig();
    return deepMerge(defaults, fileConfig);
  }
  return getDefaultConfig();
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
    .filter((p): p is ProviderConfig => typeof p === 'object' && p.enabled && p.apiKey.length > 0);
}