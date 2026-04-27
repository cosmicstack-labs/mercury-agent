import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import readline from 'node:readline';
import chalk from 'chalk';

import {
  loadConfig,
  saveConfig,
  isSetupComplete,
  getMercuryHome,
  ensureCreatorField,
  clearTelegramAccess,
  isProviderConfigured,
  getTelegramAccessSummary,
  getTelegramApprovedUsers,
  getTelegramPendingRequests,
  approveTelegramPendingRequest,
  approveTelegramPendingRequestByPairingCode,
  rejectTelegramPendingRequest,
  removeTelegramUser,
  promoteTelegramUserToAdmin,
  demoteTelegramAdmin,
  hasTelegramAdmins,
} from './utils/config.js';
import type { MercuryConfig } from './utils/config.js';
import type { ProviderName } from './utils/config.js';
import { logger } from './utils/logger.js';
import { Identity } from './soul/identity.js';
import { ShortTermMemory, LongTermMemory, EpisodicMemory, migrateLegacyMemory } from './memory/store.js';
import { UserMemoryStore } from './memory/user-memory.js';
import { isBetterSqlite3Available } from './memory/second-brain-db.js';
import { ProviderRegistry } from './providers/registry.js';
import { Agent } from './core/agent.js';
import { Scheduler } from './core/scheduler.js';
import { ChannelRegistry } from './channels/registry.js';
import { CLIChannel } from './channels/cli.js';
import { TelegramChannel } from './channels/telegram.js';
import { WebChannel } from './channels/web.js';
import { TokenBudget } from './utils/tokens.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { SkillLoader } from './skills/loader.js';
import { getManual } from './utils/manual.js';
import { startBackground, stopDaemon, showLogs, getDaemonStatus, restartDaemon, tryAutoDaemonize } from './cli/daemon.js';
import { installService, uninstallService, showServiceStatus, isServiceInstalled } from './cli/service.js';
import { runWithWatchdog } from './cli/watchdog.js';
import { setGitHubToken } from './utils/github.js';
import { selectWithArrowKeys } from './utils/arrow-select.js';
import { ProviderModelFetchError, fetchProviderModelCatalog } from './utils/provider-models.js';
import { startWebServer, updateStatus as updateWebStatus, setUserMemory as setWebUserMemory, setWebChannel as setWebWebChannel, setScheduler as setWebScheduler } from './web/server.js';
import { isWebAuthInitialized, setWebPassword } from './web/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;

function hr() {
  console.log(chalk.dim('─'.repeat(50)));
}

const MERCURY_ASCII = [
  '    __  _____________  ________  ________  __',
  '   /  |/  / ____/ __ \\/ ____/ / / / __ \\/ < /',
  '  / /|_/ / __/ / /_/ / /   / / / / /_/ /\\  / ',
  ' / /  / / /___/ _, _/ /___/ /_/ / _, _/ / /  ',
  '/_/  /_/_____/_/ |_|\\____/\\____/_/ |_| /_/   ',
].filter(l => l.trim());

function banner() {
  console.log('');
  for (const line of MERCURY_ASCII) {
    console.log(chalk.bold.cyan(`  ${line}`));
  }
  console.log('');
  console.log(chalk.white('  an AI agent for personal tasks'));
  console.log(chalk.dim(`  v${pkgVersion} · by Cosmic Stack · mercury.cosmicstack.org`));
  console.log('');
}

function splashScreen() {
  console.log('');
  for (const line of MERCURY_ASCII) {
    console.log(chalk.bold.cyan(`  ${line}`));
  }
  console.log('');
  console.log(chalk.dim('  an AI agent for personal tasks'));
  console.log(chalk.cyan('  by Cosmic Stack'));
  console.log(chalk.dim('  mercury.cosmicstack.org'));
  console.log('');
}

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

const PROVIDER_OPTIONS: Array<{ key: ProviderName; label: string }> = [
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'grok', label: 'Grok (xAI)' },
  { key: 'ollamaCloud', label: 'Ollama Cloud' },
  { key: 'ollamaLocal', label: 'Ollama Local' },
];

function getConfiguredProviderNames(config: MercuryConfig): ProviderName[] {
  return PROVIDER_OPTIONS
    .map((option) => option.key)
    .filter((key) => isProviderConfigured(config.providers[key]));
}

function getProviderLabel(name: ProviderName): string {
  return PROVIDER_OPTIONS.find((option) => option.key === name)?.label || name;
}

function parseProviderSelection(input: string): ProviderName[] | null {
  const values = input.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return [];

  const selected: ProviderName[] = [];
  for (const value of values) {
    const index = parseInt(value, 10);
    if (isNaN(index) || index < 1 || index > PROVIDER_OPTIONS.length) {
      return null;
    }
    const provider = PROVIDER_OPTIONS[index - 1].key;
    if (!selected.includes(provider)) {
      selected.push(provider);
    }
  }
  return selected;
}

async function chooseProvidersToConfigure(config: MercuryConfig, isReconfig: boolean): Promise<ProviderName[]> {
  const configured = getConfiguredProviderNames(config);

  while (true) {
    for (let i = 0; i < PROVIDER_OPTIONS.length; i++) {
      const option = PROVIDER_OPTIONS[i];
      const status = configured.includes(option.key) ? ' (configured)' : '';
      console.log(chalk.white(`    ${i + 1}. ${option.label}${status}`));
    }
    console.log('');

    const prompt = isReconfig
      ? chalk.white('  Choose providers to configure [comma-separated, Enter keeps current]: ')
      : chalk.white('  Choose providers to configure [comma-separated, Enter for DeepSeek]: ');

    const input = await ask(prompt);
    const parsed = parseProviderSelection(input);
    if (parsed === null) {
      console.log(chalk.red('  Please choose valid provider numbers, like `1` or `1,3,5`.'));
      console.log('');
      continue;
    }

    if (parsed.length > 0) return parsed;
    if (!isReconfig) return ['deepseek'];
    return configured.length > 0 ? configured : ['deepseek'];
  }
}

