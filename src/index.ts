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
  getSignalAccessSummary,
  hasSignalAdmins as hasSignalAdminsFn,
  findSignalPendingRequest,
  approveSignalPendingRequestByPairingCode,
  clearSignalAccess,
  getDiscordAccessSummary,
  hasDiscordAdmins as hasDiscordAdminsFn,
  findDiscordPendingRequest,
  approveDiscordPendingRequest,
  approveDiscordPendingRequestByPairingCode,
  rejectDiscordPendingRequest,
  removeDiscordUser,
  clearDiscordAccess,
  getSlackAccessSummary,
  findSlackPendingRequest,
  approveSlackPendingRequest,
  rejectSlackPendingRequest,
  removeSlackUser,
  clearSlackAccess,
} from './utils/config.js';
import type { MercuryConfig } from './utils/config.js';
import type { ProviderName } from './utils/config.js';
import { logger } from './utils/logger.js';
import { redactPhone } from './utils/redact.js';
import { Identity } from './soul/identity.js';
import { ShortTermMemory, LongTermMemory, EpisodicMemory, migrateLegacyMemory } from './memory/store.js';
import { UserMemoryStore } from './memory/user-memory.js';
import { isBetterSqlite3Available } from './memory/second-brain-db.js';
import { ProviderRegistry } from './providers/registry.js';
import { Agent } from './core/agent.js';
import { Scheduler } from './core/scheduler.js';
import { SubAgentSupervisor } from './core/supervisor.js';
import { BoardManager } from './core/board-manager.js';
import { SpotifyClient } from './spotify/client.js';
import { ChannelRegistry } from './channels/registry.js';
import { CLIChannel } from './channels/cli.js';
import { TelegramChannel } from './channels/telegram.js';
import { SignalChannel } from './channels/signal.js';
import { DiscordChannel } from './channels/discord.js';
import { WebChannel } from './channels/web.js';
import { TokenBudget } from './utils/tokens.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { SkillLoader } from './skills/loader.js';
import { registerSkillsCommand } from './skills/cli.js';
import { getManual } from './utils/manual.js';
import { startBackground, stopDaemon, showLogs, getDaemonStatus, restartDaemon, tryAutoDaemonize, isStandaloneBinary } from './cli/daemon.js';
import { installService, uninstallService, showServiceStatus, isServiceInstalled } from './cli/service.js';
import { runWithWatchdog } from './cli/watchdog.js';
import { setGitHubToken } from './utils/github.js';
import { selectWithArrowKeys } from './utils/arrow-select.js';
import { ProviderModelFetchError, fetchProviderModelCatalog } from './utils/provider-models.js';
import { startWebServer, stopWebServer, updateStatus as updateWebStatus, setUserMemory as setWebUserMemory, setWebChannel as setWebWebChannel, setScheduler as setWebScheduler, setAgentSupervisor as setWebSupervisor, setBackgroundTaskManager as setWebBgTasks, setSpotifyClient as setWebSpotify, setProgrammingMode as setWebProgrammingMode, setModelSwitchCallback as setWebModelSwitch, setCurrentProviderCallback as setWebCurrentProvider, setKanbanSupervisor as setWebKanban, setKanbanBoardManager as setWebBoardManager, setKanbanProviders as setWebKanbanProviders, setIDEProviders as setWebIDEProviders } from './web/server.js';
import { isWebAuthInitialized, setWebPassword } from './web/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pkgVersion: string;
try {
  // Normal (npm) install: package.json sits one level above dist/.
  pkgVersion = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
} catch {
  // Standalone binary (Bun --compile / pkg / SEA): package.json is not on
  // disk next to the embedded bundle. Use the version injected at build
  // time, falling back to 'unknown' so the CLI still launches.
  pkgVersion = (globalThis as any).__MERCURY_VERSION__ ?? 'unknown';
}

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
  console.log(chalk.dim(`  v${pkgVersion} · by Cosmic Stack · mercuryagent.sh`));
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
  console.log(chalk.dim('  mercuryagent.sh'));
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

function formatSignalUser(user: {
  phoneNumber: string;
  name?: string;
  role?: string;
}): string {
  const name = user.name ? ` (${user.name})` : '';
  const role = user.role ? ` [${user.role}]` : '';
  return `${redactPhone(user.phoneNumber)}${name}${role}`;
}

