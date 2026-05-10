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
import { SubAgentSupervisor } from './core/supervisor.js';
import { SpotifyClient } from './spotify/client.js';
import { ChannelRegistry } from './channels/registry.js';
import { CLIChannel } from './channels/cli.js';
import { TelegramChannel } from './channels/telegram.js';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;

function hr() {
  console.log(chalk.dim('─'.repeat(50)));
}

const MERCURY_ASCII = [
  '      /\\_/\\      ',
  '    =( o.o )=     ',
  '      > ^ <       ',
  '        *         ',
].filter((l) => l.trim());

function banner() {
  console.log('');
  for (const line of MERCURY_ASCII) {
    console.log(chalk.bold.cyan(`  ${line}`));
  }
  console.log('');
  console.log(chalk.bold.cyan('  MERCURY'));
  console.log(chalk.white('  Your soul-driven AI agent'));
  console.log(chalk.dim(`  v${pkgVersion} · by Cosmic Stack · mercury.cosmicstack.org`));
  console.log('');
}

function splashScreen() {
  console.log('');
  for (const line of MERCURY_ASCII) {
    console.log(chalk.bold.cyan(`  ${line}`));
  }
  console.log('');
  console.log(chalk.bold.cyan('  MERCURY'));
  console.log(chalk.dim('  Your soul-driven AI agent'));
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
  { key: 'githubCopilot', label: 'GitHub Copilot' },
  { key: 'grok', label: 'Grok (xAI)' },
  { key: 'ollamaCloud', label: 'Ollama Cloud' },
  { key: 'ollamaLocal', label: 'Ollama Local' },
  { key: 'openaiCompat', label: 'OpenAI Compilations' },
  { key: 'mimo', label: 'MiMo (Xiaomi)' },
  { key: 'mimoTokenPlan', label: 'MiMo Token Plan (Xiaomi)' },
];

function getConfiguredProviderNames(config: MercuryConfig): ProviderName[] {
  // Include all selectable providers plus chatgptWeb (which is a sub-option of OpenAI)
  const allProviderKeys: ProviderName[] = [
    ...PROVIDER_OPTIONS.map((option) => option.key),
    'chatgptWeb',
  ];
  return allProviderKeys.filter((key) => isProviderConfigured(config.providers[key]));
}

function getProviderLabel(name: ProviderName): string {
  if (name === 'chatgptWeb') return 'OpenAI (ChatGPT Plus/Pro)';
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
      ? chalk.white('  Choose providers to configure [comma-separated, Enter to keep current]: ')
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
    // On reconfig, Enter with no input means "keep current, don't re-prompt"
    return [];
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

  if (provider === 'mimo') {
    return /^sk-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'MiMo keys must start with `sk-`.';
  }

  if (provider === 'mimoTokenPlan') {
    return /^tp-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'MiMo Token Plan keys must start with `tp-`.';
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
        : `Mercury could not fetch models for ${providerLabel}.`;
      console.log(chalk.yellow(`  ${message}`));
      console.log(chalk.dim('  The API key looks valid but Mercury could not reach the provider.'));
      console.log(chalk.dim(`  You can enter a model name manually, or skip ${providerLabel} for now.`));

      const manualModel = await ask(chalk.white(`  ${providerLabel} model name (Enter to skip ${providerLabel} for now): `));
      if (!manualModel) {
        if (isReconfig && existingConfig.apiKey) {
          return { apiKey: existingConfig.apiKey, model: existingConfig.model, skipped: true };
        }
        return { skipped: true };
      }

      const modelError = validateModelName(manualModel);
      if (modelError) {
        console.log(chalk.red(`  ${modelError}`));
        continue;
      }

      return { apiKey: value, model: manualModel, skipped: false };
    }
  }
}