async function chooseDefaultProvider(config: MercuryConfig): Promise<void> {
  const configured = getConfiguredProviderNames(config);

  if (configured.length === 0) {
    return;
  }

  if (configured.length === 1) {
    config.providers.default = configured[0];
    console.log(chalk.dim(`  Default provider set to ${getProviderLabel(configured[0])}`));
    return;
  }

  const suggested = configured.includes('deepseek') ? 'deepseek' : configured[0];

  console.log('');
  console.log(chalk.bold.white('  Default Provider'));
  console.log(chalk.dim('  Select the LLM provider Mercury should use first.'));
  console.log('');
  for (let i = 0; i < configured.length; i++) {
    const provider = configured[i];
    const recommended = provider === suggested ? ' (recommended)' : '';
    const current = provider === config.providers.default ? ' (current)' : '';
    console.log(chalk.white(`    ${i + 1}. ${getProviderLabel(provider)}${recommended}${current}`));
  }
  console.log('');

  while (true) {
    const choice = await ask(chalk.white(`  Choose [1-${configured.length}] [Enter for ${getProviderLabel(suggested)}]: `));
    if (!choice) {
      config.providers.default = suggested;
      return;
    }

    const num = parseInt(choice, 10);
    if (num >= 1 && num <= configured.length) {
      config.providers.default = configured[num - 1];
      return;
    }

    console.log(chalk.red('  Please choose a valid number from the list above.'));
  }
}

function looksLikeToken(value: string, minLength: number = 20): boolean {
  return value.length >= minLength && !/\s/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function validateApiKey(provider: ProviderName, value: string): string | null {
  if (provider === 'openai') {
    return /^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'OpenAI keys must start with `sk-`, `sk-proj-`, or `sk-svcacct-`.';
  }

  if (provider === 'anthropic') {
    return /^sk-ant-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'Anthropic keys must start with `sk-ant-`.';
  }

  if (provider === 'deepseek') {
    return /^sk-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'DeepSeek keys must start with `sk-`.';
  }

  if (provider === 'grok') {
    return looksLikeToken(value)
      ? null
      : 'Grok keys must look like a real API token: long, no spaces, and not plain text.';
  }

  if (provider === 'ollamaCloud') {
    return looksLikeToken(value)
      ? null
      : 'Ollama Cloud keys must look like a real API token: long, no spaces, and not plain text.';
  }

  return null;
}

function validateBaseUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Base URL must start with http:// or https://.';
    }
    return null;
  } catch {
    return 'Please enter a valid URL.';
  }
}

function validateModelName(value: string): string | null {
  if (!value.trim()) return 'Model name is required.';
  if (/\s/.test(value)) return 'Model name cannot contain spaces.';
  return null;
}

async function chooseProviderModel(
  providerLabel: string,
  recommendedModel: string,
  models: string[],
): Promise<string> {
  const selection = await selectWithArrowKeys(
    `${providerLabel} Models`,
    [
      {
        value: '__default__',
        label: `Use provider default (${recommendedModel})`,
      },
      ...models.map((model) => ({
        value: model,
        label: model,
      })),
      {
        value: '__custom__',
        label: 'Enter a custom model name',
      },
    ],
  );

  if (!selection || selection === '__default__') {
    return recommendedModel;
  }

  if (selection !== '__custom__') {
    return selection;
  }

  while (true) {
    const customModel = await ask(chalk.white(`  ${providerLabel} model [Enter or "none" for ${recommendedModel}]: `));
    if (!customModel || customModel.toLowerCase() === 'none') {
      return recommendedModel;
    }

    const error = validateModelName(customModel);
    if (!error) {
      return customModel;
    }

    console.log(chalk.red(`  ${error}`));
  }
}

async function promptApiKeyWithModelSelection(
  config: MercuryConfig,
  provider: ProviderName,
  providerLabel: string,
  prompt: string,
  isReconfig: boolean,
): Promise<{ apiKey?: string; model?: string; skipped: boolean }> {
  const existingConfig = config.providers[provider];

  while (true) {
    const value = await ask(prompt);
    if (!value) {
      if (isReconfig && existingConfig.apiKey) {
        return {
          apiKey: existingConfig.apiKey,
          model: existingConfig.model,
          skipped: true,
        };
      }

      return { skipped: true };
    }

    const formatError = validateApiKey(provider, value);
    if (formatError) {
      console.log(chalk.red(`  ${formatError}`));
      continue;
    }

    console.log(chalk.dim(`  Validating ${providerLabel} and fetching models...`));
    try {
      const catalog = await fetchProviderModelCatalog(provider, {
        ...existingConfig,
        apiKey: value,
      });
      const model = await chooseProviderModel(
        providerLabel,
        catalog.recommendedModel,
        catalog.models,
      );
      return { apiKey: value, model, skipped: false };
    } catch (error) {
      const message = error instanceof ProviderModelFetchError
        ? error.message
        : `Mercury could not fetch models for ${providerLabel}. Please re-enter the key.`;
      console.log(chalk.red(`  ${message}`));
    }
  }
}

async function promptOllamaLocalModelSelection(config: MercuryConfig): Promise<{ baseUrl?: string; model?: string; skipped: boolean }> {
  const existingConfig = config.providers.ollamaLocal;

  while (true) {
    const baseUrl = (await promptValidatedValue(
      chalk.white(`  Ollama Local base URL [${existingConfig.baseUrl}]: `),
      validateBaseUrl,
      existingConfig.baseUrl,
    ))!;

    console.log(chalk.dim('  Fetching Ollama Local models...'));
    try {
      const catalog = await fetchProviderModelCatalog('ollamaLocal', {
        ...existingConfig,
        baseUrl,
      });
      const model = await chooseProviderModel(
        'Ollama Local',
        catalog.recommendedModel,
        catalog.models,
      );
      return { baseUrl, model, skipped: false };
    } catch (error) {
      const message = error instanceof ProviderModelFetchError
        ? error.message
        : 'Mercury could not fetch Ollama Local models. Please check the base URL and try again.';
      console.log(chalk.red(`  ${message}`));
    }
  }
}

async function promptValidatedValue(
  prompt: string,
  validator: (value: string) => string | null,
  existingValue?: string,
  options?: { allowSkip?: boolean },
): Promise<string | undefined> {
  while (true) {
    const value = await ask(prompt);
    if (!value) {
      if (existingValue) return existingValue;
      if (options?.allowSkip) return undefined;
      console.log(chalk.red('  A value is required here.'));
      continue;
    }

    const error = validator(value);
    if (!error) return value;

    console.log(chalk.red(`  ${error}`));
  }
}

