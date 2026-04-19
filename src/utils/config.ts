import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

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
    };
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

const CONFIG_PATH = join(process.cwd(), 'config', 'mercury.yaml');

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
  return {
    identity: {
      name: getEnv('MERCURY_NAME', 'Mercury'),
      owner: getEnv('MERCURY_OWNER', ''),
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
      },
    },
    memory: {
      dir: getEnv('MEMORY_DIR', join(process.cwd(), 'memory')),
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
  const dir = join(process.cwd(), 'config');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, stringifyYaml(config), 'utf-8');
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