async function promptOllamaLocalModelSelection(config: MercuryConfig, isReconfig: boolean): Promise<{ baseUrl?: string; model?: string; skipped: boolean }> {
  const existingConfig = config.providers.ollamaLocal;

  const baseUrlPrompt = isReconfig && existingConfig.baseUrl
    ? chalk.white(`  Ollama Local base URL [${existingConfig.baseUrl}]: `)
    : chalk.white('  Ollama Local base URL (Enter to skip, or "none" to skip): ');
  const baseUrlInput = await ask(baseUrlPrompt);
  if (!baseUrlInput || baseUrlInput.toLowerCase() === 'none') {
    if (isReconfig && existingConfig.baseUrl) {
      return { baseUrl: existingConfig.baseUrl, model: existingConfig.model, skipped: true };
    }
    return { skipped: true };
  }
  const baseUrlError = validateBaseUrl(baseUrlInput);
  if (baseUrlError) {
    console.log(chalk.red(`  ${baseUrlError}`));
    if (isReconfig && existingConfig.baseUrl) {
      return { baseUrl: existingConfig.baseUrl, model: existingConfig.model, skipped: true };
    }
    return { skipped: true };
  }
  const baseUrl = baseUrlInput;

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
      : 'Mercury could not fetch Ollama Local models.';
    console.log(chalk.yellow(`  ${message}`));
    console.log(chalk.dim('  Make sure Ollama is running locally, or enter the model name manually.'));
    console.log(chalk.dim('  You can run `mercury doctor` later to configure Ollama after starting it.'));

    const manualModel = await ask(chalk.white(`  Ollama Local model name (Enter to skip Ollama Local for now): `));
    if (!manualModel) {
      return { skipped: true };
    }

    const modelError = validateModelName(manualModel);
    if (modelError) {
      console.log(chalk.red(`  ${modelError}`));
      return { skipped: true };
    }

    return { baseUrl, model: manualModel, skipped: false };
  }
}