function appendToEnv(key: string, value: string): void {
  const envPath = join(getMercuryHome(), '.env');
  let envContent = '';
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf-8');
  }
  const lines = envContent.split('\n').filter((l: string) => !l.startsWith(`${key}=`) && l.trim() !== '');
  lines.push(`${key}=${value}`);
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8');
  process.env[key] = value;
}

function parseGithubRepo(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
  return null;
}

function formatTelegramUser(user: {
  userId: number;
  username?: string;
  firstName?: string;
}): string {
  const username = user.username ? ` (@${user.username})` : '';
  const firstName = user.firstName ? ` ${user.firstName}` : '';
  return `${user.userId}${username}${firstName}`;
}

function printTelegramAccessState(config: MercuryConfig): void {
  const admins = config.channels.telegram.admins;
  const members = config.channels.telegram.members;
  const pending = config.channels.telegram.pending;
  const pendingSummary = pending.length > 0
    ? pending.map((entry) => {
        const code = entry.pairingCode ? ` [code: ${entry.pairingCode}]` : '';
        return `${formatTelegramUser(entry)}${code}`;
      }).join(', ')
    : '';

  console.log('');
  console.log(`  Telegram Access: ${chalk.white(getTelegramAccessSummary(config))}`);
  console.log(`  Admins:          ${admins.length > 0 ? chalk.green(admins.map(formatTelegramUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Members:         ${members.length > 0 ? chalk.green(members.map(formatTelegramUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Pending:         ${pending.length > 0 ? chalk.yellow(pendingSummary) : chalk.dim('none')}`);
}

function restartDaemonIfRunning(message?: string): void {
  const daemon = getDaemonStatus();
  if (!daemon.running) return;

  if (message) {
    console.log(chalk.dim(`  ${message}`));
  }
  restartDaemon();
}

async function completeInitialTelegramPairing(config: MercuryConfig): Promise<void> {
  if (!config.channels.telegram.enabled || !config.channels.telegram.botToken || hasTelegramAdmins(config)) {
    return;
  }

  console.log('');
  console.log(chalk.bold.white('  Telegram Pairing'));
  console.log(chalk.dim('  1. Open Telegram and message your bot.'));
  console.log(chalk.dim('  2. Send /start to receive your pairing code in Telegram.'));
  console.log(chalk.dim('  3. Paste that pairing code below to finish setup.'));
  console.log('');

  const telegram = new TelegramChannel(config);
  try {
    await telegram.start();
  } catch (err: any) {
    console.log(chalk.red(`\n  ✗ ${err.message || err}`));
    console.log('');
    await telegram.stop();
    return;
  }

  try {
    while (true) {
      const pairingCode = await ask(chalk.white('  Telegram Pairing Code: '));
      if (!pairingCode) {
        console.log(chalk.red('  Telegram pairing code is required to continue.'));
        continue;
      }

      const approved = approveTelegramPendingRequestByPairingCode(config, pairingCode);
      if (!approved) {
        console.log(chalk.red('  That pairing code is not valid yet. Send /start in Telegram, then paste the exact code here.'));
        continue;
      }

      saveConfig(config);
      console.log(chalk.green(`  ✓ Telegram paired. First admin: ${formatTelegramUser(approved)}.`));
      console.log('');
      break;
    }
  } finally {
    await telegram.stop();
  }
}