function printSignalAccessState(config: MercuryConfig): void {
  const admins = config.channels.signal.admins;
  const members = config.channels.signal.members;
  const pending = config.channels.signal.pending;
  const pendingSummary = pending.length > 0
    ? pending.map((entry) => `${entry.phoneNumber} [code: ${entry.pairingCode}]`).join(', ')
    : '';

  console.log('');
  console.log(`  Signal Access: ${chalk.white(getSignalAccessSummary(config))}`);
  console.log(`  Mode:            ${chalk.white(config.channels.signal.mode)}`);
  if (config.channels.signal.groupId) {
    console.log(`  Group:           ${chalk.white(config.channels.signal.groupName || config.channels.signal.groupId)}`);
  }
  console.log(`  Admins:          ${admins.length > 0 ? chalk.green(admins.map(formatSignalUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Members:         ${members.length > 0 ? chalk.green(members.map(formatSignalUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Pending:         ${pending.length > 0 ? chalk.yellow(pendingSummary) : chalk.dim('none')}`);
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

function formatDiscordUser(user: {
  userId: string;
  username?: string;
  displayName?: string;
  role?: string;
}): string {
  const username = user.username ? ` (@${user.username})` : '';
  const displayName = user.displayName ? ` ${user.displayName}` : '';
  const role = user.role ? ` [${user.role}]` : '';
  return `${user.userId}${username}${displayName}${role}`;
}

function printDiscordAccessState(config: MercuryConfig): void {
  const admins = config.channels.discord.admins;
  const members = config.channels.discord.members;
  const pending = config.channels.discord.pending;
  const pendingSummary = pending.length > 0
    ? pending.map((entry) => {
        const code = entry.pairingCode ? ` [code: ${entry.pairingCode}]` : '';
        return `${formatDiscordUser(entry)}${code}`;
      }).join(', ')
    : '';

  console.log('');
  console.log(`  Discord Access:  ${chalk.white(getDiscordAccessSummary(config))}`);
  if (config.channels.discord.guildId) {
    console.log(`  Guild:            ${chalk.white(config.channels.discord.guildId)}`);
  }
  if (config.channels.discord.channelId) {
    console.log(`  Channel:          ${chalk.white(config.channels.discord.channelId)}`);
  }
  if (config.channels.discord.adminRoleName) {
    console.log(`  Admin Role:        ${chalk.white(config.channels.discord.adminRoleName)}`);
  }
  console.log(`  Admins:           ${admins.length > 0 ? chalk.green(admins.map(formatDiscordUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Members:          ${members.length > 0 ? chalk.green(members.map(formatDiscordUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Pending:          ${pending.length > 0 ? chalk.yellow(pendingSummary) : chalk.dim('none')}`);
}

function formatSlackUser(user: { userId: string; userName?: string; displayName?: string }): string {
  const userName = user.userName ? ` (@${user.userName})` : '';
  const displayName = user.displayName ? ` ${user.displayName}` : '';
  return `${user.userId}${userName}${displayName}`;
}

function printSlackAccessState(config: MercuryConfig): void {
  const admins = config.channels.slack.admins;
  const members = config.channels.slack.members;
  const pending = config.channels.slack.pending;
  const pendingSummary = pending.length > 0
    ? pending.map((entry) => formatSlackUser(entry)).join(', ')
    : '';

  console.log('');
  console.log(`  Slack Access:  ${chalk.white(getSlackAccessSummary(config))}`);
  if (config.channels.slack.teamId) {
    console.log(`  Team:           ${chalk.white(config.channels.slack.teamId)}`);
  }
  if (config.channels.slack.channelId) {
    console.log(`  Channel:        ${chalk.white(config.channels.slack.channelId)}`);
  }
  console.log(`  Admins:         ${admins.length > 0 ? chalk.green(admins.map(formatSlackUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Members:        ${members.length > 0 ? chalk.green(members.map(formatSlackUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Pending:        ${pending.length > 0 ? chalk.yellow(pendingSummary) : chalk.dim('none')}`);
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

async function completeInitialSignalSetup(config: MercuryConfig): Promise<void> {
  if (!config.channels.signal.enabled || !config.channels.signal.phoneNumber) {
    return;
  }

  // Already paired
  if (hasSignalAdminsFn(config)) {
    console.log(chalk.green('  ✓ Signal already paired.'));
    if (config.channels.signal.mode === 'group' && config.channels.signal.groupName) {
      console.log(chalk.dim(`  Group: ${config.channels.signal.groupName}`));
    }
    console.log(chalk.dim('  To unregister, run: mercury signal unregister'));
    console.log('');
    const keepConfig = await ask(chalk.white('  Keep the existing configuration? (Y/n): '));
    if (keepConfig.toLowerCase() !== 'n' && keepConfig.toLowerCase() !== 'no') {
      return;
    }
    // Clear pairing data but keep phone number — fall through to fresh pairing
    config.channels.signal.admins = [];
    config.channels.signal.members = [];
    config.channels.signal.pending = [];
    config.channels.signal.groupId = undefined;
    config.channels.signal.groupName = undefined;

    // Re-ask mode since we're starting fresh
    const modeAnswer = await ask(chalk.white('  Mode — group or private? [group]: '));
    config.channels.signal.mode = modeAnswer.toLowerCase().startsWith('private') ? 'private' : 'group';
    saveConfig(config);
    console.log(chalk.dim('  Configuration cleared. Starting fresh pairing...'));

    // Kill any running signal-cli daemon so group list is fresh
    try {
      const { killStaleSignalCliProcesses } = await import('./signal/jsonrpc.js');
      killStaleSignalCliProcesses();
    } catch { /* ignore */ }
  }

  console.log('');
  console.log(chalk.bold.white('  Signal Setup'));

  const { ensureSignalCli, checkJavaAvailable, isNativeAvailable } = await import('./signal/binary.js');
  const { checkSignalSetup, registerSignalNumber, verifySignalNumber, startLinking, waitForLinkCompletion, cancelLinking, printQrCode } = await import('./signal/setup.js');

  // Step 1: Check Java if needed (macOS/Windows have no native binary)
  if (!isNativeAvailable() && !checkJavaAvailable()) {
    console.log(chalk.red('  ✗ Java (JRE 17+) is required for Signal on this platform.'));
    console.log(chalk.dim('  No native signal-cli binary is available for macOS/Windows.'));
    console.log(chalk.dim('  Install Java: https://adoptium.net/ or run: brew install openjdk'));
    console.log(chalk.dim('  Then re-run: mercury doctor'));
    return;
  }

  // Step 2: Download signal-cli binary
  try {
    const binaryPath = await ensureSignalCli();
    const { isWrapperScript, isJarBinary: isJar } = await import('./signal/binary.js');
    const binaryType = isWrapperScript(binaryPath) ? 'JAR (wrapper)'
      : isJar(binaryPath) ? 'JAR'
      : 'native binary';
    console.log(chalk.green(`  ✓ signal-cli installed (${binaryType})`));
  } catch (err: any) {
    console.log(chalk.red(`  ✗ Failed to download signal-cli: ${err.message}`));
    if (!isNativeAvailable()) {
      console.log(chalk.dim('  Make sure Java (JRE 17+) is installed and accessible.'));
    }
    console.log(chalk.dim('  You can try again later with: mercury doctor'));
    return;
  }

  // Step 3: Check if already linked
  const status = await checkSignalSetup(config);
  if (status.linked) {
    console.log(chalk.green('  ✓ Signal device is already linked.'));
  } else {
    // Step 3b: Register number if needed
    if (!status.registered) {
      console.log(chalk.yellow('  This phone number is not registered with Signal.'));
      console.log(chalk.dim('  You need to register it first:'));

      const registerAnswer = await ask(chalk.white('  Register this number with Signal? (y/N): '));
      if (registerAnswer.toLowerCase() !== 'y' && registerAnswer.toLowerCase() !== 'yes') {
        console.log(chalk.dim('  You can register later by running: mercury signal register'));
        return;
      }

      const voice = await ask(chalk.white('  Verify via SMS or voice call? (sms/voice) [sms]: '));
      const useVoice = voice.toLowerCase().startsWith('voice');

      console.log(chalk.dim('  Sending verification code...'));
      const regResult = await registerSignalNumber(config.channels.signal.phoneNumber, useVoice);
      if (!regResult.success) {
        console.log(chalk.red(`  ✗ Registration failed: ${regResult.error}`));
        return;
      }
      console.log(chalk.green('  ✓ Verification code sent.'));

      const code = await ask(chalk.white('  Enter the verification code: '));
      if (!code) {
        console.log(chalk.red('  Verification code is required.'));
        return;
      }

      const verifyResult = await verifySignalNumber(config.channels.signal.phoneNumber, code.trim());
      if (!verifyResult.success) {
        console.log(chalk.red(`  ✗ Verification failed: ${verifyResult.error}`));
        return;
      }
      console.log(chalk.green('  ✓ Number verified.'));
    }

    // Step 4: Link as secondary device
    console.log('');
    console.log(chalk.dim('  Linking Mercury as a secondary device on your Signal account.'));
    console.log(chalk.dim('  1. Open Signal on your phone'));
    console.log(chalk.dim('  2. Go to Settings > Linked Devices'));
    console.log(chalk.dim('  3. Tap "+" to add a new device'));
    console.log('');

    const linkAnswer = await ask(chalk.white('  Ready to link? Press Enter to generate a QR code...'));
    const session = await startLinking();
    if (!session) {
      console.log(chalk.red('  ✗ Failed to generate linking URI.'));
      console.log(chalk.dim('  Make sure signal-cli is installed and Java is available.'));
      return;
    }

    console.log('');
    console.log(chalk.cyan('  Scan this QR code with Signal:'));
    console.log('');
    printQrCode(session.uri);
    console.log('');
    console.log(chalk.dim('  Mercury is waiting for you to complete the link...'));

    const linked = await waitForLinkCompletion(session, 120_000);
    if (linked) {
      console.log(chalk.green('  ✓ Signal device linked successfully.'));
    } else {
      console.log(chalk.yellow('  Linking timed out or failed.'));
      console.log(chalk.dim('  Run mercury doctor to try again.'));
      return;
    }
  }

  // Step 5: Pairing — start daemon and wait for pairing code
  console.log('');
  console.log(chalk.bold.white('  Signal Pairing'));

  const signalChannel = new SignalChannel(config);
  try {
    await signalChannel.start();
  } catch (err: any) {
    console.log(chalk.red(`  ✗ Failed to start Signal daemon: ${err.message}`));
    console.log(chalk.dim('  Make sure signal-cli is working by running: mercury signal status'));
    console.log(chalk.dim('  You can pair manually by sending /pair in Signal and running: mercury signal approve <code>'));
    return;
  }

  if (!signalChannel.running) {
    console.log(chalk.red('  ✗ Signal daemon did not start.'));
    console.log(chalk.dim('  You can pair manually by sending /pair in Signal and running: mercury signal approve <code>'));
    return;
  }

  // Detect Mercury group now that the daemon is running
  let groupFound = false;
  if (config.channels.signal.mode === 'group') {
    if (config.channels.signal.groupId) {
      groupFound = true;
      console.log(chalk.dim('  Your Mercury group is already configured.'));
    } else {
      console.log(chalk.dim('  Searching for "Mercury" group...'));
      try {
        const group = await signalChannel.listGroups();
        if (group) {
          config.channels.signal.groupId = group.groupId;
          config.channels.signal.groupName = group.groupName;
          saveConfig(config);
          groupFound = true;
          console.log(chalk.green(`  ✓ Found group: ${group.groupName}`));
        }
      } catch {
        // Group search may fail
      }
    }

    if (groupFound) {
      console.log(chalk.dim('  Send /pair in the Mercury group to get a pairing code.'));
    } else {
      console.log(chalk.dim('  1. Create a Signal group named "Mercury" (or use an existing one)'));
      console.log(chalk.dim('  2. Add your linked number to the group'));
      console.log(chalk.dim('  3. Send /pair in the group'));
    }
  } else {
    // Private mode: auto-pair the linked number as admin
    // In private mode, the linked number IS the admin — no need for a pairing code
    if (!hasSignalAdminsFn(config) && config.channels.signal.phoneNumber) {
      config.channels.signal.admins.push({
        phoneNumber: config.channels.signal.phoneNumber,
        role: 'admin',
        pairedAt: new Date().toISOString(),
      });
      saveConfig(config);
      console.log(chalk.green('  ✓ Auto-paired as admin (private mode).'));
      console.log(chalk.dim('  Mercury will respond to messages in your "Note to Self" chat.'));
      console.log('');
      await signalChannel.stop();
      saveConfig(config);
      return;
    }
    console.log(chalk.dim('  Send /pair in your Signal "Note to Self" chat to get a pairing code.'));
  }
  console.log('');

  try {
    while (true) {
      const pairingCode = await ask(chalk.white('  Signal Pairing Code (or press Enter to skip): '));
      if (!pairingCode) {
        console.log(chalk.dim('  You can pair later by sending /pair in Signal and running: mercury signal approve <code>'));
        break;
      }

      // Reload config from disk — SignalChannel may have saved the pending request
      const freshConfig = loadConfig();
      const approved = approveSignalPendingRequestByPairingCode(freshConfig, pairingCode.trim());
      if (!approved) {
        console.log(chalk.red('  That pairing code is not valid. Make sure you sent /pair in Signal and enter the exact code.'));
        continue;
      }

      Object.assign(config, freshConfig);
      saveConfig(config);
      console.log(chalk.green(`  ✓ Signal paired. First admin: ${formatSignalUser(approved)}.`));
      console.log('');
      break;
    }
  } finally {
    await signalChannel.stop();
  }

  saveConfig(config);
}

async function completeInitialDiscordPairing(config: MercuryConfig): Promise<void> {
  if (!config.channels.discord.enabled || !config.channels.discord.botToken || hasDiscordAdminsFn(config)) {
    return;
  }

  console.log('');
  console.log(chalk.bold.white('  Discord Pairing'));
  console.log(chalk.dim('  1. Open Discord and DM your bot.'));
  console.log(chalk.dim('  2. Send /start to receive your pairing code.'));
  console.log(chalk.dim('  3. Paste that pairing code below to finish setup.'));
  console.log('');

  const discordChannel = new DiscordChannel(config);
  try {
    await discordChannel.start();
  } catch (err: any) {
    console.log(chalk.red(`\n  ✗ ${err.message || err}`));
    console.log('');
    await discordChannel.stop();
    return;
  }

  try {
    while (true) {
      const pairingCode = await ask(chalk.white('  Discord Pairing Code: '));
      if (!pairingCode) {
        console.log(chalk.red('  Discord pairing code is required to continue.'));
        continue;
      }

      const approved = approveDiscordPendingRequestByPairingCode(config, pairingCode.trim());
      if (!approved) {
        console.log(chalk.red('  That pairing code is not valid yet. Send /start in Discord, then paste the exact code here.'));
        continue;
      }

      saveConfig(config);
      console.log(chalk.green(`  ✓ Discord paired. First admin: ${formatDiscordUser(approved)}.`));
      console.log('');
      break;
    }
  } finally {
    await discordChannel.stop();
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
  console.log(chalk.bold.white('  Signal (optional)'));
  if (isReconfig && config.channels.signal.phoneNumber) {
    console.log(chalk.dim('  Leave empty to keep current number. Enter "none" to disable Signal.'));
    console.log(chalk.dim('  Enter "reset" to start fresh (clear config, optionally delete binary).'));
    console.log(chalk.dim('  Enter "unregister" to unlink this device from Signal and clear all data.'));
  } else {
    console.log(chalk.dim('  Leave empty to skip. You can add it later with mercury doctor.'));
    console.log(chalk.dim('  Include country code, e.g. +1 for US, +44 for UK, +91 for India.'));
    console.log(chalk.dim('  Signal lets you chat with Mercury through a Signal group or private chat.'));
  }
  console.log('');

  const signalPhoneCurrent = isReconfig && config.channels.signal.phoneNumber ? ` [${redactPhone(config.channels.signal.phoneNumber)}]` : '';
  const signalPhoneInput = await ask(chalk.white(`  Signal phone number${signalPhoneCurrent}: `));

  if (isReconfig && signalPhoneInput.toLowerCase() === 'none') {
    config.channels.signal.enabled = false;
    config.channels.signal.phoneNumber = '';
    clearSignalAccess(config);
    saveConfig(config);
  } else if (isReconfig && signalPhoneInput.toLowerCase() === 'unregister') {
    console.log('');
    console.log(chalk.yellow('  ⚠️  This will unlink this device from Signal and clear all Mercury Signal data.'));
    console.log(chalk.yellow('  Mercury will no longer be able to send or receive Signal messages.'));
    console.log('');
    const confirmUnregister = await ask(chalk.white('  Continue? (y/N): '));
    if (confirmUnregister.toLowerCase() !== 'y' && confirmUnregister.toLowerCase() !== 'yes') {
      console.log(chalk.dim('  Cancelled.'));
    } else {
      const phoneNumberToDelete = config.channels.signal.phoneNumber;

      // Send goodbye message (best effort, skip if signal-cli not installed or target gone)
      const { findSignalCli, sendSignalMessage } = await import('./signal/setup.js');
      if (findSignalCli()) {
        const target: { groupId?: string; recipient?: string } = {};
        if (config.channels.signal.mode === 'group' && config.channels.signal.groupId) {
          target.groupId = config.channels.signal.groupId;
        } else if (config.channels.signal.admins.length > 0) {
          target.recipient = config.channels.signal.admins[0].phoneNumber;
        }
        if (target.groupId || target.recipient) {
          try {
            await sendSignalMessage(config.channels.signal.phoneNumber, 'Mercury has been unregistered from this conversation. It will no longer respond here. To reconnect, the admin needs to set up Signal again with: mercury doctor', target);
          } catch { /* best effort */ }
        }
      }

      const { killStaleSignalCliProcesses } = await import('./signal/jsonrpc.js');
      killStaleSignalCliProcesses();

      // Unregister from Signal server
      console.log(chalk.dim('  Unlinking device from Signal...'));
      const { unregisterSignalNumber } = await import('./signal/setup.js');
      const unregResult = await unregisterSignalNumber(config.channels.signal.phoneNumber);
      if (unregResult.success) {
        console.log(chalk.green('  ✓ Device unlinked from Signal server.'));
      } else {
        console.log(chalk.yellow('  ⚠ Could not reach Signal server to unlink device.'));
        console.log(chalk.dim('  Local data has been cleared. The device will be unlinked automatically.'));
      }

      clearSignalAccess(config);
      config.channels.signal.enabled = false;
      config.channels.signal.phoneNumber = '';
      config.channels.signal.groupId = undefined;
      config.channels.signal.groupName = undefined;
      saveConfig(config);

      const { deleteSignalCliAccountData } = await import('./signal/setup.js');
      if (phoneNumberToDelete) {
        deleteSignalCliAccountData(phoneNumberToDelete);
      }

      console.log(chalk.green('  ✓ Signal data cleared.'));

      const setupNew = await ask(chalk.white('  Set up Signal with a new number now? (y/N): '));
      if (setupNew.toLowerCase() === 'y' || setupNew.toLowerCase() === 'yes') {
        const newPhone = await ask(chalk.white('  New Signal phone number (e.g. +1234567890): '));
        if (newPhone) {
          config.channels.signal.phoneNumber = newPhone.trim();
          config.channels.signal.enabled = true;
          const modeAnswer = await ask(chalk.white('  Mode — group or private? [group]: '));
          config.channels.signal.mode = modeAnswer.toLowerCase().startsWith('private') ? 'private' : 'group';
          saveConfig(config);
        }
      }
    }
  } else if (isReconfig && signalPhoneInput.toLowerCase() === 'reset') {
    clearSignalAccess(config);
    config.channels.signal.enabled = false;
    config.channels.signal.phoneNumber = '';
    saveConfig(config);

    console.log('');
    console.log(chalk.yellow('  ⚠️  This will clear all Signal access and group connection.'));
    const deleteBinary = await ask(chalk.white('  Also delete the signal-cli binary? (y/N): '));
    if (deleteBinary.toLowerCase() === 'y' || deleteBinary.toLowerCase() === 'yes') {
      const { removeSignalCli, getSignalCliDir } = await import('./signal/setup.js');
      const { existsSync } = await import('node:fs');
      if (existsSync(getSignalCliDir())) {
        removeSignalCli();
        console.log(chalk.green('  ✓ Signal binary removed.'));
      }
    }

    console.log(chalk.green('  ✓ Signal config reset.'));
    console.log(chalk.dim('  Continue below to set up Signal with a new number.'));
    console.log('');

    const newPhone = await ask(chalk.white('  New Signal phone number (e.g. +1234567890): '));
    if (newPhone) {
      config.channels.signal.phoneNumber = newPhone.trim();
      config.channels.signal.enabled = true;

      const modeAnswer = await ask(chalk.white('  Mode — group or private? [group]: '));
      config.channels.signal.mode = modeAnswer.toLowerCase().startsWith('private') ? 'private' : 'group';

      saveConfig(config);
    }
  } else if (signalPhoneInput) {
    if (signalPhoneInput !== config.channels.signal.phoneNumber) {
      clearSignalAccess(config);
    }
    config.channels.signal.phoneNumber = signalPhoneInput.trim();
    config.channels.signal.enabled = true;

    const modeAnswer = await ask(chalk.white('  Mode — group or private? [group]: '));
    config.channels.signal.mode = modeAnswer.toLowerCase().startsWith('private') ? 'private' : 'group';

    saveConfig(config);
  } else if (!config.channels.signal.phoneNumber) {
    config.channels.signal.enabled = false;
    saveConfig(config);
  }

  await completeInitialSignalSetup(config);

  hr();
  console.log('');
  console.log(chalk.bold.white('  Discord (optional)'));
  if (isReconfig) {
    console.log(chalk.dim('  Leave empty to keep current value. Enter "none" to disable.'));
  } else {
    console.log(chalk.dim('  Leave empty to skip. You can add it later.'));
  }
  console.log(chalk.dim('  To create a Discord bot:'));
  console.log(chalk.dim('    1. Go to https://discord.com/developers/applications'));
  console.log(chalk.dim('    2. Click "New Application" → give it a name'));
  console.log(chalk.dim('    3. Navigate to Bot → Click "Reset Token" → Copy the token'));
  console.log(chalk.dim('    4. Enable Privileged Gateway Intents:'));
  console.log(chalk.dim('       - Message Content Intent'));
  console.log(chalk.dim('    5. Go to OAuth2 → URL Generator:'));
  console.log(chalk.dim('       Scopes: bot, applications.commands'));
  console.log(chalk.dim('       Bot Permissions: Send Messages, Read Message History,'));
  console.log(chalk.dim('       Use Slash Commands, Attach Files, Embed Links'));
  console.log(chalk.dim('    6. Open the generated URL to invite the bot to your server'));
  console.log(chalk.dim('    7. Optionally create a "Mercury Admin" role in your server'));
  console.log(chalk.dim('  Guild members can chat openly. DMs require pairing (like Telegram).'));
  console.log('');

  const dcMask = isReconfig && config.channels.discord.botToken ? ` [${maskKey(config.channels.discord.botToken)}]` : '';
  const discordToken = await ask(chalk.white(`  Discord Bot Token${dcMask}: `));
  if (isReconfig && discordToken.toLowerCase() === 'none') {
    config.channels.discord.enabled = false;
    config.channels.discord.botToken = '';
    clearDiscordAccess(config);
  } else if (discordToken) {
    if (discordToken !== config.channels.discord.botToken) {
      clearDiscordAccess(config);
    }
    config.channels.discord.botToken = discordToken;
    appendToEnv('DISCORD_BOT_TOKEN', discordToken);
    config.channels.discord.enabled = true;
  }

  if (config.channels.discord.enabled && config.channels.discord.botToken) {
    if (!config.channels.discord.guildId) {
      console.log('');
      console.log(chalk.dim('  To find your Server ID: in Discord, go to Settings → App Settings →'));
      console.log(chalk.dim('  Advanced → toggle Developer Mode ON. Then right-click your server'));
      console.log(chalk.dim('  name in the sidebar → Copy Server ID.'));
      const guildId = await ask(chalk.white('  Discord Guild/Server ID (optional — leave empty for all servers): '));
      if (guildId.trim()) {
        config.channels.discord.guildId = guildId.trim();
      }
    }

    if (!config.channels.discord.channelId) {
      console.log(chalk.dim('  To find a Channel ID: right-click the channel name in the sidebar → Copy Channel ID.'));
      const channelId = await ask(chalk.white('  Discord Channel ID (optional — leave empty for all channels): '));
      if (channelId.trim()) {
        config.channels.discord.channelId = channelId.trim();
      }
    }

    const adminRoleCurrent = isReconfig && config.channels.discord.adminRoleName ? ` [${config.channels.discord.adminRoleName}]` : '';
    const adminRoleName = await ask(chalk.white(`  Admin role name${adminRoleCurrent} [Mercury Admin]: `));
    if (adminRoleName.trim()) {
      config.channels.discord.adminRoleName = adminRoleName.trim();
    } else if (!config.channels.discord.adminRoleName) {
      config.channels.discord.adminRoleName = 'Mercury Admin';
    }

    saveConfig(config);
  } else if (!config.channels.discord.botToken) {
    config.channels.discord.enabled = false;
    saveConfig(config);
  }

  await completeInitialDiscordPairing(config);

  hr();
  console.log('');
  console.log(chalk.bold.white('  Slack (optional)'));
  if (isReconfig) {
    console.log(chalk.dim('  Leave empty to keep current value. Enter "none" to disable.'));
  } else {
    console.log(chalk.dim('  Leave empty to skip. You can add it later.'));
  }
  console.log(chalk.dim('  To create a Slack app:'));
  console.log(chalk.dim('    1. Go to https://api.slack.com/apps → Create New App → From scratch'));
  console.log(chalk.dim('    2. Under "Socket Mode", enable it and generate an App-Level Token'));
  console.log(chalk.dim('       with connections:write scope → copy the xapp- token'));
  console.log(chalk.dim('    3. Under "OAuth & Permissions", add Bot Token Scopes:'));
  console.log(chalk.dim('       chat:write, chat:write.public, chat:write.customize,'));
  console.log(chalk.dim('       channels:history, groups:history, im:history, im:write,'));
  console.log(chalk.dim('       files:write, commands, app_mentions:read'));
  console.log(chalk.dim('    4. Install app to workspace → copy Bot User OAuth Token (xoxb-)'));
  console.log(chalk.dim('    5. Under "Event Subscriptions", enable and subscribe to:'));
  console.log(chalk.dim('       message.channels, message.groups, message.im, app_mention'));
  console.log(chalk.dim('    6. Under "Interactivity & Shortcuts", enable interactivity'));
  console.log(chalk.dim('    7. Under "Slash Commands", create /mercury command'));
  console.log(chalk.dim('    8. Under "App Home", check "Allow users to send Slash commands'));
  console.log(chalk.dim('       and messages from the messages tab"'));
  console.log(chalk.dim('    9. Invite the bot to your channel: /invite @Mercury'));
  console.log(chalk.dim('    10. DM the bot /mercury start to become the first admin.'));
  console.log(chalk.dim('  Channel members can chat openly. DMs require admin approval.'));

  const slMask = isReconfig && config.channels.slack.botToken ? ` [${maskKey(config.channels.slack.botToken)}]` : '';
  const slackBotToken = await ask(chalk.white(`  Slack Bot Token${slMask} (starts with xoxb-): `));
  if (isReconfig && slackBotToken.toLowerCase() === 'none') {
    config.channels.slack.enabled = false;
    config.channels.slack.botToken = '';
    clearSlackAccess(config);
  } else if (slackBotToken) {
    if (slackBotToken !== config.channels.slack.botToken) {
      clearSlackAccess(config);
    }
    config.channels.slack.botToken = slackBotToken;
    appendToEnv('SLACK_BOT_TOKEN', slackBotToken);
  }

  if (config.channels.slack.enabled || config.channels.slack.botToken) {
    const slAppMask = isReconfig && config.channels.slack.appToken ? ` [${maskKey(config.channels.slack.appToken)}]` : '';
    const slackAppToken = await ask(chalk.white(`  Slack App-Level Token${slAppMask} (starts with xapp-): `));
    if (slackAppToken && slackAppToken.toLowerCase() !== 'none') {
      config.channels.slack.appToken = slackAppToken;
      appendToEnv('SLACK_APP_TOKEN', slackAppToken);
    } else if (slackAppToken.toLowerCase() === 'none') {
      config.channels.slack.appToken = '';
    }

    if (config.channels.slack.botToken) {
      config.channels.slack.enabled = true;

      if (!config.channels.slack.channelId) {
        console.log(chalk.dim('  To find a Channel ID: right-click the channel name → Copy Channel ID.'));
        const slChannelId = await ask(chalk.white('  Slack Channel ID (optional — leave empty for all channels): '));
        if (slChannelId.trim()) {
          config.channels.slack.channelId = slChannelId.trim();
        }
      }

      if (!config.channels.slack.teamId) {
        const slTeamId = await ask(chalk.white('  Slack Team/Workspace ID (optional): '));
        if (slTeamId.trim()) {
          config.channels.slack.teamId = slTeamId.trim();
        }
      }

      saveConfig(config);
    }
  } else if (!config.channels.slack.botToken) {
    config.channels.slack.enabled = false;
    saveConfig(config);
  }

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

  console.log('');
  console.log(chalk.bold.white('  Web Dashboard'));
  console.log(chalk.dim('  Mercury includes an optional web interface for managing your agent,'));
  console.log(chalk.dim('  chatting, viewing memory, and controlling settings from your browser.'));
  console.log(chalk.dim('  You can enable or disable it at any time.'));
  console.log('');

  const webEnabledDefault = config.web.enabled ? 'Y/n' : 'y/N';
  const webEnabledCurrent = config.web.enabled ? 'enabled' : 'disabled';
  const webEnableStr = await ask(chalk.white(`  Enable Mercury Web? (${webEnabledDefault}) [${webEnabledCurrent}]: `));
  if (webEnableStr.trim()) {
    config.web.enabled = webEnableStr.trim().toLowerCase().startsWith('y');
  } else if (!isReconfig) {
    // First run: default to enabled (yes)
    config.web.enabled = true;
  }

  if (config.web.enabled) {
    const portPrompt = isReconfig
      ? chalk.white(`  Web dashboard port [${config.web.port}]: `)
      : chalk.white(`  Web dashboard port [${config.web.port}]: `);
    const portStr = await ask(portPrompt);
    if (portStr.trim()) {
      const portNum = parseInt(portStr.trim(), 10);
      if (portNum > 0 && portNum < 65536) {
        config.web.port = portNum;
      } else {
        console.log(chalk.yellow('  Invalid port number. Keeping default.'));
      }
    }
    console.log(chalk.dim(`  Mercury Web will be available at http://localhost:${config.web.port}`));

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
  } else {
    console.log(chalk.dim('  Web dashboard disabled. You can enable it later with `mercury doctor`.'));
  }

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
  console.log(chalk.dim('  mercuryagent.sh'));
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

  // Check for crash flag from previous run — if Mercury crashed mid-task,
  // report it to the user immediately so they don't have to investigate.
  const { readCrashFlag, clearCrashFlag } = await import('./core/crash-flag.js');
  const crashFlag = readCrashFlag();
  if (crashFlag) {
    clearCrashFlag();
    const age = Math.round((Date.now() - crashFlag.timestamp) / 1000);
    const timeAgo = age >= 60 ? `${Math.floor(age / 60)}m ago` : `${age}s ago`;
    const msg = `⚠ Mercury crashed ${timeAgo}: ${crashFlag.reason}`;
    if (!isDaemon) {
      console.log(chalk.yellow(`  ${msg}`));
      console.log(chalk.dim('  If you had an active task, it was interrupted. You can retry.\n'));
    } else {
      logger.warn({ crashFlag }, 'Previous crash detected');
    }
  }

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
      'Second brain dependency issue: better-sqlite3 is not available. ' +
      'Memory/brain features require SQLite via better-sqlite3. Install build tools and reinstall dependencies.'
    );
  }

  const channels = new ChannelRegistry(config);
  const webChannel = new WebChannel(config.identity.name);
  channels.register('web', webChannel);
  const capabilities = new CapabilityRegistry(skillLoader, scheduler, tokenBudget, undefined, userMemory ?? undefined);

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

  // Board manager for multi-board kanban
  const boardMgr = new BoardManager();
  boardMgr.load();

  capabilities.setChatCommandContext({
    toolNames: () => capabilities.getToolNames(),
    skillNames: () => skills.map(s => s.name),
    config: () => config,
    tokenBudget: () => tokenBudget,
    manual: () => getManual(),
    memorySummary: () => userMemory ? userMemory.getSummary() : { total: 0, subconsciousTotal: 0, byType: {}, learningPaused: false },
    memoryRecent: (limit?: number) => userMemory ? userMemory.getRecent(limit) : [],
    memorySearch: (query: string, limit?: number) => userMemory ? userMemory.search(query, limit) : [],
    memorySetLearningPaused: (paused: boolean) => { if (userMemory) userMemory.setLearningPaused(paused); },
    memoryClear: () => userMemory ? userMemory.clear() : 0,
    memoryGetSubconscious: (limit?: number) => userMemory ? userMemory.getSubconscious(limit) : [],
  });

  capabilities.setSendFileHandler(async (filePath: string, channel?: string) => {
    const { channelId, channelType } = capabilities.getChannelContext();
    const telegram = channels.get('telegram');
    const signal = channels.get('signal');

    // Explicit channel override from the user
    if (channel === 'signal' && signal) {
      await signal.sendFile(filePath, channelType === 'signal' ? channelId : undefined);
      return;
    }
    if (channel === 'telegram' && telegram) {
      await telegram.sendFile(filePath, channelType === 'telegram' ? channelId : undefined);
      return;
    }

    if (channelType === 'telegram' && telegram) {
      await telegram.sendFile(filePath, channelId);
      return;
    }

    if (channelType === 'signal' && signal) {
      await signal.sendFile(filePath, channelId);
      return;
    }

    if (config.channels.telegram.enabled && telegram && getTelegramApprovedUsers(config).length > 0) {
      await telegram.sendFile(filePath);
      return;
    }

    if (config.channels.signal.enabled && signal && hasSignalAdminsFn(config)) {
      await signal.sendFile(filePath);
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

  agent.setSkillLoader(skillLoader);

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
      bootCli.setSaverMode(agent.saverMode.getState(), tokenBudget.getSavedToday(), tokenBudget.getSavedLifetime());
      bootCli.setWebInfo(config.web.enabled, config.web.port);
      // Wire live status providers so the bottom bar refreshes every 2s
      // without waiting for an LLM call or queue completion.
      bootCli.setStatusProviders({
        tokens: () => ({
          used: tokenBudget.getDailyUsed(),
          budget: tokenBudget.getBudget(),
          percentage: Math.round(tokenBudget.getUsagePercentage()),
        }),
        saver: () => ({
          state: agent.saverMode.getState(),
          savedToday: tokenBudget.getSavedToday(),
          savedLifetime: tokenBudget.getSavedLifetime(),
        }),
        subAgents: () => supervisor ? supervisor.getActiveAgents().map((a) => ({
          id: a.id,
          task: a.task,
          status: a.status,
          progress: a.progress,
          startedAt: 0,
        })) : [],
        bgTasks: () => agent.backgroundTasks.getAllSummaries(),
      });
      bootCli.startStatusPoller(2000);
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
  const sigChannel = channels.get('signal') as SignalChannel | undefined;

  if (tgChannel) {
    tgChannel.setChatCommandContext(capabilities.getChatCommandContext()!);
  }

  if (sigChannel) {
    sigChannel.setChatCommandContext(capabilities.getChatCommandContext()!);
  }

  setWebWebChannel(webChannel);
  setWebProgrammingMode(agent.programmingMode);
  setWebBgTasks(agent.backgroundTasks);
  setWebModelSwitch((provider) => agent.switchProvider(provider));
  setWebCurrentProvider(() => agent.getCurrentProvider());
  // IDE provider registry powers features like commit message generation.
  // It does not require a supervisor, so wire it up unconditionally.
  setWebIDEProviders(providers);
  if (supervisor) {
    setWebSupervisor(supervisor);
    setWebKanban(supervisor);
    setWebBoardManager(boardMgr);
    setWebKanbanProviders(providers);

    // Lifecycle callback: sync agent results back to board cards
    const { getAgentCardMap } = await import('./web/api/kanban.js');

    // Comment check: sub-agents poll this to discover new user comments
    supervisor.setCommentCheckCallback((agentId: string) => {
      const acMap = getAgentCardMap();
      const mapping = acMap.get(agentId);
      if (!mapping) return [];
      const card = boardMgr.getCard(mapping.boardId, mapping.cardId);
      if (!card || !card.comments) return [];
      return card.comments
        .filter(c => c.author === 'user')
        .map(c => ({ id: c.id, author: c.authorName, content: c.content, timestamp: c.timestamp }));
    });

    // Post comment: sub-agents use this to reply to user comments
    supervisor.setPostCommentCallback((agentId: string, content: string) => {
      const acMap = getAgentCardMap();
      const mapping = acMap.get(agentId);
      if (!mapping) return;
      boardMgr.addComment(mapping.boardId, mapping.cardId, 'agent', `Agent ${agentId}`, content);
    });

    supervisor.setLifecycleCallback((event) => {
      const acMap = getAgentCardMap();
      const mapping = acMap.get(event.agentId);
      if (!mapping) return;

      if (event.type === 'progress' && event.progress) {
        // Sync progress, live token usage, and files being edited
        const taskBoard = supervisor!.getTaskBoard();
        const entry = taskBoard.get(event.agentId);
        const fileLockMgr = supervisor!.getFileLockManager();
        const lockedFiles = fileLockMgr.getLocksFor(event.agentId)
          .filter(l => l.mode === 'write')
          .map(l => l.filePath);

        // Determine activity type from progress message
        const progressMsg = event.progress;
        let activityType: 'progress' | 'tool-use' | 'thinking' | 'file-lock' = 'progress';
        if (progressMsg.startsWith('Using:')) activityType = 'tool-use';
        else if (progressMsg.includes('LLM') || progressMsg.includes('Processing')) activityType = 'thinking';
        else if (lockedFiles.length > 0) activityType = 'file-lock';

        // Push to activity log
        boardMgr.pushActivity(mapping.boardId, mapping.cardId, {
          type: activityType,
          message: progressMsg,
          data: lockedFiles.length > 0 ? { files: lockedFiles } : undefined,
        });

        boardMgr.syncCardFromRuntime(mapping.boardId, mapping.cardId, {
          progress: event.progress,
          filesLocked: lockedFiles,
          ...(entry?.tokenUsage ? { tokenUsage: entry.tokenUsage } : {}),
        });

        // Token budget enforcement
        const cardData = boardMgr.getCard(mapping.boardId, mapping.cardId);
        if (cardData?.tokenBudget && entry?.tokenUsage) {
          const totalUsed = entry.tokenUsage.total ?? ((entry.tokenUsage.input ?? 0) + (entry.tokenUsage.output ?? 0));
          if (totalUsed >= cardData.tokenBudget) {
            // Halt the agent and pause the card
            supervisor!.halt(event.agentId);
            boardMgr.updateCard(mapping.boardId, mapping.cardId, {
              status: 'paused',
              progress: `Token budget exhausted (${totalUsed.toLocaleString()} / ${cardData.tokenBudget.toLocaleString()} tokens used)`,
              pausedForTokens: true,
            } as any);
            boardMgr.pushActivity(mapping.boardId, mapping.cardId, {
              type: 'feedback',
              message: `Paused: token budget exhausted (${totalUsed.toLocaleString()} / ${cardData.tokenBudget.toLocaleString()})`,
            });
          }
        }

        boardMgr.saveBatch(mapping.boardId);
      }

      if (event.type === 'complete' && event.result) {
        const taskBoard = supervisor!.getTaskBoard();
        const entry = taskBoard.get(event.agentId);

        // Push completion to activity log
        boardMgr.pushActivity(mapping.boardId, mapping.cardId, {
          type: event.result.status === 'completed' ? 'completed' : 'failed',
          message: event.result.status === 'completed'
            ? `Task completed${event.result.filesModified?.length ? ` — ${event.result.filesModified.length} file(s) modified` : ''}`
            : `Task failed: ${(event.result.error || 'Unknown error').slice(0, 150)}`,
          data: event.result.filesModified?.length ? { files: event.result.filesModified } : undefined,
        });

        boardMgr.updateCard(mapping.boardId, mapping.cardId, {
          status: event.result.status === 'completed' ? 'completed' : (event.result.status === 'halted' ? 'halted' : 'failed'),
          completedAt: Date.now(),
          result: event.result.output,
          error: event.result.error,
          filesLocked: [], // release on completion
          progress: event.result.status === 'completed' ? 'Completed' : (event.result.status === 'halted' ? 'Halted' : 'Failed'),
          tokenUsage: entry?.tokenUsage || {
            input: event.result.tokenUsage?.input ?? 0,
            output: event.result.tokenUsage?.output ?? 0,
            total: (event.result.tokenUsage?.input ?? 0) + (event.result.tokenUsage?.output ?? 0),
          },
        });

        // Auto-detect document files and register as attachments
        if (event.result.filesModified && event.result.filesModified.length > 0) {
          const docExtensions: Record<string, 'markdown' | 'document' | 'image' | 'presentation' | 'other'> = {
            '.md': 'markdown', '.mdx': 'markdown',
            '.doc': 'document', '.docx': 'document', '.pdf': 'document', '.txt': 'document',
            '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.svg': 'image', '.webp': 'image',
            '.ppt': 'presentation', '.pptx': 'presentation',
          };
          for (const filePath of event.result.filesModified) {
            const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
            const docType = docExtensions[ext];
            if (docType) {
              const fileName = filePath.split('/').pop() || filePath;
              boardMgr.addAttachment(mapping.boardId, mapping.cardId, {
                name: fileName,
                path: filePath,
                type: docType,
                addedBy: 'agent',
              });
            }
          }
        }

        acMap.delete(event.agentId);

        // Log completion to board context for inter-card sharing
        const card = boardMgr.getCard(mapping.boardId, mapping.cardId);
        boardMgr.addContextEvent(mapping.boardId, {
          cardId: mapping.cardId,
          type: event.result.status === 'completed' ? 'card-completed' : 'card-failed',
          summary: `Card "${card?.task ?? mapping.cardId}" ${event.result.status}: ${(event.result.output || event.result.error || '').slice(0, 200)}`,
          data: {
            filesModified: event.result.filesModified,
            output: event.result.output?.slice(0, 500),
          },
        });

        // Auto-detect and set working directory from file paths
        if (event.result.filesModified && event.result.filesModified.length > 0) {
          const firstFile = event.result.filesModified[0];
          const dir = firstFile.substring(0, firstFile.lastIndexOf('/'));
          const ctx = boardMgr.getBoardContext(mapping.boardId);
          if (ctx && !ctx.workingDirectory && dir) {
            boardMgr.setBoardWorkingDirectory(mapping.boardId, dir);
          }
        }
      }
    });
  }
  if (spotifyClient) {
    setWebSpotify(spotifyClient);
  }

  capabilities.permissions.onAsk(async (prompt: string) => {
    const channelType = capabilities.permissions.getCurrentChannelType();
    if (channelType === 'telegram' && tgChannel) {
      return tgChannel.askPermission(prompt);
    }
    if (channelType === 'signal' && channels.get('signal')) {
      return (channels.get('signal') as SignalChannel).askPermission(prompt);
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

  if (sigChannel) {
    sigChannel.setOnPermissionMode((mode) => {
      if (mode === 'allow-all') {
        capabilities.permissions.setAutoApproveAll(true);
        capabilities.permissions.addTempScope('/', true, true);
        logger.info('Signal: Allow All mode set for session');
      }
    });
  }

  const activeCh = channels.getActiveChannels();
  const toolNames = capabilities.getToolNames();

  if (!isDaemon) {
    if (config.identity.creator) {
      logger.info(`Creator: ${config.identity.creator}`);
    }

    console.log('');
    console.log(chalk.green(`  ${name} is live. Type a message and press Enter.`));
    console.log(chalk.dim('  Ctrl+C to exit · /help for commands'));

    if (config.web.enabled) {
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
        tokensUsed: tokenBudget.getDailyUsed(),
        memoryTotal: userMemory ? userMemory.getSummary().total : 0,
        memoryByType: userMemory ? userMemory.getSummary().byType : {},
      });
    } else {
      console.log(chalk.dim(`  Web: disabled · enable with mercury doctor or set web.enabled: true`));
    }

    // Keep CLI permission mode prompt, but do it after web server is live.
    const mode = cliChannel && await cliChannel.askPermissionMode?.();
    if (mode === 'allow-all') {
      capabilities.permissions.setAutoApproveAll(true);
      capabilities.permissions.addTempScope('/', true, true);
    }
  } else {
    await channels.startAll();
    if (config.web.enabled) {
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
        tokensUsed: tokenBudget.getDailyUsed(),
        memoryTotal: userMemory ? userMemory.getSummary().total : 0,
        memoryByType: userMemory ? userMemory.getSummary().byType : {},
      });
    }
    logger.info({ channels: activeCh, tools: toolNames, web: config.web.enabled }, 'Mercury is live (daemon mode)');
  }

  const shutdown = async () => {
    if (!isDaemon) {
      console.log('');
      console.log(chalk.dim(`  ${name} is shutting down...`));
    } else {
      logger.info('Mercury is shutting down (daemon mode)');
    }
    // Notify all channels that Mercury is stopping — users should never
    // have to re-prompt to discover their task was killed mid-flight.
    try {
      await agent.notifyAllChannels('⚠ Mercury is shutting down. If I was working on something, it has been interrupted. Send a message after restart to continue.');
    } catch { /* best effort */ }
    if (userMemory) {
      try {
        userMemory.consolidate();
        userMemory.close();
      } catch {}
    }
    await stopWebServer();
    await agent.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (!isDaemon && process.platform !== 'win32') {
    process.on('SIGHUP', async () => {
      logger.info('SIGHUP received — terminal closed. Daemonizing.');
      try {
        const result = tryAutoDaemonize();
        if (result) {
          logger.info(`Forked daemon. Foreground process exiting.`);
        } else {
          logger.warn('SIGHUP received but daemonization failed. Shutting down.');
          // Notify before forced exit
          try {
            await agent.notifyAllChannels('⚠ Mercury lost its terminal and could not daemonize. Shutting down — your task was interrupted.');
          } catch { /* best effort */ }
        }
      } catch {
        logger.warn('SIGHUP received but daemonization failed. Shutting down.');
        try {
          await agent.notifyAllChannels('⚠ Mercury lost its terminal and could not daemonize. Shutting down — your task was interrupted.');
        } catch { /* best effort */ }
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
  .action(async () => {
    await stopDaemon();
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
    console.log(`  Signal:   ${config.channels.signal.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
    if (config.channels.signal.phoneNumber) {
      console.log(`  Signal Access: ${chalk.white(getSignalAccessSummary(config))}`);
    }
    console.log(`  Discord:  ${config.channels.discord.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
    if (config.channels.discord.botToken) {
      console.log(`  Discord Access: ${chalk.white(getDiscordAccessSummary(config))}`);
    }
    console.log(`  Slack:    ${config.channels.slack.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
    if (config.channels.slack.botToken) {
      console.log(`  Slack Access: ${chalk.white(getSlackAccessSummary(config))}`);
    }
    console.log(`  Web:      ${config.web.enabled ? chalk.green(`enabled (http://localhost:${config.web.port})`) : chalk.dim('disabled')}`);
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
    if (config.channels.signal.phoneNumber) {
      printSignalAccessState(config);
    }
    if (config.channels.discord.botToken) {
      printDiscordAccessState(config);
    }
    if (config.channels.slack.botToken) {
      printSlackAccessState(config);
    }
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

const signalCmd = program
  .command('signal')
  .description('Manage Signal channel access and setup');

signalCmd
  .command('approve <code>')
  .description('Approve a pending Signal pairing request by code')
  .action(async (code: string) => {
    const config = loadConfig();

    if (!hasSignalAdminsFn(config)) {
      const approved = approveSignalPendingRequestByPairingCode(config, code.trim());
      if (!approved) {
        console.log('');
        console.log(chalk.red(`  No pending Signal pairing found for code ${code.trim()}.`));
        console.log('');
        return;
      }

      saveConfig(config);
      console.log('');
      console.log(chalk.green(`  ✓ Approved first Signal admin ${approved.phoneNumber}.`));
      restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
      console.log('');
      return;
    }

    const pending = findSignalPendingRequest(config, code.trim());
    if (!pending) {
      console.log('');
      console.log(chalk.red(`  No pending Signal pairing found for ${code.trim()}.`));
      console.log('');
      return;
    }

    console.log('');
    console.log(chalk.yellow(`  A Signal admin already exists. New members must be approved by an admin in Signal.`));
    console.log('');
  });

signalCmd
  .command('unpair')
  .description('Reset all Signal access and group connection')
  .action(() => {
    const config = loadConfig();
    const hasAny = config.channels.signal.admins.length > 0
      || config.channels.signal.members.length > 0
      || config.channels.signal.pending.length > 0;

    if (!hasAny) {
      console.log('');
      console.log(chalk.dim('  Signal access is already empty.'));
      console.log('');
      return;
    }

    clearSignalAccess(config);
    saveConfig(config);

    console.log('');
    console.log(chalk.green('  ✓ Signal access reset.'));
    console.log(chalk.dim('  Send /pair in Signal to reconnect.'));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

signalCmd
  .command('reset')
  .description('Full reset: clear Signal access, delete binary, and unlink device')
  .option('--keep-binary', 'Keep the signal-cli binary (only clear config)')
  .action(async (opts) => {
    const { removeSignalCli, getSignalCliDir, checkJavaAvailable, ensureSignalCli } = await import('./signal/setup.js');
    const config = loadConfig();

    console.log('');
    console.log(chalk.yellow('  ⚠️  This will:'));
    console.log(chalk.yellow('  • Clear all Signal access (admins, members, pending)'));
    console.log(chalk.yellow('  • Remove group connection'));
    console.log(chalk.yellow('  • Disable the Signal channel'));
    if (!opts.keepBinary) {
      console.log(chalk.yellow('  • Delete the signal-cli binary from disk'));
    }
    console.log('');

    const answer = await ask(chalk.white('  Continue? [y/N] '));
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log(chalk.dim('  Cancelled.'));
      console.log('');
      return;
    }

    clearSignalAccess(config);
    config.channels.signal.enabled = false;
    saveConfig(config);

    if (!opts.keepBinary) {
      const signalDir = getSignalCliDir();
      const { existsSync } = await import('node:fs');
      if (existsSync(signalDir)) {
        removeSignalCli();
        console.log(chalk.green('  ✓ Signal binary removed.'));
      }
    }

    console.log(chalk.green('  ✓ Signal reset complete.'));
    console.log(chalk.dim('  Run `mercury doctor` to set up Signal again.'));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

signalCmd
  .command('status')
  .description('Show Signal configuration and connection status')
  .action(async () => {
    const config = loadConfig();
    const { checkSignalSetup } = await import('./signal/setup.js');

    console.log('');
    console.log(chalk.bold.white('  Signal Status'));
    console.log('');

    if (!config.channels.signal.phoneNumber) {
      console.log(chalk.dim('  Not configured. Run `mercury doctor` to set up Signal.'));
      console.log('');
      return;
    }

    console.log(`  Phone:     ${chalk.white(config.channels.signal.phoneNumber)}`);
    console.log(`  Mode:      ${chalk.white(config.channels.signal.mode)}`);
    console.log(`  Enabled:   ${config.channels.signal.enabled ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`  Paired:    ${hasSignalAdminsFn(config) ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`  Access:    ${chalk.white(getSignalAccessSummary(config))}`);

    if (config.channels.signal.mode === 'group') {
      console.log(`  Group:     ${chalk.white(config.channels.signal.groupName || config.channels.signal.groupId || 'Not set')}`);
    }

    const status = await checkSignalSetup(config);
    console.log(`  Binary:    ${status.binaryOk ? chalk.green('found') : chalk.red('not found')}`);
    console.log(`  Linked:    ${status.linked ? chalk.green('yes') : chalk.red('no')}`);

    if (status.errors.length > 0) {
      console.log('');
      for (const err of status.errors) {
        console.log(chalk.red(`  • ${err}`));
      }
    }

    console.log('');
  });

signalCmd
  .command('register')
  .description('Register a phone number with Signal (sends verification code)')
  .action(async () => {
    const config = loadConfig();
    if (!config.channels.signal.phoneNumber) {
      console.log('');
      console.log(chalk.red('  No Signal phone number configured. Run mercury doctor first.'));
      console.log('');
      return;
    }

    const { registerSignalNumber, verifySignalNumber } = await import('./signal/setup.js');
    console.log('');
    console.log(chalk.bold.white('  Signal Registration'));
    console.log(chalk.dim(`  Phone: ${redactPhone(config.channels.signal.phoneNumber)}`));
    console.log('');

    const voice = await ask(chalk.white('  Verify via SMS or voice call? (sms/voice) [sms]: '));
    const useVoice = voice.toLowerCase().startsWith('voice');

    console.log(chalk.dim('  Sending verification code...'));
    const result = await registerSignalNumber(config.channels.signal.phoneNumber, useVoice);
    if (!result.success) {
      console.log(chalk.red(`  ✗ Registration failed: ${result.error}`));
      return;
    }
    console.log(chalk.green('  ✓ Verification code sent.'));

    const code = await ask(chalk.white('  Enter the verification code: '));
    if (!code) {
      console.log(chalk.red('  Verification code is required.'));
      return;
    }

    const verifyResult = await verifySignalNumber(config.channels.signal.phoneNumber, code.trim());
    if (!verifyResult.success) {
      console.log(chalk.red(`  ✗ Verification failed: ${verifyResult.error}`));
      return;
    }
    console.log(chalk.green('  ✓ Number verified and registered.'));
    console.log('');
  });

signalCmd
  .command('unregister')
  .description('Unlink this device from Signal and clear all Mercury Signal data')
  .action(async () => {
    const config = loadConfig();
    if (!config.channels.signal.phoneNumber) {
      console.log('');
      console.log(chalk.dim('  No Signal phone number configured.'));
      console.log('');
      return;
    }

    console.log('');
    console.log(chalk.yellow('  ⚠️  This will:'));
    console.log(chalk.yellow('  • Send a goodbye message to your Signal group/chat'));
    console.log(chalk.yellow('  • Unlink this device from the Signal server'));
    console.log(chalk.yellow('  • Clear all Signal access data (admins, members, group connection)'));
    console.log('');

    const answer = await ask(chalk.white('  Continue? (y/N): '));
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log(chalk.dim('  Cancelled.'));
      console.log('');
      return;
    }

    // Send goodbye message (best effort, skip if signal-cli not installed)
    const { findSignalCli } = await import('./signal/setup.js');
    const { sendSignalMessage } = await import('./signal/setup.js');
    if (findSignalCli()) {
      const target: { groupId?: string; recipient?: string } = {};
      if (config.channels.signal.mode === 'group' && config.channels.signal.groupId) {
        target.groupId = config.channels.signal.groupId;
      } else if (config.channels.signal.admins.length > 0) {
        target.recipient = config.channels.signal.admins[0].phoneNumber;
      }
      if (target.groupId || target.recipient) {
        try {
          await sendSignalMessage(config.channels.signal.phoneNumber, 'Mercury has been unregistered from this conversation. It will no longer respond here. To reconnect, the admin needs to set up Signal again with: mercury doctor', target);
        } catch { /* best effort */ }
      }
    }

    const { killStaleSignalCliProcesses } = await import('./signal/jsonrpc.js');
    killStaleSignalCliProcesses();

    // Unregister from Signal server
    console.log(chalk.dim('  Unlinking device from Signal...'));
    const { unregisterSignalNumber } = await import('./signal/setup.js');
    const result = await unregisterSignalNumber(config.channels.signal.phoneNumber);
    if (result.success) {
      console.log(chalk.green('  ✓ Device unlinked from Signal server.'));
    } else {
      console.log(chalk.yellow('  ⚠ Could not reach Signal server to unlink device.'));
      console.log(chalk.dim('  Local data has been cleared. The device will be unlinked automatically.'));
    }

    // Delete signal-cli local account data so checkLocalAccountData returns false
    const phoneNumberToDelete = config.channels.signal.phoneNumber;
    clearSignalAccess(config);
    config.channels.signal.enabled = false;
    config.channels.signal.phoneNumber = '';
    config.channels.signal.groupId = undefined;
    config.channels.signal.groupName = undefined;
    saveConfig(config);

    const { deleteSignalCliAccountData } = await import('./signal/setup.js');
    if (phoneNumberToDelete) {
      deleteSignalCliAccountData(phoneNumberToDelete);
    }

    console.log(chalk.green('  ✓ Signal data cleared.'));
    console.log(chalk.dim('  Run mercury doctor to set up Signal again.'));
    console.log('');

    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
  });

const discordCmd = program
  .command('discord')
  .description('Manage Discord channel access and setup');

discordCmd
  .command('list')
  .description('Show approved Discord users and pending access requests')
  .action(() => {
    const config = loadConfig();
    console.log('');
    printDiscordAccessState(config);
    console.log('');
  });

discordCmd
  .command('approve <code>')
  .description('Approve a pending Discord pairing request by code')
  .action(async (code: string) => {
    const config = loadConfig();

    if (!hasDiscordAdminsFn(config)) {
      const approved = approveDiscordPendingRequestByPairingCode(config, code.trim());
      if (!approved) {
        console.log('');
        console.log(chalk.red(`  No pending Discord pairing found for code ${code.trim()}.`));
        console.log('');
        return;
      }

      saveConfig(config);
      console.log('');
      console.log(chalk.green(`  ✓ Approved first Discord admin ${formatDiscordUser(approved)}.`));
      restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
      console.log('');
      return;
    }

    const pending = findDiscordPendingRequest(config, code.trim());
    if (!pending) {
      console.log('');
      console.log(chalk.red(`  No pending Discord request found for ${code.trim()}.`));
      console.log('');
      return;
    }

    const approved = approveDiscordPendingRequest(config, pending.userId);
    if (!approved) {
      console.log(chalk.red('  Failed to approve request.'));
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Approved Discord user ${formatDiscordUser(approved)}.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

discordCmd
  .command('reject <userId>')
  .description('Reject a pending Discord access request')
  .action(async (userId: string) => {
    const config = loadConfig();
    const rejected = rejectDiscordPendingRequest(config, userId.trim());
    if (!rejected) {
      console.log('');
      console.log(chalk.red(`  No pending Discord request found for ${userId.trim()}.`));
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Rejected Discord request for ${formatDiscordUser(rejected)}.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

discordCmd
  .command('remove <userId>')
  .description('Remove an approved Discord user')
  .action(async (userId: string) => {
    const config = loadConfig();
    const removed = removeDiscordUser(config, userId.trim());
    if (!removed) {
      console.log('');
      console.log(chalk.red(`  No Discord user found with ID ${userId.trim()}.`));
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Removed Discord access for ${formatDiscordUser(removed)}.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

discordCmd
  .command('reset')
  .description('Clear all Discord access data')
  .action(async () => {
    const config = loadConfig();
    clearDiscordAccess(config);
    config.channels.discord.enabled = false;
    saveConfig(config);
    console.log('');
    console.log(chalk.green('  ✓ Discord access reset complete.'));
    console.log(chalk.dim('  Run `mercury doctor` to set up Discord again.'));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

discordCmd
  .command('status')
  .description('Show Discord configuration and connection status')
  .action(() => {
    const config = loadConfig();

    console.log('');
    console.log(chalk.bold.white('  Discord Status'));
    console.log('');

    if (!config.channels.discord.botToken) {
      console.log(chalk.dim('  Not configured. Run `mercury doctor` to set up Discord.'));
      console.log('');
      return;
    }

    console.log(`  Enabled:     ${config.channels.discord.enabled ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`  Paired:      ${hasDiscordAdminsFn(config) ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`  Access:      ${chalk.white(getDiscordAccessSummary(config))}`);
    if (config.channels.discord.guildId) {
      console.log(`  Guild:       ${chalk.white(config.channels.discord.guildId)}`);
    }
    if (config.channels.discord.channelId) {
      console.log(`  Channel:     ${chalk.white(config.channels.discord.channelId)}`);
    }
    if (config.channels.discord.adminRoleName) {
      console.log(`  Admin Role:  ${chalk.white(config.channels.discord.adminRoleName)}`);
    }
    console.log(`  Streaming:   ${config.channels.discord.streaming ? chalk.green('yes') : chalk.dim('no')}`);

    console.log('');
  });

const slackCmd = program
  .command('slack')
  .description('Manage Slack channel access and setup');

slackCmd
  .command('list')
  .description('Show approved Slack users and pending access requests')
  .action(() => {
    const config = loadConfig();
    printSlackAccessState(config);
  });

slackCmd
  .command('approve <userId>')
  .description('Approve a pending Slack access request')
  .action((userId: string) => {
    const config = loadConfig();

    const approved = approveSlackPendingRequest(config, userId);

    if (!approved) {
      console.log(chalk.red(`No pending Slack request found for "${userId}".`));
      process.exit(1);
    }

    saveConfig(config);
    console.log(chalk.green(`Approved Slack user ${formatSlackUser(approved)}.`));
  });

slackCmd
  .command('reject <userId>')
  .description('Reject a pending Slack access request')
  .action((userId: string) => {
    const config = loadConfig();

    const rejected = rejectSlackPendingRequest(config, userId);
    if (!rejected) {
      console.log(chalk.red(`No pending Slack request found for "${userId}".`));
      process.exit(1);
    }

    saveConfig(config);
    console.log(chalk.yellow(`Rejected Slack request for ${formatSlackUser(rejected)}.`));
  });

slackCmd
  .command('remove <userId>')
  .description('Remove an approved Slack user')
  .action((userId: string) => {
    const config = loadConfig();

    const removed = removeSlackUser(config, userId);
    if (!removed) {
      console.log(chalk.red(`No approved Slack user found for "${userId}".`));
      process.exit(1);
    }

    saveConfig(config);
    console.log(chalk.yellow(`Removed Slack access for ${formatSlackUser(removed)}.`));
  });

slackCmd
  .command('reset')
  .description('Clear all Slack access data and disable Slack')
  .action(() => {
    const config = loadConfig();
    clearSlackAccess(config);
    config.channels.slack.enabled = false;
    saveConfig(config);
    console.log(chalk.yellow('Slack access reset. Channel disabled.'));
  });

slackCmd
  .command('status')
  .description('Show Slack configuration and connection status')
  .action(() => {
    const config = loadConfig();
    console.log(`  Enabled:     ${config.channels.slack.enabled ? chalk.green('yes') : chalk.dim('no')}`);
    if (!config.channels.slack.botToken) {
      console.log(chalk.dim('  Not configured. Run mercury doctor to set up Slack.'));
    }
    if (config.channels.slack.channelId) {
      console.log(`  Channel:     ${chalk.white(config.channels.slack.channelId)}`);
    }
    if (config.channels.slack.teamId) {
      console.log(`  Team:         ${chalk.white(config.channels.slack.teamId)}`);
    }
    console.log(`  Streaming:   ${config.channels.slack.streaming ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`  Access:       ${chalk.white(getSlackAccessSummary(config))}`);
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
  .description('Upgrade Mercury to the latest version')
  .action(async () => {
    console.log('');
    console.log(chalk.cyan(`  Mercury ${chalk.white(`v${pkgVersion}`)}`));
    console.log('');

    const daemon = getDaemonStatus();
    if (daemon.running) {
      console.log(chalk.dim('  Stopping background daemon...'));
      await stopDaemon();
      console.log(chalk.green('  ✓ Daemon stopped'));
    }

    const standalone = isStandaloneBinary();

    if (standalone) {
      // Standalone binary: re-run the installer script which downloads the
      // latest release from GitHub and replaces the binary in-place.
      console.log(chalk.dim('  Standalone binary detected — re-running installer...'));
      console.log('');

      const { execSync } = await import('node:child_process');
      const platform = process.platform;
      const binPath = process.execPath;

      if (platform === 'win32') {
        // Windows: use PowerShell installer
        const psCmd = `irm https://mercuryagent.sh/install.ps1 | iex`;
        try {
          execSync(psCmd, { stdio: 'inherit', shell: 'powershell.exe' });
        } catch {
          console.log(chalk.red('  ✗ Upgrade failed. Try manually:'));
          console.log(chalk.dim('    irm https://mercuryagent.sh/install.ps1 | iex'));
        }
      } else {
        // macOS / Linux: use shell installer
        const shCmd = 'curl -fsSL https://mercuryagent.sh/install.sh | sh';
        try {
          execSync(shCmd, { stdio: 'inherit' });
        } catch {
          console.log(chalk.red('  ✗ Upgrade failed. Try manually:'));
          console.log(chalk.dim('    curl -fsSL https://mercuryagent.sh/install.sh | sh'));
        }
      }

      console.log('');
      return;
    }

    // npm install: use npm to upgrade.
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
    console.log(chalk.dim(`  Login at http://localhost:${loadConfig().web.port}`));
    console.log('');
  });

registerSkillsCommand(program);

program.parse();