async function promptOpenAICompatSetup(config: MercuryConfig, isReconfig: boolean): Promise<{ baseUrl?: string; apiKey?: string; model?: string; skipped: boolean }> {
  const existingConfig = config.providers.openaiCompat;

  const baseUrl = (await promptValidatedValue(
    chalk.white(`  Server base URL${isReconfig && existingConfig.baseUrl ? ` [${existingConfig.baseUrl}]` : ''}: `),
    validateBaseUrl,
    existingConfig.baseUrl,
  ))!;
  if (!baseUrl) return { skipped: true };

  const apiKeyPrompt = isReconfig && existingConfig.apiKey
    ? chalk.white(`  API key (optional, press Enter to keep current) [${maskKey(existingConfig.apiKey)}]: `)
    : chalk.white('  API key (optional, press Enter to skip): ');
  const apiKey = await ask(apiKeyPrompt);
  const resolvedApiKey = apiKey || existingConfig.apiKey || '';

  console.log(chalk.dim('  Fetching models from server...'));
  try {
    const catalog = await fetchProviderModelCatalog('openaiCompat', {
      ...existingConfig,
      baseUrl,
      apiKey: resolvedApiKey,
    });
    const model = await chooseProviderModel(
      'OpenAI Compilations',
      catalog.recommendedModel,
      catalog.models,
    );
    return { baseUrl, apiKey: resolvedApiKey, model, skipped: false };
  } catch {
    console.log(chalk.yellow('  Could not fetch models from this server. You can enter the model name manually.'));
    const model = (await promptValidatedValue(
      chalk.white('  Model name: '),
      validateModelName,
    ))!;
    if (!model) return { baseUrl, apiKey: resolvedApiKey, model: existingConfig.model, skipped: false };
    return { baseUrl, apiKey: resolvedApiKey, model, skipped: false };
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
    console.log(chalk.dim('  Choose one or more providers. You can skip any provider by pressing Enter.'));
    console.log(chalk.dim('  Press Enter to configure DeepSeek by default (free at platform.deepseek.com).'));
  }
  console.log('');

   while (true) {
    const selectedProviders = await chooseProvidersToConfigure(config, isReconfig);
    console.log('');

    // On reconfig, if user pressed Enter (empty input), they want to keep
    // current providers unchanged — skip the per-provider prompts entirely.
    if (isReconfig && selectedProviders.length === 0) {
      break;
    }

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
        // Ask user which OpenAI auth method to use
        const authMethod = await selectWithArrowKeys(
          'OpenAI Authentication',
          [
            { value: 'apikey', label: 'API Key (platform.openai.com)' },
            { value: 'oauth', label: 'ChatGPT Plus/Pro (OAuth — use your subscription)' },
            { value: 'skip', label: 'Skip OpenAI' },
          ],
        );

        if (authMethod === 'skip' || !authMethod) {
          continue;
        }

        if (authMethod === 'apikey') {
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

        if (authMethod === 'oauth') {
          // ChatGPT Plus/Pro OAuth flow
          const { loadChatGPTSession, isChatGPTSessionValid } = await import('./auth/chatgpt-session.js');
          const existing = loadChatGPTSession();
          const alreadyLoggedIn = existing && isChatGPTSessionValid(existing);

          let session = existing;

          if (alreadyLoggedIn) {
            console.log(chalk.green('  ✓ ChatGPT Plus/Pro already authenticated'));
            if (existing!.userEmail) console.log(chalk.dim(`    Account: ${existing!.userEmail}`));
            if (existing!.plan) console.log(chalk.dim(`    Plan: ${existing!.plan}`));
            const reauth = await ask(chalk.white('  Re-authenticate? [y/N]: '));
            if (reauth.toLowerCase() !== 'y') {
              session = existing;
            } else {
              session = null;
            }
          }

          if (!session || !isChatGPTSessionValid(session)) {
            console.log(chalk.dim('  Uses your ChatGPT Plus/Pro subscription via OAuth — no API billing.'));
            console.log(chalk.dim('  A browser window will open for you to authorize Mercury.'));

            try {
              const { loginChatGPT } = await import('./auth/chatgpt-auth.js');
              session = await loginChatGPT();
            } catch (err: any) {
              console.log(chalk.red(`  ✗ ChatGPT OAuth login failed: ${err.message || err}`));
              continue;
            }
          }

          if (session && session.accessToken) {
            try {
              const { fetchChatGPTModels } = await import('./auth/chatgpt-models.js');
              console.log(chalk.dim('  Fetching available models...'));
              const catalog = await fetchChatGPTModels(session.accessToken, session.accountId);
              const model = await chooseProviderModel(
                'ChatGPT Plus/Pro',
                catalog.recommendedModel,
                catalog.models,
              );
              config.providers.chatgptWeb.apiKey = '';
              config.providers.chatgptWeb.model = model;
              config.providers.chatgptWeb.enabled = true;
              console.log(chalk.green(`  ✓ OpenAI (ChatGPT Plus/Pro) configured with model: ${model}`));
            } catch (err: any) {
              console.log(chalk.yellow(`  Could not fetch models: ${err.message || err}`));
              const defaultModel = 'gpt-5.4-mini';
              const manualModel = await ask(chalk.white(`  Enter model name [Enter for ${defaultModel}]: `));
              const model = manualModel || defaultModel;
              config.providers.chatgptWeb.apiKey = '';
              config.providers.chatgptWeb.model = model;
              config.providers.chatgptWeb.enabled = true;
              console.log(chalk.green(`  ✓ OpenAI (ChatGPT Plus/Pro) configured with model: ${model}`));
            }
          }
          continue;
        }
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
        const result = await promptOllamaLocalModelSelection(config, isReconfig);
        if (!result.skipped && result.baseUrl && result.model) {
          config.providers.ollamaLocal.baseUrl = result.baseUrl;
          config.providers.ollamaLocal.model = result.model;
          config.providers.ollamaLocal.enabled = true;
        }
        continue;
      }

      if (provider === 'openaiCompat') {
        const result = await promptOpenAICompatSetup(config, isReconfig);
        if (!result.skipped && result.baseUrl && result.model) {
          config.providers.openaiCompat.baseUrl = result.baseUrl;
          config.providers.openaiCompat.model = result.model;
          config.providers.openaiCompat.enabled = true;
          if (result.apiKey) {
            config.providers.openaiCompat.apiKey = result.apiKey;
          }
        }
        continue;
      }

      if (provider === 'mimo') {
        const mask = isReconfig && config.providers.mimo.apiKey ? ` [${maskKey(config.providers.mimo.apiKey)}]` : '';
        const result = await promptApiKeyWithModelSelection(
          config,
          'mimo',
          'MiMo',
          chalk.white(`  MiMo API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          isReconfig,
        );
        if (!result.skipped && result.apiKey && result.model) {
          config.providers.mimo.apiKey = result.apiKey;
          config.providers.mimo.model = result.model;
          config.providers.mimo.enabled = true;
        }
        continue;
      }

      if (provider === 'mimoTokenPlan') {
        const mask = isReconfig && config.providers.mimoTokenPlan.apiKey ? ` [${maskKey(config.providers.mimoTokenPlan.apiKey)}]` : '';
        const result = await promptApiKeyWithModelSelection(
          config,
          'mimoTokenPlan',
          'MiMo Token Plan',
          chalk.white(`  MiMo Token Plan API key${mask}${isReconfig ? '' : ' (Enter to skip)'}: `),
          isReconfig,
        );
        if (!result.skipped && result.apiKey && result.model) {
          config.providers.mimoTokenPlan.apiKey = result.apiKey;
          config.providers.mimoTokenPlan.model = result.model;
          config.providers.mimoTokenPlan.enabled = true;
        }
        continue;
      }

      if (provider === 'githubCopilot') {
        const { loadGitHubSession, isGitHubSessionValid } = await import('./auth/github-session.js');
        const existing = loadGitHubSession();
        const alreadyLoggedIn = existing && isGitHubSessionValid(existing);

        let session = existing;

        if (alreadyLoggedIn) {
          console.log(chalk.green('  ✓ GitHub Copilot already authenticated'));
          if (existing!.userLogin) console.log(chalk.dim(`    Account: @${existing!.userLogin}`));
          const reauth = await ask(chalk.white('  Re-authenticate? [y/N]: '));
          if (reauth.toLowerCase() !== 'y') {
            session = existing;
          } else {
            session = null;
          }
        }

        if (!session || !isGitHubSessionValid(session)) {
          console.log(chalk.dim('  GitHub Copilot uses your GitHub account via OAuth.'));
          console.log(chalk.dim('  A browser window will open for you to authorize Mercury.'));
          const proceed = await ask(chalk.white('  Set up GitHub Copilot? [Y/n]: '));

          if (proceed.toLowerCase() === 'n') {
            continue;
          }

          try {
            const { loginGitHub } = await import('./auth/github-auth.js');
            session = await loginGitHub();
          } catch (err: any) {
            console.log(chalk.red(`  ✗ GitHub OAuth login failed: ${err.message || err}`));
            continue;
          }
        }

        if (session && session.accessToken) {
          try {
            const { fetchGitHubModels } = await import('./auth/github-models.js');
            console.log(chalk.dim('  Fetching available models...'));
            const catalog = await fetchGitHubModels(session.accessToken);
            const model = await chooseProviderModel(
              'GitHub Copilot',
              catalog.recommendedModel,
              catalog.models,
            );
            config.providers.githubCopilot.apiKey = '';
            config.providers.githubCopilot.model = model;
            config.providers.githubCopilot.enabled = true;
            console.log(chalk.green(`  ✓ GitHub Copilot configured with model: ${model}`));
          } catch (err: any) {
            console.log(chalk.yellow(`  Could not fetch models: ${err.message || err}`));
            const defaultModel = 'openai/gpt-4.1';
            const manualModel = await ask(chalk.white(`  Enter model name [Enter for ${defaultModel}]: `));
            const model = manualModel || defaultModel;
            config.providers.githubCopilot.apiKey = '';
            config.providers.githubCopilot.model = model;
            config.providers.githubCopilot.enabled = true;
            console.log(chalk.green(`  ✓ GitHub Copilot configured with model: ${model}`));
          }
        }
        continue;
      }
    }

    const configuredProviders = getConfiguredProviderNames(config);
    if (configuredProviders.length === 0) {
      console.log('');
      console.log(chalk.yellow('  No LLM providers were configured.'));
      console.log(chalk.dim('  Mercury needs at least one provider to work.'));
      console.log(chalk.dim('  DeepSeek offers a free API key at platform.deepseek.com'));
      console.log('');
      console.log(chalk.white('  Options:'));
      console.log(chalk.white('    1. Try again — choose a provider and enter an API key'));
      console.log(chalk.white('    2. Skip for now — you can run `mercury doctor` later'));
      console.log('');

      const skipChoice = await ask(chalk.white('  Press Enter to try again, or type "skip" to exit setup: '));
      if (skipChoice.toLowerCase() === 'skip') {
        saveConfig(config);
        const home = getMercuryHome();
        console.log('');
        console.log(chalk.green(`  ✓ Config saved to ${home}/mercury.yaml`));
        console.log(chalk.yellow('  No providers configured yet. Run `mercury doctor` when ready.'));
        console.log('');
        process.exit(0);
      }

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
  console.log(chalk.dim('  You can add it later with mercury doctor.'));
  console.log('');

  const ghSetup = await ask(chalk.white('  Configure GitHub? (y/N): '));
  if (ghSetup.toLowerCase() === 'y' || ghSetup.toLowerCase() === 'yes') {
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
  }

  hr();
  console.log('');
  console.log(chalk.bold.white('  Spotify Integration (optional)'));
  console.log(chalk.dim('  Connect Mercury to your Spotify so it can play music,'));
  console.log(chalk.dim('  manage playlists, and act as your DJ on any of your devices.'));
  console.log(chalk.dim('  You can add it later with mercury doctor.'));
  console.log('');

  const spotifySetup = await ask(chalk.white('  Configure Spotify? (y/N): '));
  if (spotifySetup.toLowerCase() === 'y' || spotifySetup.toLowerCase() === 'yes') {
    console.log('');
    console.log(chalk.dim('     1. Go to developer.spotify.com/dashboard'));
    console.log(chalk.dim('     2. Click "Create app" — set name: Mercury'));
    console.log(chalk.dim('     3. Set redirect URI: http://127.0.0.1:8888/callback'));
    console.log(chalk.dim('     4. Copy the Client ID and Client Secret'));
    console.log('');

    const spotifyIdCurrent = isReconfig && config.spotify.clientId ? ` [${maskKey(config.spotify.clientId)}]` : '';
    const spotifyClientId = await ask(chalk.white(`  1. Spotify Client ID${spotifyIdCurrent}: `));
    if (spotifyClientId) {
      config.spotify.clientId = spotifyClientId;
      appendToEnv('SPOTIFY_CLIENT_ID', spotifyClientId);
    }

    const spotifySecretCurrent = isReconfig && config.spotify.clientSecret ? ` [${maskKey(config.spotify.clientSecret)}]` : '';
    const spotifyClientSecret = await ask(chalk.white(`  2. Spotify Client Secret${spotifySecretCurrent}: `));
    if (spotifyClientSecret) {
      config.spotify.clientSecret = spotifyClientSecret;
      appendToEnv('SPOTIFY_CLIENT_SECRET', spotifyClientSecret);
    }

    if (spotifyClientId || spotifyClientSecret) {
      config.spotify.enabled = true;
      console.log('');
      console.log(chalk.dim('     After Mercury starts, run /spotify auth to connect your account.'));
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

  const home = getMercuryHome();
  console.log('');
  console.log(chalk.green(`  ✓ Config saved to ${home}/mercury.yaml`));
  console.log(chalk.green(`  ✓ Soul files seeded in ${home}/soul/`));
  console.log(chalk.green(`  ✓ Memory stored in ${home}/memory/`));
  console.log(chalk.green(`  ✓ Permissions seeded in ${home}/permissions.yaml`));
  console.log(chalk.green(`  ✓ Skills directory ready in ${home}/skills/`));
  if (config.spotify.clientId) {
    console.log(chalk.green(`  ✓ Spotify configured — run /spotify auth to connect your account`));
  }
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

function runPlatformDoctor(): void {
  const daemon = getDaemonStatus();
  const termProgram = process.env.TERM_PROGRAM || 'unknown';
  const term = process.env.TERM || 'unknown';
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rawModeSupported = Boolean(process.stdin.isTTY && typeof (process.stdin as NodeJS.ReadStream).setRawMode === 'function');
  const sshSession = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  const ci = process.env.CI === 'true';
  const canInlineArt = termProgram === 'iTerm.app' && !sshSession && !ci;

  console.log('');
  console.log(chalk.bold.cyan('  Mercury Platform Doctor'));
  console.log(chalk.dim('  Cross-platform runtime compatibility report'));
  console.log('');
  console.log(`  OS:                 ${chalk.white(process.platform)} (${process.arch})`);
  console.log(`  Node.js:            ${chalk.white(process.version)} (required >= 20)`);
  console.log(`  Terminal program:   ${chalk.white(termProgram)}`);
  console.log(`  TERM:               ${chalk.white(term)}`);
  console.log(`  Interactive TTY:    ${isTTY ? chalk.green('yes') : chalk.yellow('no')}`);
  console.log(`  Raw mode support:   ${rawModeSupported ? chalk.green('yes') : chalk.yellow('no')}`);
  console.log(`  SSH session:        ${sshSession ? chalk.yellow('yes') : chalk.green('no')}`);
  console.log(`  CI environment:     ${ci ? chalk.yellow('yes') : chalk.green('no')}`);
  console.log(`  Daemon:             ${daemon.running ? chalk.green(`running (PID: ${daemon.pid})`) : chalk.dim('not running')}`);
  console.log(`  Spotify inline art: ${canInlineArt ? chalk.green('supported (iTerm local)') : chalk.dim('disabled/fallback mode')}`);
  console.log('');
  console.log(chalk.bold.white('  Keybinding Notes'));
  console.log(`  • View toggle:      ${chalk.white('Ctrl+T')} (fallback: ${chalk.white('/view')})`);
  console.log(`  • Workspace exit:   ${chalk.white('Esc')} or ${chalk.white('Ctrl+Q')} (fallback: ${chalk.white('/ws exit')})`);
  console.log(`  • Code mode switch: ${chalk.white('Ctrl+P')} plan, ${chalk.white('Ctrl+X')} execute`);
  console.log('');

  if (!rawModeSupported) {
    console.log(chalk.yellow('  Warning: Raw mode is unavailable; interactive Ink input may be limited in this terminal.'));
    console.log(chalk.dim('  Try a local terminal session with TTY support for the best experience.'));
    console.log('');
  }
}

async function runAgent(isDaemon: boolean = false): Promise<void> {
  let config = loadConfig();
  config = ensureCreatorField(config);
  const name = config.identity.name;

  if (!isDaemon) {
    logger.info(`${name} is waking up...`);
  } else {
    logger.info(`${name} is waking up (daemon mode)...`);
  }

  const tokenBudget = new TokenBudget(config);
  const providers = await ProviderRegistry.create(config);

  if (!providers.hasProviders()) {
    if (isDaemon) {
      logger.error('No LLM providers available. Run `mercury doctor` to configure providers.');
      return;
    }
    console.log(chalk.red('  No LLM providers available. Run `mercury doctor` to configure providers.'));
    process.exit(1);
  }

  const available = providers.listAvailable();
  const defaultProvider = config.providers.default;
  const defaultModel = config.providers[defaultProvider]?.model ?? 'unknown';

  if (!isDaemon) {
    const providerSummary = available.map((provider) => {
      const key = provider as ProviderName;
      const label = getProviderLabel(key);
      const model = config.providers[key]?.model ?? '?';
      const marker = key === defaultProvider ? ' ← default' : '';
      return `${label}: ${model}${marker}`;
    });
    logger.info({ providers: providerSummary, default: getProviderLabel(defaultProvider) }, 'Providers loaded');
  } else {
    logger.info({ providers: available, default: defaultProvider }, 'Providers loaded');
  }

  const skillLoader = new SkillLoader();
  const skills = skillLoader.discover();
  if (!isDaemon) {
    logger.info(`Skills: ${skills.length > 0 ? skills.map(s => s.name).join(', ') : 'none installed'}`);
  }

  const scheduler = new Scheduler(config);

  const identity = new Identity();
  migrateLegacyMemory();
  const shortTerm = new ShortTermMemory(config);
  const longTerm = new LongTermMemory(config);
  const episodic = new EpisodicMemory(config);

  let userMemory: UserMemoryStore | null = null;
  if (config.memory.secondBrain?.enabled !== false && isBetterSqlite3Available()) {
    try {
      userMemory = new UserMemoryStore(config);
      if (!isDaemon) {
        logger.info(`Second brain: enabled (${userMemory.getSummary().total} existing memories)`);
      } else {
        logger.info({ total: userMemory.getSummary().total }, 'Second brain loaded');
      }
    } catch (err) {
      logger.warn({ err }, 'Second brain initialization failed, continuing without it');
      userMemory = null;
    }
  } else if (config.memory.secondBrain?.enabled !== false && !isBetterSqlite3Available()) {
    logger.warn(
      'better-sqlite3 is not available — second brain memory is disabled. ' +
      'To enable it, install build tools (make, gcc/g++, python3) and ensure Node >= 20, then reinstall.'
    );
  }

  const channels = new ChannelRegistry(config);
  const capabilities = new CapabilityRegistry(skillLoader, scheduler, tokenBudget);

  let supervisor: SubAgentSupervisor | undefined;
  if (config.subagents.enabled) {
    supervisor = new SubAgentSupervisor({
      agentConfig: config,
      providers,
      identity,
      shortTerm,
      longTerm,
      episodic,
      userMemory,
      capabilities,
      tokenBudget,
      channels,
    });
    if (config.subagents.mode === 'manual' && config.subagents.maxConcurrent > 0) {
      supervisor.setMaxConcurrent(config.subagents.maxConcurrent);
    }
    capabilities.setSupervisor(supervisor);
  }

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

  if (supervisor) {
    agent.setSupervisor(supervisor);
  }

  let spotifyClient: SpotifyClient | undefined;
  if (config.spotify.clientId && config.spotify.clientSecret) {
    spotifyClient = new SpotifyClient(config);
    capabilities.setSpotifyClient(spotifyClient);
    capabilities.registerSpotifyTools();
    agent.setSpotifyClient(spotifyClient);

    if (spotifyClient.isAuthenticated()) {
      if (!spotifyClient.getAccountName()) {
        spotifyClient.saveAccountInfo().catch(() => {});
      }
      spotifyClient.checkPremium().catch(() => {});

      const accountName = spotifyClient.getAccountName();
      const label = accountName ? ` as ${accountName}` : '';
      logger.info(`Spotify connected${label} (token available)`);
    } else {
      logger.info('Spotify: not connected — run /spotify auth to link your account');
    }
  }

  if (!isDaemon) {
    const bootCli = channels.getCliChannel();
    if (bootCli) {
      await channels.startAll();
      const skillInfos = skills.map((s) => ({ name: s.name, description: s.description, loaded: true }));
      bootCli.initSplash(name, pkgVersion);
      bootCli.setSkills(skillInfos);
      bootCli.setProvider(getProviderLabel(defaultProvider), defaultModel);
      bootCli.setTokenInfo(tokenBudget.getDailyUsed(), tokenBudget.getBudget(), Math.round(tokenBudget.getUsagePercentage()));
      bootCli.mountTUI((inputText: string) => {
        bootCli.sendUserMessage(inputText);
      }, spotifyClient, () => {
        process.exit(0);
      });
    } else {
      await channels.startAll();
    }
  }

  await agent.birth();
  await agent.wake();

  const cliChannel = channels.get('cli') as CLIChannel | undefined;
  const tgChannel = channels.get('telegram') as TelegramChannel | undefined;

  if (tgChannel) {
    tgChannel.setChatCommandContext(capabilities.getChatCommandContext()!);
  }

  capabilities.permissions.onAsk(async (prompt: string) => {
    const channelType = capabilities.permissions.getCurrentChannelType();
    if (channelType === 'telegram' && tgChannel) {
      return tgChannel.askPermission(prompt);
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
      logger.info(`Creator: ${config.identity.creator}`);
    }

    const mode = cliChannel && await cliChannel.askPermissionMode?.();
    if (mode === 'allow-all') {
      capabilities.permissions.setAutoApproveAll(true);
      capabilities.permissions.addTempScope('/', true, true);
    }
  } else {
    await channels.startAll();
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
  .description('Reconfigure Mercury setup (name, providers, channels, permissions defaults)')
  .option('--platform', 'Show platform compatibility diagnostics')
  .action(async (opts) => {
    if (opts.platform) {
      runPlatformDoctor();
      return;
    }
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
    const spotify = config.spotify;
    if (spotify.clientId && spotify.clientSecret) {
      if (spotify.enabled && (spotify.accessToken || spotify.refreshToken)) {
        const label = spotify.accountName ? ` as ${spotify.accountName}` : '';
        const plan = spotify.product ? ` (${spotify.product})` : '';
        console.log(`  Spotify:  ${chalk.green(`connected${label}`)}${plan}`);
      } else {
        console.log(`  Spotify:  ${chalk.dim('not connected')} — run /spotify auth`);
      }
    } else {
      console.log(`  Spotify:  ${chalk.dim('not configured')}`);
    }
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

program.parse();