async function configure(existingConfig?: MercuryConfig): Promise<void> {
  const isReconfig = !!existingConfig;
  const config = existingConfig ?? loadConfig();

  if (isReconfig) {
    banner();
    console.log(chalk.yellow('  Reconfiguring Mercury — press Enter to keep current value.'));
  } else {
    splashScreen();
    console.log(chalk.yellow('  First run detected — let\'s set you up.'));
  }

  hr();
  console.log('');
  console.log(chalk.bold.white('  Identity'));
  console.log('');

  if (isReconfig) {
    const ownerName = await ask(chalk.white(`  Your name [${config.identity.owner}]: `));
    if (ownerName) config.identity.owner = ownerName;

    const agentName = await ask(chalk.white(`  Agent name [${config.identity.name}]: `));
    if (agentName) config.identity.name = agentName;
  } else {
    const ownerName = await ask(chalk.white('  Your name: '));
    if (!ownerName) {
      console.log(chalk.red('  Name is required.'));
      process.exit(1);
    }
    config.identity.owner = ownerName;

    const agentName = await ask(chalk.white(`  Agent name [${config.identity.name}]: `));
    if (agentName) config.identity.name = agentName;
  }

  config.identity.creator = config.identity.creator || 'Cosmic Stack';

  hr();
  console.log('');
  console.log(chalk.bold.white('  LLM Providers'));
  if (isReconfig) {
    console.log(chalk.dim('  Choose which providers to configure now. Existing values are shown where available.'));
  } else {
    console.log(chalk.dim('  Choose one or more providers. Press Enter to configure DeepSeek by default.'));
  }
  console.log('');

  while (true) {
    const selectedProviders = await chooseProvidersToConfigure(config, isReconfig);
    console.log('');

    for (const provider of selectedProviders) {
      if (provider === 'deepseek') {
        const mask = isReconfig && config.providers.deepseek.apiKey ? ` [${maskKey(config.providers.deepseek.apiKey)}]` : '';
        const result = await promptApiKeyWithModelSelection(
          config,
          'deepseek',
          'DeepSeek',
          chalk.white(`  DeepSeek API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          isReconfig,
        );
        if (!result.skipped && result.apiKey && result.model) {
          config.providers.deepseek.apiKey = result.apiKey;
          config.providers.deepseek.model = result.model;
          config.providers.deepseek.enabled = true;
        }
        continue;
      }

      if (provider === 'openai') {
        const mask = isReconfig && config.providers.openai.apiKey ? ` [${maskKey(config.providers.openai.apiKey)}]` : '';
        const result = await promptApiKeyWithModelSelection(
          config,
          'openai',
          'OpenAI',
          chalk.white(`  OpenAI API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          isReconfig,
        );
        if (!result.skipped && result.apiKey && result.model) {
          config.providers.openai.apiKey = result.apiKey;
          config.providers.openai.model = result.model;
          config.providers.openai.enabled = true;
        }
        continue;
      }

      if (provider === 'anthropic') {
        const mask = isReconfig && config.providers.anthropic.apiKey ? ` [${maskKey(config.providers.anthropic.apiKey)}]` : '';
        const result = await promptApiKeyWithModelSelection(
          config,
          'anthropic',
          'Anthropic',
          chalk.white(`  Anthropic API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          isReconfig,
        );
        if (!result.skipped && result.apiKey && result.model) {
          config.providers.anthropic.apiKey = result.apiKey;
          config.providers.anthropic.model = result.model;
          config.providers.anthropic.enabled = true;
        }
        continue;
      }

      if (provider === 'grok') {
        const mask = isReconfig && config.providers.grok.apiKey ? ` [${maskKey(config.providers.grok.apiKey)}]` : '';
        const result = await promptApiKeyWithModelSelection(
          config,
          'grok',
          'Grok',
          chalk.white(`  Grok API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          isReconfig,
        );
        if (!result.skipped && result.apiKey && result.model) {
          config.providers.grok.apiKey = result.apiKey;
          config.providers.grok.model = result.model;
          config.providers.grok.enabled = true;
        }
        continue;
      }

      if (provider === 'ollamaCloud') {
        const mask = isReconfig && config.providers.ollamaCloud.apiKey ? ` [${maskKey(config.providers.ollamaCloud.apiKey)}]` : '';
        const result = await promptApiKeyWithModelSelection(
          config,
          'ollamaCloud',
          'Ollama Cloud',
          chalk.white(`  Ollama Cloud API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          isReconfig,
        );
        if (!result.skipped && result.apiKey && result.model) {
          config.providers.ollamaCloud.apiKey = result.apiKey;
          config.providers.ollamaCloud.model = result.model;
          config.providers.ollamaCloud.enabled = true;
        }
        continue;
      }

      if (provider === 'ollamaLocal') {
        const result = await promptOllamaLocalModelSelection(config);
        if (!result.skipped && result.baseUrl && result.model) {
          config.providers.ollamaLocal.baseUrl = result.baseUrl;
          config.providers.ollamaLocal.model = result.model;
          config.providers.ollamaLocal.enabled = true;
        }
      }
    }

    const configuredProviders = getConfiguredProviderNames(config);
    if (configuredProviders.length === 0) {
      console.log(chalk.red('  You need to configure at least one LLM provider to continue.'));
      console.log(chalk.dim('  Let’s try that step again.'));
      console.log('');
      continue;
    }

    await chooseDefaultProvider(config);
    break;
  }

  hr();
  console.log('');
  console.log(chalk.bold.white('  Telegram (optional)'));
  if (isReconfig) {
    console.log(chalk.dim('  Leave empty to keep current value. Enter "none" to disable.'));
  } else {
    console.log(chalk.dim('  Leave empty to skip. You can add it later.'));
    console.log(chalk.dim('  To create a bot token:'));
    console.log(chalk.dim('    1. Open Telegram and message @BotFather'));
    console.log(chalk.dim('    2. Run /newbot and follow the prompts'));
    console.log(chalk.dim('    3. Copy the bot token BotFather gives you'));
    console.log(chalk.dim('    4. Paste that token here'));
    console.log(chalk.dim('  After setup, users send /start to request access.'));
    console.log(chalk.dim('  The first Telegram user gets a pairing code, and you approve that code from the CLI.'));
  }
  console.log('');

  const tgMask = isReconfig && config.channels.telegram.botToken ? ` [${maskKey(config.channels.telegram.botToken)}]` : '';
  const telegramToken = await ask(chalk.white(`  Telegram Bot Token${tgMask}: `));
  if (isReconfig && telegramToken.toLowerCase() === 'none') {
    config.channels.telegram.enabled = false;
    config.channels.telegram.botToken = '';
    clearTelegramAccess(config);
  } else if (telegramToken) {
    if (telegramToken !== config.channels.telegram.botToken) {
      clearTelegramAccess(config);
    }
    config.channels.telegram.botToken = telegramToken;
    config.channels.telegram.enabled = true;
  }

  await completeInitialTelegramPairing(config);

  hr();
  console.log('');
  console.log(chalk.bold.white('  GitHub Integration (optional)'));
  console.log(chalk.dim('  Connect Mercury to GitHub so it can create PRs, manage issues,'));
  console.log(chalk.dim('  review code, and co-author commits on your behalf.'));
  console.log(chalk.dim('  Leave empty to skip. You can add it later with mercury doctor.'));
  console.log('');

  const ghUserCurrent = isReconfig && config.github.username ? ` [${config.github.username}]` : '';
  const ghUsername = await ask(chalk.white(`  1. Your GitHub username${ghUserCurrent}: `));
  if (ghUsername) config.github.username = ghUsername;

  if (!config.github.email) {
    config.github.email = 'mercury@cosmicstack.org';
  }

  console.log('');
  console.log(chalk.dim('     You need a Personal Access Token (PAT) with repo access.'));
  console.log(chalk.dim('     Fine-grained (recommended): github.com/settings/personal-access-tokens/new'));
  console.log(chalk.dim('       → Permissions: Contents (R/W), Pull requests (R/W), Issues (R/W)'));
  console.log(chalk.dim('     Classic: github.com/settings/tokens/new'));
  console.log(chalk.dim('       → Scope: repo (full control)'));
  const ghTokenCurrent = process.env.GITHUB_TOKEN ? ` [${maskKey(process.env.GITHUB_TOKEN)}]` : '';
  const ghToken = await ask(chalk.white(`  2. GitHub PAT${ghTokenCurrent}: `));
  if (ghToken) {
    appendToEnv('GITHUB_TOKEN', ghToken);
  }

  if (config.github.username || process.env.GITHUB_TOKEN) {
    console.log('');
    console.log(chalk.dim('     Set a default repo so you can say "create an issue" without'));
    console.log(chalk.dim('     specifying the repo every time. Enter owner/name or a full URL.'));
    console.log(chalk.dim('     Example: hotheadhacker/mercury-agent'));
    console.log(chalk.dim('     Example: https://github.com/hotheadhacker/mercury-agent'));
    const ghOwnerCurrent = isReconfig && config.github.defaultOwner ? ` [${config.github.defaultOwner}/${config.github.defaultRepo}]` : '';
    const ghRepoInput = await ask(chalk.white(`  3. Default repo${ghOwnerCurrent}: `));
    if (ghRepoInput) {
      const parsed = parseGithubRepo(ghRepoInput);
      if (parsed) {
        config.github.defaultOwner = parsed.owner;
        config.github.defaultRepo = parsed.repo;
      } else {
        console.log(chalk.yellow('  Could not parse repo. Use format: owner/repo or a GitHub URL.'));
      }
    }
  }

  hr();
  console.log('');
  console.log(chalk.bold.white('  Token Budget'));
  console.log('');

  const budgetPrompt = isReconfig
    ? chalk.white(`  Daily token budget [${config.tokens.dailyBudget.toLocaleString()}]: `)
    : chalk.white(`  Daily token budget [${config.tokens.dailyBudget.toLocaleString()}]: `);
  const budgetStr = await ask(budgetPrompt);
  if (budgetStr) {
    const budget = parseInt(budgetStr.replace(/,/g, ''), 10);
    if (!isNaN(budget) && budget > 0) {
      config.tokens.dailyBudget = budget;
    }
  }

  hr();
  saveConfig(config);

  console.log('');
  console.log(chalk.bold.white('  Web Dashboard'));
  console.log('');
  console.log(chalk.dim('  Mercury runs a web dashboard at http://localhost:6174'));

  if (isWebAuthInitialized()) {
    console.log(chalk.dim('  You can change your password below, or press Enter to keep it.'));
    const webPassword = await ask(chalk.white('  New web dashboard password [keep current]: '));
    if (webPassword.trim()) {
      setWebPassword(webPassword.trim());
      console.log(chalk.green('  ✓ Web dashboard password updated.'));
    } else {
      console.log(chalk.dim('  Password unchanged.'));
    }
  } else {
    console.log(chalk.dim('  Default password is Mercury@123 — set a custom one now or press Enter to keep it.'));
    console.log('');
    const webPassword = await ask(chalk.white('  Web dashboard password [Mercury@123]: '));
    if (webPassword.trim()) {
      setWebPassword(webPassword.trim());
      console.log(chalk.green('  ✓ Web dashboard password set.'));
    } else {
      console.log(chalk.dim('  Using default password: Mercury@123'));
    }
  }

  const home = getMercuryHome();
  console.log('');
  console.log(chalk.green(`  ✓ Config saved to ${home}/mercury.yaml`));
  console.log(chalk.green(`  ✓ Soul files seeded in ${home}/soul/`));
  console.log(chalk.green(`  ✓ Memory stored in ${home}/memory/`));
  console.log(chalk.green(`  ✓ Permissions seeded in ${home}/permissions.yaml`));
  console.log(chalk.green(`  ✓ Skills directory ready in ${home}/skills/`));
  console.log('');
  console.log(chalk.cyan(`  ${config.identity.name} is ready. Run \`mercury start\` to chat.`));
  console.log(chalk.dim('  mercury.cosmicstack.org'));
  console.log('');
}

function autoDaemonize(): void {
  const daemon = getDaemonStatus();
  if (daemon.running && daemon.pid) {
    return;
  }

  console.log(chalk.dim('  Setting up background mode...'));

  try {
    if (!isServiceInstalled()) {
      installService();
    }
  } catch {
    console.log(chalk.dim('  Service install skipped (can run `mercury service install` later).'));
  }

  const ok = tryAutoDaemonize();
  if (ok) {
    const status = getDaemonStatus();
    console.log(chalk.green(`  \u2713 Mercury is running in background (PID: ${status.pid})`));
    console.log(chalk.green('  \u2713 Auto-starts on login. Auto-restarts on crash.'));
    console.log(chalk.dim('  Use `mercury stop` to stop. `mercury restart` to restart.'));
  } else {
    console.log(chalk.yellow('  Background mode not available. Run `mercury start` to set it up.'));
  }
  console.log('');
}

async function runAgent(isDaemon: boolean = false): Promise<void> {
  let config = loadConfig();
  config = ensureCreatorField(config);
  const name = config.identity.name;

  if (!isDaemon) {
    banner();
    console.log(chalk.white(`  ${name} is waking up...`));
    console.log('');
  } else {
    logger.info(`${name} is waking up (daemon mode)...`);
  }

  const tokenBudget = new TokenBudget(config);
  const providers = new ProviderRegistry(config);

  if (!providers.hasProviders()) {
    if (isDaemon) {
      logger.error('No LLM providers available. Run `mercury doctor` to configure providers.');
      return;
    }
    console.log(chalk.red('  No LLM providers available. Run `mercury doctor` to configure providers.'));
    process.exit(1);
  }

  const available = providers.listAvailable();
  const providerLabels = available.map((provider) => getProviderLabel(provider as ProviderName));
  const providerModels = available.map((provider) => {
    const key = provider as ProviderName;
    return `${getProviderLabel(key)}: ${config.providers[key].model}`;
  });
  if (!isDaemon) {
    console.log(chalk.dim(`  Providers: ${providerLabels.join(', ')}`));
    console.log(chalk.dim(`  Models: ${providerModels.join(' | ')}`));
  } else {
    logger.info({ providers: available }, 'Providers loaded');
  }

  const skillLoader = new SkillLoader();
  const skills = skillLoader.discover();
  if (!isDaemon) {
    console.log(chalk.dim(`  Skills: ${skills.length > 0 ? skills.map(s => s.name).join(', ') : 'none installed'}`));
  }

  const scheduler = new Scheduler(config);
  setWebScheduler(scheduler);

  const identity = new Identity();
  migrateLegacyMemory();
  const shortTerm = new ShortTermMemory(config);
  const longTerm = new LongTermMemory(config);
  const episodic = new EpisodicMemory(config);

  let userMemory: UserMemoryStore | null = null;
  if (config.memory.secondBrain?.enabled !== false && isBetterSqlite3Available()) {
    try {
      userMemory = new UserMemoryStore(config);
      setWebUserMemory(userMemory);
      if (!isDaemon) {
        console.log(chalk.dim(`  Second brain: enabled (${userMemory.getSummary().total} existing memories)`));
      } else {
        logger.info({ total: userMemory.getSummary().total }, 'Second brain loaded');
      }
    } catch (err) {
      logger.warn({ err }, 'Second brain initialization failed, continuing without it');
      userMemory = null;
    }
  } else if (config.memory.secondBrain?.enabled !== false && !isBetterSqlite3Available()) {
    logger.warn(
      'Second brain dependency issue: better-sqlite3 is not available. ' +
      'Memory/brain features require SQLite via better-sqlite3. Install build tools and reinstall dependencies.'
    );
  }

  const channels = new ChannelRegistry(config);
  const webChannel = new WebChannel(config.identity.name);
  channels.register('web', webChannel);
  const capabilities = new CapabilityRegistry(skillLoader, scheduler, tokenBudget, userMemory ?? undefined);

  capabilities.setChatCommandContext({
    toolNames: () => capabilities.getToolNames(),
    skillNames: () => skills.map(s => s.name),
    config: () => config,
    tokenBudget: () => tokenBudget,
    manual: () => getManual(),
    memorySummary: () => userMemory ? userMemory.getSummary() : { total: 0, byType: {}, learningPaused: false },
    memoryRecent: (limit?: number) => userMemory ? userMemory.getRecent(limit) : [],
    memorySearch: (query: string, limit?: number) => userMemory ? userMemory.search(query, limit) : [],
    memorySetLearningPaused: (paused: boolean) => { if (userMemory) userMemory.setLearningPaused(paused); },
    memoryClear: () => userMemory ? userMemory.clear() : 0,
  });

  capabilities.setSendFileHandler(async (filePath: string) => {
    const { channelId, channelType } = capabilities.getChannelContext();
    const telegram = channels.get('telegram');

    if (channelType === 'telegram' && telegram) {
      await telegram.sendFile(filePath, channelId);
      return;
    }

    if (config.channels.telegram.enabled && telegram && getTelegramApprovedUsers(config).length > 0) {
      await telegram.sendFile(filePath);
      return;
    }

    const cli = channels.get('cli');
    if (cli) {
      await cli.sendFile(filePath);
    }
  });

  capabilities.setSendMessageHandler(async (content: string) => {
    const telegram = channels.get('telegram');

    if (!config.channels.telegram.enabled || !telegram) {
      throw new Error('Telegram is not configured. Add a bot token in setup or run `mercury doctor`.');
    }

    if (getTelegramApprovedUsers(config).length === 0) {
      throw new Error('Telegram has no approved users. Ask someone to send /start, then approve the request from Mercury.');
    }

    await telegram.send(content);
  });
  if (process.env.GITHUB_TOKEN) {
    setGitHubToken(process.env.GITHUB_TOKEN);
  }

  capabilities.registerAll();

  const agent = new Agent(
    config, providers, identity, shortTerm, longTerm, episodic, userMemory, channels, tokenBudget, capabilities, scheduler,
  );

  await agent.birth();
  await agent.wake();

  const cliChannel = channels.get('cli') as CLIChannel | undefined;
  const tgChannel = channels.get('telegram') as TelegramChannel | undefined;

  if (tgChannel) {
    tgChannel.setChatCommandContext(capabilities.getChatCommandContext()!);
  }

  setWebWebChannel(webChannel);

  capabilities.permissions.onAsk(async (prompt: string) => {
    const channelType = capabilities.permissions.getCurrentChannelType();
    if (channelType === 'telegram' && tgChannel) {
      return tgChannel.askPermission(prompt);
    }
    if (channelType === 'web' && webChannel) {
      return webChannel.askPermission(prompt);
    }
    if (cliChannel) {
      return cliChannel.askPermission(prompt);
    }
    return 'no';
  });

  if (tgChannel) {
    tgChannel.setOnPermissionMode((mode, chatId) => {
      if (mode === 'allow-all') {
        capabilities.permissions.setAutoApproveAll(true);
        capabilities.permissions.addTempScope('/', true, true);
        logger.info({ chatId }, 'Telegram: Allow All mode set for session');
      }
    });
  }

  const activeCh = channels.getActiveChannels();
  const toolNames = capabilities.getToolNames();

  if (!isDaemon) {
    if (config.identity.creator) {
      console.log(chalk.dim(`  Creator: ${config.identity.creator}`));
    }
    hr();

    console.log('');
    console.log(chalk.green(`  ${name} is live. Type a message and press Enter.`));
    console.log(chalk.dim('  Ctrl+C to exit · /help for commands'));

    startWebServer();
    updateWebStatus({
      running: true,
      pid: process.pid,
      state: 'idle',
      defaultProvider: config.providers.default,
      providers: Object.entries(config.providers)
        .filter(([k]) => k !== 'default')
        .map(([name, p]: [string, any]) => ({ name: p.name || name, enabled: p.enabled, hasKey: !!p.apiKey })),
      tokenBudget: config.tokens.dailyBudget,
    });

    // Keep CLI permission mode prompt, but do it after web server is live.
    const mode = cliChannel && await cliChannel.askPermissionMode?.();
    if (mode === 'allow-all') {
      capabilities.permissions.setAutoApproveAll(true);
      capabilities.permissions.addTempScope('/', true, true);
    }

    console.log('');
    cliChannel?.showPrompt();
  } else {
    startWebServer();
    updateWebStatus({
      running: true,
      pid: process.pid,
      state: 'idle',
      defaultProvider: config.providers.default,
      providers: Object.entries(config.providers)
        .filter(([k]) => k !== 'default')
        .map(([name, p]: [string, any]) => ({ name: p.name || name, enabled: p.enabled, hasKey: !!p.apiKey })),
      tokenBudget: config.tokens.dailyBudget,
    });
    logger.info({ channels: activeCh, tools: toolNames }, 'Mercury is live (daemon mode)');
  }

  const shutdown = async () => {
    if (!isDaemon) {
      console.log('');
      console.log(chalk.dim(`  ${name} is shutting down...`));
    } else {
      logger.info('Mercury is shutting down (daemon mode)');
    }
    if (userMemory) {
      try {
        userMemory.consolidate();
        userMemory.close();
      } catch {}
    }
    await agent.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (!isDaemon && process.platform !== 'win32') {
    process.on('SIGHUP', () => {
      logger.info('SIGHUP received — terminal closed. Daemonizing.');
      try {
        const result = tryAutoDaemonize();
        if (result) {
          logger.info(`Forked daemon. Foreground process exiting.`);
        } else {
          logger.warn('SIGHUP received but daemonization failed. Shutting down.');
        }
      } catch {
        logger.warn('SIGHUP received but daemonization failed. Shutting down.');
      }
      process.exit(0);
    });
  }
}

const program = new Command();

program
  .name('mercury')
  .description('Mercury — Soul-driven AI agent with permission-hardened tools, token budgets, and multi-channel access.')
  .version(pkgVersion)
  .option('-v, --verbose', 'Show debug logs')
  .action(async () => {
    if (!isSetupComplete()) {
      await configure();
      autoDaemonize();
      return;
    }
    autoDaemonize();
    await runAgent();
  });

program
  .command('start')
  .description('Start Mercury — runs as a daemon by default, use --foreground to attach to terminal')
  .option('-v, --verbose', 'Show debug logs')
  .option('-f, --foreground', 'Run in foreground (attached to terminal)')
  .option('-d, --detached', 'Run in background (daemon mode) — same as default')
  .option('--daemon', 'Internal flag for daemon child process')
  .action(async (opts) => {
    if (opts.daemon) {
      await runWithWatchdog(() => runAgent(true));
      return;
    }

    if (!isSetupComplete()) {
      await configure();
      autoDaemonize();
      return;
    }

    if (opts.foreground) {
      await runAgent();
      return;
    }

    startBackground();
  });

program
  .command('stop')
  .description('Stop a background Mercury process')
  .action(() => {
    stopDaemon();
  });

program
  .command('restart')
  .description('Restart a background Mercury process')
  .action(() => {
    restartDaemon();
  });

program
  .command('up')
  .description('Start Mercury as a persistent daemon (same as `mercury start`)')
  .action(async () => {
    if (!isSetupComplete()) {
      await configure();
      autoDaemonize();
      return;
    }

    const daemon = getDaemonStatus();
    if (daemon.running && daemon.pid) {
      console.log('');
      console.log(chalk.green(`  Mercury is already running (PID: ${daemon.pid})`));
      console.log(chalk.dim(`  Logs: ${daemon.logPath}`));
      console.log('');
      return;
    }

    if (!isServiceInstalled()) {
      console.log('');
      console.log(chalk.cyan('  Installing Mercury as a system service...'));
      installService();
    }

    startBackground();
  });

program
  .command('logs')
  .description('Show recent daemon logs')
  .action(() => {
    showLogs();
  });

program
  .command('setup')
  .description('Re-run the setup wizard (reconfigure)')
  .action(async () => {
    if (isSetupComplete()) {
      await configure(loadConfig());
    } else {
      await configure();
    }
  });

program
  .command('doctor')
  .description('Reconfigure Mercury — change keys, name, settings (Enter to keep current)')
  .action(async () => {
    if (isSetupComplete()) {
      await configure(loadConfig());
    } else {
      await configure();
    }
  });

program
  .command('status')
  .description('Show current configuration and daemon status')
  .action(() => {
    const config = loadConfig();
    const home = getMercuryHome();
    const skillLoader = new SkillLoader();
    const skills = skillLoader.discover();
    const daemon = getDaemonStatus();
    banner();
    console.log(`  Name:     ${chalk.cyan(config.identity.name)}`);
    console.log(`  Owner:    ${chalk.white(config.identity.owner || '(not set)')}`);
    if (config.identity.creator) {
      console.log(`  Creator:  ${chalk.white(config.identity.creator)}`);
    }
    console.log(`  Provider: ${chalk.white(getProviderLabel(config.providers.default))}`);
    console.log(`  Telegram: ${config.channels.telegram.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
    console.log(`  Telegram Access: ${chalk.white(getTelegramAccessSummary(config))}`);
    console.log(`  Skills:   ${skills.length > 0 ? chalk.green(skills.map(s => s.name).join(', ')) : chalk.dim('none')}`);
    console.log(`  Budget:   ${chalk.white(config.tokens.dailyBudget.toLocaleString())} tokens/day`);
    console.log(`  Setup:    ${isSetupComplete() ? chalk.green('complete') : chalk.red('not done')}`);
    console.log(`  Daemon:   ${daemon.running ? chalk.green(`running (PID: ${daemon.pid})`) : chalk.dim('not running')}`);
    console.log(`  Home:     ${chalk.dim(home)}`);
    printTelegramAccessState(config);
    console.log('');
  });

program
  .command('help')
  .description('Show capabilities and commands manual')
  .action(() => {
    console.log(getManual());
  });

const telegramCmd = program
  .command('telegram')
  .description('Manage Telegram access approvals and admins');

telegramCmd
  .command('list')
  .description('Show approved Telegram users and pending access requests')
  .action(() => {
    const config = loadConfig();
    console.log('');
    printTelegramAccessState(config);
    console.log('');
  });

telegramCmd
  .command('approve <codeOrUserId>')
  .description('Approve a pending Telegram access request by pairing code or user ID')
  .action((codeOrUserId: string) => {
    const config = loadConfig();
    const hasAdmins = hasTelegramAdmins(config);

    if (!hasAdmins) {
      const approved = approveTelegramPendingRequestByPairingCode(config, codeOrUserId.trim());
      if (!approved) {
        console.log('');
        console.log(chalk.red(`  No pending first-time Telegram pairing found for code ${codeOrUserId}.`));
        console.log('');
        return;
      }

      saveConfig(config);
      console.log('');
      console.log(chalk.green(`  ✓ Approved first Telegram admin ${formatTelegramUser(approved)}.`));
      restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
      console.log('');
      return;
    }

    const targetUserId = Number(codeOrUserId);
    if (isNaN(targetUserId)) {
      console.log('');
      console.log(chalk.red('  Please provide a numeric Telegram user ID once Telegram already has an admin.'));
      console.log('');
      return;
    }

    const approved = approveTelegramPendingRequest(config, targetUserId, 'member');
    if (!approved) {
      console.log('');
      console.log(chalk.red(`  No pending Telegram request found for user ${codeOrUserId}.`));
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Approved Telegram member ${formatTelegramUser(approved)}.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

telegramCmd
  .command('reject <userId>')
  .description('Reject a pending Telegram access request')
  .action((userId: string) => {
    const config = loadConfig();
    const targetUserId = Number(userId);
    if (isNaN(targetUserId)) {
      console.log('');
      console.log(chalk.red('  Please provide a numeric Telegram user ID.'));
      console.log('');
      return;
    }

    const rejected = rejectTelegramPendingRequest(config, targetUserId);
    if (!rejected) {
      console.log('');
      console.log(chalk.red(`  No pending Telegram request found for user ${userId}.`));
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Rejected Telegram request for ${formatTelegramUser(rejected)}.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

telegramCmd
  .command('remove <userId>')
  .description('Remove an approved Telegram admin or member')
  .action((userId: string) => {
    const config = loadConfig();
    const targetUserId = Number(userId);
    if (isNaN(targetUserId)) {
      console.log('');
      console.log(chalk.red('  Please provide a numeric Telegram user ID.'));
      console.log('');
      return;
    }

    const removed = removeTelegramUser(config, targetUserId);
    if (!removed) {
      console.log('');
      console.log(chalk.red(`  No approved Telegram user found for ${userId}.`));
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Removed Telegram access for ${formatTelegramUser(removed)}.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

telegramCmd
  .command('promote <userId>')
  .description('Promote an approved Telegram member to admin')
  .action((userId: string) => {
    const config = loadConfig();
    const targetUserId = Number(userId);
    if (isNaN(targetUserId)) {
      console.log('');
      console.log(chalk.red('  Please provide a numeric Telegram user ID.'));
      console.log('');
      return;
    }

    const promoted = promoteTelegramUserToAdmin(config, targetUserId);
    if (!promoted) {
      console.log('');
      console.log(chalk.red(`  No Telegram member found for ${userId}.`));
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Promoted ${formatTelegramUser(promoted)} to Telegram admin.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

telegramCmd
  .command('demote <userId>')
  .description('Demote a Telegram admin to member')
  .action((userId: string) => {
    const config = loadConfig();
    const targetUserId = Number(userId);
    if (isNaN(targetUserId)) {
      console.log('');
      console.log(chalk.red('  Please provide a numeric Telegram user ID.'));
      console.log('');
      return;
    }

    const demoted = demoteTelegramAdmin(config, targetUserId);
    if (!demoted) {
      console.log('');
      console.log(chalk.red('  Could not demote that Telegram admin. Mercury must keep at least one admin.'));
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Demoted ${formatTelegramUser(demoted)} to Telegram member.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

telegramCmd
  .command('unpair')
  .description('Reset all Telegram access for this Mercury instance')
  .action(() => {
    const config = loadConfig();
    const hasAnyAccess = getTelegramApprovedUsers(config).length > 0 || getTelegramPendingRequests(config).length > 0;
    if (!hasAnyAccess) {
      console.log('');
      console.log(chalk.dim('  Telegram access is already empty.'));
      console.log('');
      return;
    }

    clearTelegramAccess(config);
    saveConfig(config);

    console.log('');
    console.log(chalk.green('  ✓ Telegram access reset.'));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    if (!getDaemonStatus().running) {
      console.log(chalk.dim('  New private Telegram users can send /start to request access.'));
      console.log(chalk.dim('  The first request must be approved from the CLI with `mercury telegram approve <pairing-code>`.'));
    }
    console.log('');
  });

const serviceCmd = program
  .command('service')
  .description('Manage Mercury as a system service (auto-start, crash recovery)');

serviceCmd
  .command('install')
  .description('Install Mercury as a system service (auto-start on boot)')
  .action(() => {
    installService();
  });

serviceCmd
  .command('uninstall')
  .description('Uninstall the system service')
  .action(() => {
    uninstallService();
  });

serviceCmd
  .command('status')
  .description('Show system service status')
  .action(() => {
    showServiceStatus();
  });

program
  .command('upgrade')
  .description('Upgrade Mercury to the latest version from npm')
  .action(async () => {
    console.log('');
    console.log(chalk.cyan(`  Mercury ${chalk.white(`v${pkgVersion}`)}`));
    console.log('');

    const daemon = getDaemonStatus();
    if (daemon.running) {
      console.log(chalk.dim('  Stopping background daemon...'));
      stopDaemon();
      await new Promise((r) => setTimeout(r, 1000));
      console.log(chalk.green('  ✓ Daemon stopped'));
    }

    console.log(chalk.dim('  Checking for latest version...'));
    const { execSync } = await import('node:child_process');

    let latestVersion = '';
    try {
      latestVersion = execSync('npm view @cosmicstack/mercury-agent version', { encoding: 'utf-8' }).trim();
    } catch {
      console.log(chalk.red('  ✗ Failed to fetch latest version from npm'));
      console.log('');
      return;
    }

    console.log(chalk.dim(`  Latest: v${latestVersion}`));

    if (latestVersion === pkgVersion) {
      console.log(chalk.green(`  ✓ Already on the latest version (v${pkgVersion})`));
      console.log('');
      return;
    }

    console.log(chalk.dim(`  Upgrading v${pkgVersion} → v${latestVersion}...`));
    console.log('');

    try {
      execSync('npm rm -g @cosmicstack/mercury-agent', { stdio: 'pipe' });
    } catch {
      // ignore — old package may not exist or ENOTEMPTY
      try {
        const globalDir = execSync('npm root -g', { encoding: 'utf-8' }).trim();
        const pkgDir = join(globalDir, '@cosmicstack', 'mercury-agent');
        const { rmSync } = await import('node:fs');
        try { rmSync(pkgDir, { recursive: true, force: true }); } catch {}
      } catch {}
    }

    try {
      execSync('npm i -g @cosmicstack/mercury-agent@latest', { stdio: 'inherit' });
      console.log('');
      console.log(chalk.green(`  ✓ Upgraded to v${latestVersion}`));
      console.log(chalk.dim('  Run `mercury` to start the new version.'));
    } catch {
      console.log('');
      console.log(chalk.red('  ✗ Upgrade failed. Try manually:'));
      console.log(chalk.dim('    npm rm -g @cosmicstack/mercury-agent && npm i -g @cosmicstack/mercury-agent'));
    }

    console.log('');
  });

program
  .command('web-reset-password')
  .description('Reset the web dashboard password')
  .argument('[password]', 'New password (prompted if omitted)')
  .action(async (password?: string) => {
    console.log('');
    if (!password) {
      password = await ask(chalk.white('  New web dashboard password: '));
    }
    if (!password) {
      console.log(chalk.red('  Password cannot be empty.'));
      console.log('');
      process.exit(1);
    }
    setWebPassword(password);
    console.log(chalk.green('  ✓ Web dashboard password updated.'));
    console.log(chalk.dim('  Login at http://localhost:6174'));
    console.log('');
  });

program.parse();
