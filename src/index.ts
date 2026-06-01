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
  getTelegramApprovedChatIds,
  clearSignalAccess,
  getSignalAccessSummary,
  getSignalApprovedUsers,
  getSignalPendingRequests,
  addSignalPendingRequest,
  approveSignalPendingRequest,
  approveSignalPendingRequestByPairingCode,
  rejectSignalPendingRequest,
  removeSignalUser,
  hasSignalAdmins,
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
import { BoardManager } from './core/board-manager.js';
import { SpotifyClient } from './spotify/client.js';
import { ChannelRegistry } from './channels/registry.js';
import { CLIChannel } from './channels/cli.js';
import { TelegramChannel } from './channels/telegram.js';
import { SignalChannel } from './channels/signal.js';
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
import { CollaborativeKnowledgeStore } from './memory/collaborative-knowledge-store.js';
import { isCollaborativeKnowledgeDbAvailable } from './memory/collaborative-knowledge-db.js';
import { NotificationsStore } from './memory/notifications-store.js';
import { isNotificationsDbAvailable } from './memory/notifications-db.js';
import { MessagesStore } from './memory/messages-store.js';
import { isMessagesDbAvailable } from './memory/messages-db.js';
import { RelayClient, type CKQueryEvent, type CKResponseEvent, type CKResultItem } from './relay/client.js';
import { startWebServer, updateStatus as updateWebStatus, setUserMemory as setWebUserMemory, setWebCollaborativeKnowledge, setRelayClient as setWebRelayClient, setRelayClientForRelay as setWebRelayForRelay, setWebChannel as setWebWebChannel, setScheduler as setWebScheduler, setAgentSupervisor as setWebSupervisor, setBackgroundTaskManager as setWebBgTasks, setSpotifyClient as setWebSpotify, setProgrammingMode as setWebProgrammingMode, setModelSwitchCallback as setWebModelSwitch, setCurrentProviderCallback as setWebCurrentProvider, setKanbanSupervisor as setWebKanban, setKanbanBoardManager as setWebBoardManager, setKanbanProviders as setWebKanbanProviders, setIDEProviders as setWebIDEProviders, setNotificationsStore as setWebNotifications, setMessagesStore as setWebMessages } from './web/server.js';
import { isWebAuthInitialized, setWebPassword } from './web/auth.js';

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

function formatSignalUser(user: {
  phoneNumber: string;
  name?: string;
}): string {
  const name = user.name ? ` (${user.name})` : '';
  return `${user.phoneNumber}${name}`;
}

function printSignalAccessState(config: MercuryConfig): void {
  const admins = config.channels.signal.admins;
  const members = config.channels.signal.members;
  const pending = config.channels.signal.pending;
  const pendingSummary = pending.length > 0
    ? pending.map((entry) => {
        const code = entry.pairingCode ? ` [code: ${entry.pairingCode}]` : '';
        return `${formatSignalUser(entry)}${code}`;
      }).join(', ')
    : '';

  console.log('');
  console.log(`  Signal Access: ${chalk.white(getSignalAccessSummary(config))}`);
  console.log(`  Admins:        ${admins.length > 0 ? chalk.green(admins.map(formatSignalUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Members:       ${members.length > 0 ? chalk.green(members.map(formatSignalUser).join(', ')) : chalk.dim('none')}`);
  console.log(`  Pending:       ${pending.length > 0 ? chalk.yellow(pendingSummary) : chalk.dim('none')}`);
}

async function testSignalConnection(apiUrl: string, number: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${apiUrl}/v1/about`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { ok: false, error: `API returned HTTP ${response.status}` };
    }
    const data = await response.json() as any;
    if (!data.versions) {
      return { ok: false, error: 'Invalid signal-cli-rest-api response' };
    }

    // Check if the number is registered
    const accountsRes = await fetch(`${apiUrl}/v1/accounts`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (accountsRes.ok) {
      const accounts = await accountsRes.json() as string[];
      if (!accounts.includes(number)) {
        return { ok: false, error: `Number ${number} is not registered in signal-cli-rest-api. Link it first at ${apiUrl}/v1/qrcodelink?device_name=mercury` };
      }
    }

    return { ok: true };
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, error: `Connection timed out — is signal-cli-rest-api running at ${apiUrl}?` };
    }
    return { ok: false, error: err.message || String(err) };
  }
}

async function checkSignalPrerequisites(apiUrl: string): Promise<{ dockerInstalled: boolean; containerRunning: boolean; apiReachable: boolean; accounts: string[]; detectedUrl?: string; containerName?: string; error?: string }> {
  // Check if Docker is installed
  let dockerInstalled = false;
  let detectedUrl: string | undefined;
  let containerName: string | undefined;
  try {
    const { execSync } = await import('node:child_process');
    execSync('docker --version', { stdio: 'pipe' });
    dockerInstalled = true;
  } catch { /* docker not found */ }

  // Check if signal-cli-rest-api is reachable at the given URL
  let containerRunning = false;
  let apiReachable = false;
  let accounts: string[] = [];

  try {
    const response = await fetch(`${apiUrl}/v1/about`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      containerRunning = true;
      apiReachable = true;
    }
  } catch { /* not reachable */ }

  // If the given URL is not reachable but Docker is installed,
  // check if signal-cli-rest-api is actually running on a different port
  if (!apiReachable && dockerInstalled) {
    try {
      const { execSync } = await import('node:child_process');
      // Find running containers with the signal-cli-rest-api image
      const output = execSync(
        'docker ps --filter "ancestor=bbernhard/signal-cli-rest-api" --format "{{.Names}}\\t{{.Ports}}"',
        { stdio: 'pipe', encoding: 'utf-8' },
      ).trim();

      if (!output) {
        // Also try filtering by container name patterns
        const altOutput = execSync(
          'docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Ports}}"',
          { stdio: 'pipe', encoding: 'utf-8' },
        ).trim();

        for (const line of altOutput.split('\n')) {
          if (!line) continue;
          const [name, image, ports] = line.split('\t');
          if (image?.includes('signal-cli') || name?.includes('signal')) {
            containerRunning = true;
            containerName = name;
            const hostPort = extractHostPort(ports);
            if (hostPort) {
              detectedUrl = `http://localhost:${hostPort}`;
            }
            break;
          }
        }
      } else {
        // Found by image name
        const firstLine = output.split('\n')[0];
        const [name, ports] = firstLine.split('\t');
        containerRunning = true;
        containerName = name;
        const hostPort = extractHostPort(ports);
        if (hostPort) {
          detectedUrl = `http://localhost:${hostPort}`;
        }
      }

      // If we detected a URL, try to reach it
      if (detectedUrl && detectedUrl !== apiUrl) {
        try {
          const response = await fetch(`${detectedUrl}/v1/about`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok) {
            apiReachable = true;
          }
        } catch { /* not reachable at detected URL either */ }
      }
    } catch { /* docker ps failed */ }
  }

  if (apiReachable) {
    const checkUrl = detectedUrl && detectedUrl !== apiUrl ? detectedUrl : apiUrl;
    try {
      const res = await fetch(`${checkUrl}/v1/accounts`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        accounts = await res.json() as string[];
      }
    } catch { /* ignore */ }
  }

  return { dockerInstalled, containerRunning, apiReachable, accounts, detectedUrl: detectedUrl !== apiUrl ? detectedUrl : undefined, containerName };
}

/** Extract host port from Docker port mapping string like "0.0.0.0:8080->8080/tcp" */
function extractHostPort(portsStr: string | undefined): string | undefined {
  if (!portsStr) return undefined;
  // Match patterns like "0.0.0.0:8080->8080/tcp" or ":::8080->8080/tcp"
  const match = portsStr.match(/(?:0\.0\.0\.0|127\.0\.0\.1|:::?)(\d+)->(\d+)/);
  if (match) return match[1];
  // Simpler pattern: just "host:port->container"
  const simpleMatch = portsStr.match(/:(\d+)->/);
  if (simpleMatch) return simpleMatch[1];
  return undefined;
}

type SignalLinkStatus = {
  /** signal-cli-rest-api responded to /v1/about */
  apiReachable: boolean;
  /** the configured number is present in /v1/accounts (a live linked device) */
  linked: boolean;
  /** all numbers currently linked in the container */
  accounts: string[];
  /** the API was found at a different URL than the one configured */
  detectedUrl?: string;
};

/**
 * Determine whether a specific Signal number is actually linked, not just
 * whether the API is reachable. A user can remove Mercury's linked device from
 * their phone at any time; when that happens signal-cli-rest-api keeps running
 * (API reachable) but the number drops out of /v1/accounts. This distinguishes
 * "reachable" from "linked" so the doctor can tell the user to relink.
 */
async function checkSignalLinkStatus(apiUrl: string, number: string): Promise<SignalLinkStatus> {
  const prereqs = await checkSignalPrerequisites(apiUrl);
  if (!prereqs.apiReachable) {
    return { apiReachable: false, linked: false, accounts: [], detectedUrl: prereqs.detectedUrl };
  }
  return {
    apiReachable: true,
    linked: !!number && prereqs.accounts.includes(number),
    accounts: prereqs.accounts,
    detectedUrl: prereqs.detectedUrl,
  };
}

/**
 * Wrap a URL in an OSC 8 terminal hyperlink so it's clickable (often via
 * Cmd/Ctrl-click) in supporting terminals (iTerm2, modern Terminal.app,
 * VS Code, etc.). Terminals that don't understand the escape simply render the
 * label text, so this degrades gracefully.
 */
function terminalLink(url: string, label?: string): string {
  const text = label ?? url;
  if (!process.stdout.isTTY) {
    return label && label !== url ? `${label} (${url})` : url;
  }
  const OSC = '\u001B]8;;';
  const BEL = '\u0007';
  return `${OSC}${url}${BEL}${text}${OSC}${BEL}`;
}

/** Open a URL in the user's default browser (best-effort, non-blocking). */
async function openBrowser(url: string): Promise<boolean> {
  try {
    const { spawn } = await import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // command missing (e.g. no xdg-open) — fall back to printed link
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The signal-cli-rest-api QR-code linking page for a given device name. */
function signalQrLinkUrl(apiUrl: string, deviceName = 'mercury'): string {
  return `${apiUrl}/v1/qrcodelink?device_name=${deviceName}`;
}

/**
 * Interactive Signal device linking, number-first:
 *   1. Ask for the Signal number (so the user knows what they're linking).
 *   2. Explain that submitting opens a QR page in the browser.
 *   3. Open the QR linking page automatically (clickable fallback link too).
 *   4. Wait until the device shows up in /v1/accounts, then continue.
 *
 * Returns the actually-linked number (read back from the API, which is
 * authoritative) on success.
 */
async function runSignalDeviceLinking(
  apiUrl: string,
  opts: { currentNumber?: string } = {},
): Promise<{ linked: boolean; number?: string }> {
  // Snapshot existing accounts so we can detect the *new* one after linking.
  let baseline: string[] = [];
  try {
    const res = await fetch(`${apiUrl}/v1/accounts`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) baseline = (await res.json()) as string[];
  } catch { /* treat as empty baseline */ }

  console.log('');
  console.log(chalk.dim('  Enter your Signal phone number in international format (e.g. +14155552671).'));
  console.log(chalk.dim('  After you enter it, Mercury opens a web page with a QR code — you scan it'));
  console.log(chalk.dim('  from Signal to link this device. (Entering the number does not send a code.)'));
  const mask = opts.currentNumber ? ` [${opts.currentNumber}]` : '';
  const entered = (await ask(chalk.white(`  Signal number${mask}: `))).trim();
  const number = entered || opts.currentNumber || '';
  if (!number) {
    console.log(chalk.yellow('  ⚠ No number entered — skipping Signal linking.'));
    return { linked: false };
  }

  const linkUrl = signalQrLinkUrl(apiUrl);
  console.log('');
  console.log(chalk.dim('  Opening the QR linking page in your browser...'));
  const opened = await openBrowser(linkUrl);
  if (opened) {
    console.log(chalk.dim('  If it did not open, click this link: ') + chalk.cyan(terminalLink(linkUrl)));
  } else {
    console.log(chalk.dim('  Open this link to show the QR code: ') + chalk.cyan(terminalLink(linkUrl)));
  }
  console.log(chalk.dim('  Then on your phone: Signal → Settings → Linked Devices → Link New Device (+),'));
  console.log(chalk.dim('  and scan the QR code shown on that page.'));
  console.log('');
  console.log(chalk.dim('  Waiting for the device to be linked (up to 2 min)...'));

  const result = await waitForSignalLink(apiUrl, baseline);
  if (!result.linked) {
    console.log(chalk.yellow('  ⚠ Linking timed out. You can re-run `mercury doctor` once you have scanned the code.'));
    return { linked: false };
  }
  const linkedNumber = result.number || number;
  if (entered && result.number && result.number !== entered) {
    console.log(chalk.dim(`  Linked account is ${linkedNumber} (using the number that actually linked).`));
  }
  console.log(chalk.green(`  ✓ Signal account ${linkedNumber} is now linked.`));
  return { linked: true, number: linkedNumber };
}

/** Print step-by-step instructions for linking Signal as a device. */
function printSignalLinkInstructions(apiUrl: string, deviceName = 'mercury'): void {
  const url = signalQrLinkUrl(apiUrl, deviceName);
  console.log(chalk.dim('  To (re)link your Signal account as a Mercury device:'));
  console.log(chalk.dim('    1. Open this page to display the linking QR code:'));
  console.log('       ' + chalk.cyan(terminalLink(url)));
  console.log(chalk.dim('    2. On your phone: Signal → Settings → Linked Devices'));
  console.log(chalk.dim('    3. Tap "Link New Device" (the + button) and scan the QR code'));
}

/**
 * Poll /v1/accounts until a *new* account appears relative to a baseline set
 * (i.e. the user finished scanning the QR code), or the timeout elapses.
 * Comparing against a baseline means we don't mistake a different number that
 * was already linked for the one the user is linking now. Returns the freshly
 * linked number on success.
 */
async function waitForSignalLink(
  apiUrl: string,
  baselineAccounts: string[],
  timeoutMs = 120_000,
): Promise<{ linked: boolean; number?: string }> {
  const baseline = new Set(baselineAccounts);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await fetch(`${apiUrl}/v1/accounts`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) continue;
      const accounts = (await res.json()) as string[];
      const fresh = accounts.find((a) => !baseline.has(a));
      if (fresh) return { linked: true, number: fresh };
    } catch {
      /* container may briefly hiccup while linking; keep polling */
    }
  }
  return { linked: false };
}

async function completeInitialSignalPairing(config: MercuryConfig): Promise<void> {
  if (!config.channels.signal.enabled || !config.channels.signal.apiUrl || !config.channels.signal.number || hasSignalAdmins(config)) {
    return;
  }

  const { apiUrl, number } = config.channels.signal;

  // Test connection
  const prereqs = await checkSignalPrerequisites(apiUrl);
  if (!prereqs.apiReachable) {
    console.log(chalk.red(`\n  ✗ Cannot reach signal-cli-rest-api at ${apiUrl}`));
    if (!prereqs.dockerInstalled) {
      console.log(chalk.red('  ✗ Docker is not installed.'));
      console.log('');
      console.log(chalk.dim('  To use Signal with Mercury, you need:'));
      console.log(chalk.dim('    1. Install Docker: https://docs.docker.com/get-docker/'));
      console.log(chalk.dim('    2. Run the signal-cli-rest-api container:'));
      console.log('');
      console.log(chalk.white('       mkdir -p ~/.signal-api'));
      console.log(chalk.white('       docker run -d --name signal-api --restart=always \\'));
      console.log(chalk.white('         -p 8080:8080 \\'));
      console.log(chalk.white('         -v ~/.signal-api:/home/.local/share/signal-cli \\'));
      console.log(chalk.white('         -e MODE=normal \\'));
      console.log(chalk.white('         bbernhard/signal-cli-rest-api'));
      console.log('');
      console.log(chalk.dim(`    3. Link your Signal number by opening in browser:`));
      console.log(chalk.white(`       ${apiUrl}/v1/qrcodelink?device_name=mercury`));
      console.log(chalk.dim('       Then scan the QR code in Signal > Settings > Linked Devices'));
      console.log('');
    } else {
      console.log(chalk.dim('  Docker is installed but the container is not running.'));
      console.log('');
      console.log(chalk.dim('  Start the signal-cli-rest-api container:'));
      console.log('');
      console.log(chalk.white('    mkdir -p ~/.signal-api'));
      console.log(chalk.white('    docker run -d --name signal-api --restart=always \\'));
      console.log(chalk.white('      -p 8080:8080 \\'));
      console.log(chalk.white('      -v ~/.signal-api:/home/.local/share/signal-cli \\'));
      console.log(chalk.white('      -e MODE=normal \\'));
      console.log(chalk.white('      bbernhard/signal-cli-rest-api'));
      console.log('');
      console.log(chalk.dim(`  Then link your Signal number:`));
      console.log(chalk.white(`    Open: ${apiUrl}/v1/qrcodelink?device_name=mercury`));
      console.log(chalk.dim('    Scan QR code in Signal > Settings > Linked Devices'));
      console.log('');
    }
    console.log(chalk.dim('  After setup, run: mercury doctor'));
    console.log('');
    return;
  }

  // Check if number is registered
  if (!prereqs.accounts.includes(number)) {
    console.log(chalk.red(`\n  ✗ Number ${number} is not linked in signal-cli-rest-api.`));
    console.log('');
    console.log(chalk.dim('  Link your Signal number:'));
    console.log(chalk.white(`    Open in browser: ${apiUrl}/v1/qrcodelink?device_name=mercury`));
    console.log(chalk.dim('    Then scan the QR code in Signal > Settings > Linked Devices'));
    console.log('');
    console.log(chalk.dim('  After linking, run: mercury doctor'));
    console.log('');
    return;
  }

  // ─── Group Detection ─────────────────────────────────────────
  console.log('');
  console.log(chalk.bold.white('  Signal Pairing'));
  console.log(chalk.green('  ✓ signal-cli-rest-api is running'));
  console.log(chalk.green(`  ✓ Number ${number} is linked`));
  console.log('');

  // Check if group is already configured
  if (!config.channels.signal.groupId) {
    console.log(chalk.dim('  Scanning Signal groups...'));

    let groupFound = false;
    let groupName = 'mercury';

    // Auto-scan for a group named "Mercury" (case-insensitive)
    let matches = await SignalChannel.findGroupsByName(apiUrl, number, groupName);

    if (matches.length === 1) {
      console.log(chalk.green(`  ✓ Found group "${matches[0].name}"`));
      config.channels.signal.groupId = matches[0].id;
      config.channels.signal.groupInternalId = matches[0].internalId;
      config.channels.signal.groupName = matches[0].name;
      groupFound = true;
    } else if (matches.length > 1) {
      console.log(chalk.yellow(`  Found ${matches.length} groups named "Mercury". Using the first one.`));
      config.channels.signal.groupId = matches[0].id;
      config.channels.signal.groupInternalId = matches[0].internalId;
      config.channels.signal.groupName = matches[0].name;
      groupFound = true;
    }

    if (!groupFound) {
      console.log(chalk.dim('  No group named "Mercury" found.'));
      console.log('');
      console.log(chalk.white('  To use Signal with Mercury, create a dedicated group:'));
      console.log(chalk.dim('    1. Open Signal → New Group → name it "Mercury"'));
      console.log(chalk.dim('    2. You can be the only member'));
      console.log(chalk.dim('    3. Press Enter below to re-scan, or type a custom group name'));
      console.log('');

      while (!groupFound) {
        const input = await ask(chalk.white('  Group name [Mercury] or "skip": '));

        if (input.toLowerCase() === 'skip') {
          console.log(chalk.dim('  Signal group setup skipped. Run: mercury doctor'));
          console.log('');
          return;
        }

        const searchName = input || 'mercury';
        console.log(chalk.dim(`  Scanning for group "${searchName}"...`));
        matches = await SignalChannel.findGroupsByName(apiUrl, number, searchName);

        if (matches.length >= 1) {
          console.log(chalk.green(`  ✓ Found group "${matches[0].name}"`));
          config.channels.signal.groupId = matches[0].id;
          config.channels.signal.groupInternalId = matches[0].internalId;
          config.channels.signal.groupName = matches[0].name;
          groupFound = true;
        } else {
          console.log(chalk.red(`  No group named "${searchName}" found. Create it in Signal and try again.`));
        }
      }
    }

    saveConfig(config);
  } else {
    console.log(chalk.green(`  ✓ Group "${config.channels.signal.groupName}" configured`));
  }

  // ─── Pairing via Group Message ───────────────────────────────
  console.log('');
  console.log(chalk.white('  To pair Mercury with your Signal:'));
  console.log(chalk.dim(`    1. Open the "${config.channels.signal.groupName}" group in Signal`));
  console.log(chalk.dim(`    2. Send: `) + chalk.bold.white('mercury pair'));
  console.log(chalk.dim('    3. Mercury will reply with a pairing code in that group'));
  console.log(chalk.dim('    4. Enter the code below'));
  console.log('');

  // Start a temporary Signal channel in pairing mode
  const signal = new SignalChannel(config);
  let pairingCode: string | null = null;
  let receivedPairingMessage = false;

  signal.enablePairingMode((source: string, text: string, _groupId?: string) => {
    const normalized = text.toLowerCase().trim().replace(/[^a-z\s]/g, '');
    if (normalized === 'mercury pair' || normalized === 'mercurypair' || normalized === 'mercury') {
      receivedPairingMessage = true;
      // Generate pairing code and send it back to the group
      pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
      addSignalPendingRequest(config, {
        phoneNumber: source,
        pairingCode,
      });
      saveConfig(config);

      // Send the code to the group
      signal.sendToGroup(`Your Mercury pairing code: ${pairingCode}\n\nEnter this code in the Mercury terminal to complete setup.`);
    }
  });

  try {
    await signal.start();
    // Give the poll loop a moment to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (!signal.isReady()) {
      console.log(chalk.red('  ✗ Could not connect to Signal receive endpoint.'));
      console.log(chalk.dim('  You can pair later with: mercury signal approve <pairing-code>'));
      console.log('');
      await signal.stop();
      return;
    }

    console.log(chalk.dim(`  Waiting for "mercury pair" in the "${config.channels.signal.groupName}" group...`));
    console.log('');

    // Wait for the user to enter the code
    while (true) {
      const userCode = await ask(chalk.white('  Pairing Code (or "skip" to pair later): '));
      if (!userCode) {
        if (!receivedPairingMessage) {
          console.log(chalk.dim(`  Still waiting... Send "mercury pair" in the "${config.channels.signal.groupName}" group first.`));
        } else {
          console.log(chalk.red('  Pairing code is required.'));
        }
        continue;
      }

      if (userCode.toLowerCase() === 'skip') {
        console.log(chalk.dim('  Signal pairing skipped. Pair later with: mercury signal approve <pairing-code>'));
        console.log('');
        break;
      }

      const approved = approveSignalPendingRequestByPairingCode(config, userCode.trim());
      if (!approved) {
        if (!receivedPairingMessage) {
          console.log(chalk.red(`  No pairing code generated yet. Send "mercury pair" in the "${config.channels.signal.groupName}" group first.`));
        } else {
          console.log(chalk.red('  Invalid code. Check the code Mercury sent in the group.'));
        }
        continue;
      }

      saveConfig(config);
      console.log(chalk.green(`  ✓ Signal paired! You are now the admin (${formatSignalUser(approved)}).`));
      console.log('');
      break;
    }
  } finally {
    signal.disablePairingMode();
    await signal.stop();
  }
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
  console.log(chalk.bold.white('  Signal (optional)'));
  if (isReconfig) {
    console.log(chalk.dim('  Leave empty to keep current value. Enter "none" to disable.'));
  } else {
    console.log(chalk.dim('  Connect Mercury to Signal Messenger via signal-cli-rest-api.'));
    console.log(chalk.dim('  Requires Docker + the signal-cli-rest-api container running.'));
    console.log(chalk.dim('  Leave empty to skip. You can add it later with: mercury doctor'));
  }
  console.log('');

  // ── Link-status check ───────────────────────────────────────────────
  // Before re-prompting, find out whether an already-configured number is
  // still a live linked device. The API can be reachable while the number is
  // unlinked (the user removed Mercury's device from their phone). In that
  // case we must say so plainly and offer to relink, instead of silently
  // accepting stale config.
  let signalResolved = false;
  const existingNumber = config.channels.signal.number;
  const existingUrl = config.channels.signal.apiUrl;
  if (existingNumber && existingUrl) {
    const status = await checkSignalLinkStatus(existingUrl, existingNumber);
    const effectiveUrl = status.detectedUrl || existingUrl;
    if (status.detectedUrl && status.detectedUrl !== existingUrl) {
      config.channels.signal.apiUrl = status.detectedUrl;
    }

    if (status.linked) {
      console.log(chalk.green(`  ✓ Signal account ${existingNumber} is linked at ${effectiveUrl}`));
      config.channels.signal.enabled = true;
      signalResolved = true;
      if (isReconfig) {
        // Let a reconfiguring user still change the URL/number if they want to.
        const keep = await ask(chalk.white('  Keep this Signal setup? (Y/n): '));
        if (keep.toLowerCase() === 'n') signalResolved = false;
      }
    } else if (status.apiReachable) {
      // The key scenario: API up, but this number is no longer a linked device.
      // For privacy we do NOT echo the stale number back (someone else may now
      // be using this machine) and we silently drop it from the saved config so
      // it can't leak or be mistaken for an active account.
      config.channels.signal.number = '';
      config.channels.signal.enabled = false;
      // The old admin/member list belonged to the previous linked account. A
      // freshly linked device may be a different user, so clear access too;
      // this also lets the group-pairing flow run again (it is skipped when
      // admins already exist).
      clearSignalAccess(config);
      saveConfig(config);

      console.log(chalk.yellow('  ⚠ A Signal account was previously linked here, but it is not linked right now.'));
      console.log(chalk.dim('  It has been removed from your Mercury config.'));
      console.log('');
      const relink = await ask(chalk.white('  Link a Signal account now? (Y/n): '));
      if (relink.toLowerCase() !== 'n') {
        const result = await runSignalDeviceLinking(effectiveUrl);
        if (result.linked && result.number) {
          config.channels.signal.number = result.number;
          config.channels.signal.enabled = true;
          saveConfig(config);
        }
        signalResolved = true;
      } else {
        console.log(chalk.dim('  Skipped. Signal stays disabled until you link an account.'));
        signalResolved = true;
      }
    }
    // If not reachable, fall through to the normal flow below, which already
    // diagnoses Docker/container problems and offers to reconfigure the URL.
    console.log('');
  }

  if (!signalResolved) {
  // Auto-detect: try default localhost:8080 first
  const defaultApiUrl = config.channels.signal.apiUrl || 'http://localhost:8080';
  const prereqCheck = await checkSignalPrerequisites(defaultApiUrl);

  // Determine the actual working URL (might differ from what was entered)
  const workingApiUrl = prereqCheck.apiReachable
    ? (prereqCheck.detectedUrl || defaultApiUrl)
    : undefined;

  if (!isReconfig && prereqCheck.apiReachable && prereqCheck.accounts.length > 0) {
    // Auto-detected a running instance!
    const effectiveUrl = workingApiUrl!;
    const detectedNumber = prereqCheck.accounts[0];
    console.log(chalk.green(`  ✓ Detected signal-cli-rest-api at ${effectiveUrl}`));
    console.log(chalk.green(`  ✓ Found linked number: ${detectedNumber}`));
    const useDetected = await ask(chalk.white(`  Use this Signal setup? (Y/n): `));
    if (useDetected.toLowerCase() !== 'n') {
      config.channels.signal.apiUrl = effectiveUrl;
      config.channels.signal.number = detectedNumber;
      config.channels.signal.enabled = true;
    }
  } else {
    const signalApiMask = isReconfig && config.channels.signal.apiUrl ? ` [${config.channels.signal.apiUrl}]` : '';
    const signalApiInput = await ask(chalk.white(`  Signal API URL (e.g. http://localhost:8080)${signalApiMask}: `));
    const isNone = signalApiInput.toLowerCase() === 'none';
    // "none" disables Signal. Empty input keeps the already-stored URL (during
    // reconfig) and proceeds into Signal setup instead of silently exiting the
    // step. In a fresh setup with nothing stored, empty still means "skip".
    const signalApiUrl = isNone
      ? ''
      : (signalApiInput || (isReconfig ? config.channels.signal.apiUrl : ''));
    if (isNone) {
      config.channels.signal.enabled = false;
      config.channels.signal.apiUrl = '';
      config.channels.signal.number = '';
      clearSignalAccess(config);
    } else if (signalApiUrl) {
      config.channels.signal.apiUrl = signalApiUrl.replace(/\/+$/, '');

      // Check what's available
      const check = await checkSignalPrerequisites(config.channels.signal.apiUrl);

      // If the entered URL wasn't reachable but we found the container elsewhere, use that
      if (check.detectedUrl) {
        config.channels.signal.apiUrl = check.detectedUrl;
      }

      if (check.apiReachable && check.accounts.length > 0) {
        console.log(chalk.green(`  ✓ Connected to signal-cli-rest-api at ${config.channels.signal.apiUrl}`));
        // Auto-fill number if only one account
        if (check.accounts.length === 1) {
          config.channels.signal.number = check.accounts[0];
          console.log(chalk.green(`  ✓ Using number: ${check.accounts[0]}`));
        } else {
          console.log(chalk.dim(`  Available numbers: ${check.accounts.join(', ')}`));
          const signalNumMask = isReconfig && config.channels.signal.number ? ` [${config.channels.signal.number}]` : '';
          const signalNumber = await ask(chalk.white(`  Signal Number${signalNumMask}: `));
          if (signalNumber) config.channels.signal.number = signalNumber;
        }
        config.channels.signal.enabled = true;
      } else if (check.apiReachable) {
        console.log(chalk.yellow('  ⚠ API reachable, but no Signal device is linked yet.'));
        const result = await runSignalDeviceLinking(config.channels.signal.apiUrl, {
          currentNumber: config.channels.signal.number || undefined,
        });
        if (result.linked && result.number) {
          config.channels.signal.number = result.number;
          config.channels.signal.enabled = true;
        }
      } else {
        console.log(chalk.red(`  ✗ Cannot reach ${config.channels.signal.apiUrl}`));
        if (!check.dockerInstalled) {
          console.log(chalk.dim('  Docker is not installed. Install Docker first:'));
          console.log(chalk.white('    https://docs.docker.com/get-docker/'));
        } else if (check.containerRunning && check.detectedUrl) {
          // Container is running but on a different URL
          console.log(chalk.yellow(`  ⚠ signal-cli-rest-api is running${check.containerName ? ` (container: ${check.containerName})` : ''} but at a different URL:`));
          console.log(chalk.green(`    ${check.detectedUrl}`));
          const useDetected = await ask(chalk.white(`  Use ${check.detectedUrl} instead? (Y/n): `));
          if (useDetected.toLowerCase() !== 'n') {
            config.channels.signal.apiUrl = check.detectedUrl;
            if (check.accounts.length === 1) {
              config.channels.signal.number = check.accounts[0];
              console.log(chalk.green(`  ✓ Using number: ${check.accounts[0]}`));
            } else if (check.accounts.length > 1) {
              console.log(chalk.dim(`  Available numbers: ${check.accounts.join(', ')}`));
              const signalNumMask = isReconfig && config.channels.signal.number ? ` [${config.channels.signal.number}]` : '';
              const signalNumber = await ask(chalk.white(`  Signal Number${signalNumMask}: `));
              if (signalNumber) config.channels.signal.number = signalNumber;
            } else {
              console.log(chalk.yellow('  ⚠ No Signal device is linked yet.'));
              const result = await runSignalDeviceLinking(check.detectedUrl, {
                currentNumber: config.channels.signal.number || undefined,
              });
              if (result.linked && result.number) {
                config.channels.signal.number = result.number;
              }
            }
            if (config.channels.signal.number) config.channels.signal.enabled = true;
          }
        } else if (check.containerRunning) {
          // Container running but couldn't detect the port
          console.log(chalk.yellow(`  ⚠ A signal-cli-rest-api container is running${check.containerName ? ` (${check.containerName})` : ''} but is not reachable at the URL you entered.`));
          console.log(chalk.dim('  Check the container port mapping with: docker ps'));
          const proceed = await ask(chalk.white('  Enable Signal anyway (configure later)? (y/N): '));
          if (proceed.toLowerCase() === 'y') {
            const signalNumber = await ask(chalk.white('  Signal Number: '));
            if (signalNumber) config.channels.signal.number = signalNumber;
            config.channels.signal.enabled = true;
          }
        } else {
          console.log(chalk.dim('  Docker is installed but no signal-cli-rest-api container is running.'));
          console.log('');
          console.log(chalk.dim('  Start signal-cli-rest-api:'));
          console.log(chalk.white('    mkdir -p ~/.signal-api'));
          console.log(chalk.white('    docker run -d --name signal-api --restart=always \\'));
          console.log(chalk.white('      -p 8080:8080 \\'));
          console.log(chalk.white('      -v ~/.signal-api:/home/.local/share/signal-cli \\'));
          console.log(chalk.white('      -e MODE=normal \\'));
          console.log(chalk.white('      bbernhard/signal-cli-rest-api'));
          console.log('');
          const proceed = await ask(chalk.white('  Enable Signal anyway (configure later)? (y/N): '));
          if (proceed.toLowerCase() === 'y') {
            const signalNumber = await ask(chalk.white('  Signal Number: '));
            if (signalNumber) config.channels.signal.number = signalNumber;
            config.channels.signal.enabled = true;
          }
        }
      }
    }
  }
  } // end if (!signalResolved)

  await completeInitialSignalPairing(config);

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
    console.log(chalk.green(`  ✓ Web dashboard enabled at http://localhost:${config.web.port}`));
    console.log(chalk.dim(`    Username: mercury · Password: the one you just set (or Mercury@123 if default)`));
    console.log(chalk.dim(`    The dashboard starts automatically when Mercury runs.`));

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

  // Collaborative Knowledge
  let ck: CollaborativeKnowledgeStore | null = null;
  if (config.memory.collaborativeKnowledge?.enabled !== false && isCollaborativeKnowledgeDbAvailable()) {
    try {
      ck = new CollaborativeKnowledgeStore(config);
      setWebCollaborativeKnowledge(ck);
      if (!isDaemon) {
        console.log(chalk.dim(`  Collaborative knowledge: enabled (${ck.getSummary().total} existing memories)`));
      } else {
        logger.info({ total: ck.getSummary().total }, 'Collaborative knowledge loaded');
      }
    } catch (err) {
      logger.warn({ err }, 'Collaborative knowledge initialization failed, continuing without it');
      ck = null;
    }
  } else if (config.memory.collaborativeKnowledge?.enabled !== false && !isCollaborativeKnowledgeDbAvailable()) {
    logger.warn(
      'better-sqlite3 is not available — collaborative knowledge is disabled. ' +
      'To enable it, install build tools (make, gcc/g++, python3) and ensure Node >= 20, then reinstall.'
    );
  }

  // Notifications
  let notifications: NotificationsStore | null = null;
  if (isNotificationsDbAvailable()) {
    try {
      notifications = new NotificationsStore();
      logger.info({ unread: notifications.getSummary().unread }, 'Notifications store loaded');
    } catch (err) {
      logger.warn({ err }, 'Notifications initialization failed, continuing without it');
      notifications = null;
    }
  }
  setWebNotifications(notifications);

  // Messages
  let messagesStore: MessagesStore | null = null;
  if (isMessagesDbAvailable()) {
    try {
      messagesStore = new MessagesStore();
      logger.info({ conversations: messagesStore.getSummary().conversations }, 'Messages store loaded');
    } catch (err) {
      logger.warn({ err }, 'Messages initialization failed, continuing without it');
      messagesStore = null;
    }
  }
  setWebMessages(messagesStore);

  // Relay Client
  let relayClient: RelayClient | null = null;
  if (config.relay?.enabled !== false && config.relay?.url) {
    relayClient = new RelayClient(() => config);
    setWebRelayClient(relayClient);
    setWebRelayForRelay(relayClient);
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
    const signal = channels.get('signal');
    const sentVia: string[] = [];

    // Send via Telegram if available
    if (config.channels.telegram.enabled && telegram && getTelegramApprovedUsers(config).length > 0) {
      await telegram.send(content);
      sentVia.push('Telegram');
    }

    // Send via Signal if available
    if (config.channels.signal.enabled && signal && getSignalApprovedUsers(config).length > 0) {
      await signal.send(content);
      sentVia.push('Signal');
    }

    if (sentVia.length === 0) {
      throw new Error('No messaging channels configured with approved users. Set up Telegram or Signal via `mercury doctor`.');
    }
  });

  // Tell the capability registry which channels are active for tool descriptions
  const activeMessagingChannels: string[] = [];
  if (config.channels.telegram.enabled && channels.get('telegram')) activeMessagingChannels.push('Telegram');
  if (config.channels.signal.enabled && channels.get('signal')) activeMessagingChannels.push('Signal');
  capabilities.setActiveChannels(activeMessagingChannels);

  if (process.env.GITHUB_TOKEN) {
    setGitHubToken(process.env.GITHUB_TOKEN);
  }

  capabilities.setMemoryStores(
    () => userMemory,
    () => ck,
  );

  capabilities.registerAll();

  const agent = new Agent(
    config, providers, identity, shortTerm, longTerm, episodic, userMemory, channels, tokenBudget, capabilities, scheduler,
    relayClient, ck, notifications, messagesStore,
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
  const signalChannel = channels.get('signal') as SignalChannel | undefined;

  if (tgChannel) {
    tgChannel.setChatCommandContext(capabilities.getChatCommandContext()!);
  }

  // --- Relay Event Handlers ---
  if (relayClient) {
    // Helper to refresh friends list and push to CLI for @ autocomplete
    const refreshFriendsForUI = () => {
      if (!relayClient) return;
      relayClient.getFriends().then((data) => {
        const friends = data.friends.map(f => ({
          username: f.username,
          displayName: f.display_name,
        }));
        const bootCli = channels.getCliChannel();
        if (bootCli) {
          bootCli.setFriends(friends);
        }
      }).catch(() => {});
    };

    const storeNotification = (type: string, message: string, fromUser: string, meta?: Record<string, unknown>) => {
      if (!notifications) return;
      const record = notifications.add(type as any, message, fromUser, meta);
      if (record) {
        // Push to Telegram if available
        if (tgChannel) {
          const chatIds = getTelegramApprovedChatIds(config);
          let pushSucceeded = false;
          for (const chatId of chatIds) {
            tgChannel.send(message, chatId.toString()).then(() => {
              if (!pushSucceeded) {
                pushSucceeded = true;
                notifications!.markRead(record.id);
              }
            }).catch(() => {});
          }
        }
        // Push to CLI if available
        if (cliChannel) {
          cliChannel.send(message);
          notifications.markRead(record.id);
        }
      }
    };

    relayClient.on('friend_request', (data: unknown) => {
      const d = data as Record<string, unknown>;
      const fromUser = d.from_user as string;
      const requestId = d.request_id as string;
      storeNotification('friend_request', `@${fromUser} wants to be your memory friend`, fromUser, { request_id: requestId });
    });

    relayClient.on('initial_state', (data: unknown) => {
      const d = data as Record<string, unknown>;
      const requests = d.friend_requests as Array<{ from_user: string; request_id: string; from_display_name: string | null }> | undefined;
      if (!requests || requests.length === 0) return;
      for (const req of requests) {
        storeNotification('friend_request', `@${req.from_user} wants to be your memory friend`, req.from_user, { request_id: req.request_id });
      }
      refreshFriendsForUI();
    });

    relayClient.on('friend_accept', (data: unknown) => {
      const d = data as Record<string, unknown>;
      const fromUser = (d.from_user as string) || 'Unknown';
      storeNotification('friend_accept', `✅ @${fromUser} accepted your friend request!`, fromUser);
      refreshFriendsForUI();
    });

    relayClient.on('friend_reject', (data: unknown) => {
      const d = data as Record<string, unknown>;
      const fromUser = (d.from_user as string) || 'Unknown';
      storeNotification('friend_reject', `❌ @${fromUser} rejected your friend request.`, fromUser);
    });

    relayClient.on('friend_cancel', (data: unknown) => {
      const d = data as Record<string, unknown>;
      const fromUser = (d.from_user as string) || 'Unknown';
      storeNotification('friend_cancel', `⏳ @${fromUser} cancelled their friend request.`, fromUser);
    });

    relayClient.on('friend_remove', (data: unknown) => {
      const d = data as Record<string, unknown>;
      const fromUser = (d.from_user as string) || 'Unknown';
      storeNotification('friend_remove', `🗑 @${fromUser} removed you from their friends.`, fromUser);
      if (ck) {
        ck.revokeAllCategories(fromUser);
      }
      refreshFriendsForUI();
    });

    relayClient.on('message', (data: unknown) => {
      const d = data as Record<string, unknown>;
      const fromUser = (d.from_user as string) || 'Unknown';
      const fromDisplayName = (d.from_display_name as string | null) ?? null;
      const content = (d.content as string) || '';
      const sentAt = (d.sent_at as number) || Math.floor(Date.now() / 1000);

      if (messagesStore) {
        messagesStore.addInbound(fromUser, fromDisplayName, content, sentAt);
      }

      const displayName = fromDisplayName || fromUser;
      const formattedMessage = `💬 @${displayName}: ${content}`;
      if (tgChannel) {
        const chatIds = getTelegramApprovedChatIds(config);
        for (const chatId of chatIds) {
          tgChannel.send(formattedMessage, chatId.toString()).catch(() => {});
        }
      }
      if (cliChannel) {
        cliChannel.send(formattedMessage);
      }
    });

    relayClient.on('ck_query', (data: unknown) => {
      const d = data as CKQueryEvent;
      const fromUser = d.from_user || 'Unknown';
      const fromDisplayName = d.from_display_name ?? null;
      const requestId = d.request_id;
      const query = d.query;

      if (!ck) {
        relayClient!.sendCKResponse(fromUser, requestId, query, []).catch(() => {});
        return;
      }

      const results = ck.search(query, 10);
      const allowed = ck.getAllowedCategories(fromUser);
      const filtered = allowed.length > 0
        ? results.filter(r => allowed.includes(r.category))
        : [];
      const items: CKResultItem[] = filtered.map(r => ({
        type: r.type,
        category: r.category,
        summary: r.summary.length > 220 ? r.summary.slice(0, 220) : r.summary,
        detail: r.detail ? (r.detail.length > 500 ? r.detail.slice(0, 500) : r.detail) : null,
        confidence: r.confidence,
        importance: r.importance,
      }));

      // Determine denial message when results exist but user has no access
      let denialMessage: string | undefined;
      const ownerUsername = config.relay?.username || 'the owner';
      if (results.length > 0 && filtered.length === 0) {
        denialMessage = `You do not have access to this collaborative knowledge. Ask @${ownerUsername} to grant you access to the relevant categories.`;
      }

      const displayName = fromDisplayName || fromUser;
      relayClient!.sendCKResponse(fromUser, requestId, query, items, denialMessage)
        .then((result) => {
          if (!result.delivered) {
            logger.warn({ fromUser, query, error: result.error }, 'CK response delivery failed');
          }
        })
        .catch((err) => {
          logger.warn({ fromUser, query, err }, 'CK response send failed');
        });

      const resultCount = items.length;
      const localMessage = denialMessage
        ? `🧠 @${displayName} queried your collaborative knowledge for "${query}" — denied (no access to matching categories)`
        : `🧠 @${displayName} queried your collaborative knowledge for "${query}" (${resultCount} result${resultCount !== 1 ? 's' : ''} shared)`;
      storeNotification('ck_query', localMessage, fromUser, { request_id: requestId, query });
    });

    relayClient.on('ck_response', (data: unknown) => {
      const d = data as CKResponseEvent;
      const fromUser = d.from_user || 'Unknown';
      const fromDisplayName = d.from_display_name ?? null;
      const query = d.query;
      const results = d.results || [];
      const displayName = fromDisplayName || fromUser;

      let formattedMessage: string;
      if (d.message && results.length === 0) {
        formattedMessage = `🔒 @${displayName}'s collaborative knowledge for "${query}":\n${d.message}`;
      } else if (results.length === 0) {
        formattedMessage = `🧠 @${displayName}'s collaborative knowledge for "${query}":\nNo results found.`;
      } else {
        const lines = [`🧠 @${displayName}'s collaborative knowledge for "${query}":`, ''];
        for (const r of results) {
          lines.push(`[${r.type}|${r.category}] ${r.summary}`);
          if (r.detail) {
            lines.push(`   ${r.detail}`);
          }
        }
        formattedMessage = lines.join('\n');
      }

      if (tgChannel) {
        const chatIds = getTelegramApprovedChatIds(config);
        for (const chatId of chatIds) {
          tgChannel.send(formattedMessage, chatId.toString()).catch(() => {});
        }
      }
      if (cliChannel) {
        cliChannel.send(formattedMessage);
      }

      // Persist to notifications DB so the web UI can read it
      storeNotification('ck_response', formattedMessage, fromUser, {
        query,
        results,
        from_display_name: fromDisplayName,
      });
    });

    relayClient.on('access_update', (data: unknown) => {
      const d = data as { from_user: string; categories: string[] };
      const fromUser = d.from_user;
      const categories = d.categories || [];

      // Sync access rules to local CK store
      if (ck) {
        ck.setFriendAccess(fromUser, categories);
        logger.info({ fromUser, categories }, 'CK access updated from relay');
      }
    });

    // Auto-connect if already registered
    if (relayClient.isRegistered()) {
      relayClient.connect().then(() => {
        refreshFriendsForUI();
      }).catch((err) => {
        logger.warn({ err }, 'Relay auto-connect failed');
      });
    }
  }

  // --- Web Channel Setup ---
  setWebWebChannel(webChannel);
  setWebProgrammingMode(agent.programmingMode);
  setWebBgTasks(agent.backgroundTasks);
  setWebModelSwitch((provider) => agent.switchProvider(provider));
  setWebCurrentProvider(() => agent.getCurrentProvider());
  if (supervisor) {
    setWebSupervisor(supervisor);
    setWebKanban(supervisor);
    setWebBoardManager(boardMgr);
    setWebKanbanProviders(providers);
    setWebIDEProviders(providers);

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
    if (channelType === 'web' && webChannel) {
      return webChannel.askPermission(prompt);
    }
    if (channelType === 'signal' && signalChannel) {
      // Bind the prompt to the exact sender that triggered the action so it
      // reaches the right person in the Mercury group (not the CLI).
      return signalChannel.askPermission(prompt, capabilities.permissions.getCurrentChannelId());
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

  if (signalChannel) {
    signalChannel.setOnPermissionMode((mode, source) => {
      if (mode === 'allow-all') {
        capabilities.permissions.setAutoApproveAll(true);
        capabilities.permissions.addTempScope('/', true, true);
        logger.info({ source }, 'Signal: Allow All mode set for session');
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
      console.log(chalk.cyan(`  Web dashboard: http://localhost:${config.web.port}`) + chalk.dim(` · login as `) + chalk.white('mercury'));
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
      console.log(chalk.dim('  Web dashboard disabled. Run ') + chalk.white('mercury doctor') + chalk.dim(' to enable it.'));
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
      logger.info(`Web dashboard: http://localhost:${config.web.port}`);
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
    if (userMemory) {
      try {
        userMemory.consolidate();
        userMemory.close();
      } catch {}
    }
    if (relayClient) {
      relayClient.disconnect();
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
    console.log(`  Signal:   ${config.channels.signal.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
    if (config.channels.signal.enabled) {
      console.log(`  Signal Access: ${chalk.white(getSignalAccessSummary(config))}`);
      console.log(`  Signal API: ${chalk.dim(config.channels.signal.apiUrl || '(not set)')}`);
    }    console.log(`  Web:      ${config.web.enabled ? chalk.green(`enabled · http://localhost:${config.web.port}`) + chalk.dim(` · user: mercury`) : chalk.dim('disabled') + chalk.dim(' — run ') + chalk.white('mercury doctor') + chalk.dim(' to enable')}`);
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
    if (config.channels.signal.enabled) {
      printSignalAccessState(config);
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

// ─── Signal CLI Commands ─────────────────────────────────────

const signalCmd = program
  .command('signal')
  .description('Manage Signal access approvals and connection');

signalCmd
  .command('status')
  .description('Show Signal connection status and access list')
  .action(async () => {
    const config = loadConfig();

    // Detect link status before printing anything. If the API is reachable but
    // the configured number is no longer a linked device, silently scrub it so
    // we never display a stale number that may belong to someone else.
    let unlinked = false;
    let effectiveUrl = config.channels.signal.apiUrl;
    let prereqs: Awaited<ReturnType<typeof checkSignalPrerequisites>> | undefined;
    if (config.channels.signal.apiUrl) {
      prereqs = await checkSignalPrerequisites(config.channels.signal.apiUrl);
      effectiveUrl = prereqs.detectedUrl || config.channels.signal.apiUrl;
      if (prereqs.apiReachable && config.channels.signal.number && !prereqs.accounts.includes(config.channels.signal.number)) {
        unlinked = true;
        config.channels.signal.number = '';
        config.channels.signal.enabled = false;
        // Access list belonged to the now-unlinked account; clear it so a
        // relink re-runs pairing and a stale admin can't retain access.
        clearSignalAccess(config);
        saveConfig(config);
      }
    }

    console.log('');
    console.log(chalk.bold.white('  Signal Channel Status'));
    console.log(`  Enabled:   ${config.channels.signal.enabled ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`  API URL:   ${config.channels.signal.apiUrl ? chalk.white(config.channels.signal.apiUrl) : chalk.dim('(not set)')}`);
    console.log(`  Number:    ${config.channels.signal.number ? chalk.white(config.channels.signal.number) : chalk.dim('(not set)')}`);
    console.log(`  Group:     ${config.channels.signal.groupName ? chalk.white(`"${config.channels.signal.groupName}"`) : chalk.dim('(not set)')}`);

    if (prereqs) {
      console.log(`  Docker:    ${prereqs.dockerInstalled ? chalk.green('installed') : chalk.red('not installed')}`);
      console.log(`  Container: ${prereqs.containerRunning ? chalk.green('running') : chalk.red('not running')}`);
      if (prereqs.apiReachable) {
        console.log(`  API:       ${chalk.green('reachable')}`);
        if (unlinked) {
          console.log('');
          console.log(chalk.yellow('  ⚠ A Signal account was previously linked here but is not linked right now.'));
          console.log(chalk.dim('  The stale number has been removed from your config.'));
          printSignalLinkInstructions(effectiveUrl);
          console.log(chalk.dim('  Then run `mercury doctor` to finish setup.'));
        } else if (config.channels.signal.number) {
          console.log(`  Number linked: ${chalk.green('yes')}`);
        } else {
          console.log(`  Number linked: ${chalk.dim('no account configured')}`);
        }
      } else {
        console.log(`  API:       ${chalk.red('not reachable')}`);
      }
    }

    printSignalAccessState(config);
    console.log('');
  });

signalCmd
  .command('list')
  .description('Show approved Signal users and pending access requests')
  .action(() => {
    const config = loadConfig();
    printSignalAccessState(config);
    console.log('');
  });

signalCmd
  .command('approve <codeOrNumber>')
  .description('Approve a pending Signal access request by pairing code or phone number')
  .action((codeOrNumber: string) => {
    const config = loadConfig();
    const hasAdmins = hasSignalAdmins(config);

    if (!hasAdmins) {
      // First user — approve by pairing code
      const approved = approveSignalPendingRequestByPairingCode(config, codeOrNumber.trim());
      if (!approved) {
        console.log('');
        console.log(chalk.red(`  No pending first-time Signal pairing found for code ${codeOrNumber}.`));
        console.log('');
        return;
      }

      saveConfig(config);
      console.log('');
      console.log(chalk.green(`  ✓ Approved first Signal admin ${formatSignalUser(approved)}.`));
      restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
      console.log('');
      return;
    }

    // Subsequent users — approve by phone number
    const phoneNumber = codeOrNumber.startsWith('+') ? codeOrNumber : `+${codeOrNumber}`;
    const approved = approveSignalPendingRequest(config, phoneNumber, 'member');
    if (!approved) {
      // Try as pairing code fallback
      const approvedByCode = approveSignalPendingRequestByPairingCode(config, codeOrNumber.trim());
      if (!approvedByCode) {
        console.log('');
        console.log(chalk.red(`  No pending Signal request found for ${codeOrNumber}.`));
        console.log('');
        return;
      }

      saveConfig(config);
      console.log('');
      console.log(chalk.green(`  ✓ Approved Signal member ${formatSignalUser(approvedByCode)}.`));
      restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Approved Signal member ${formatSignalUser(approved)}.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

signalCmd
  .command('reject <phoneNumber>')
  .description('Reject a pending Signal access request')
  .action((phoneNumber: string) => {
    const config = loadConfig();
    const number = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

    const rejected = rejectSignalPendingRequest(config, number);
    if (!rejected) {
      console.log('');
      console.log(chalk.red(`  No pending Signal request found for ${phoneNumber}.`));
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Rejected Signal request for ${formatSignalUser(rejected)}.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

signalCmd
  .command('remove <phoneNumber>')
  .description('Remove an approved Signal user')
  .action((phoneNumber: string) => {
    const config = loadConfig();
    const number = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

    const removed = removeSignalUser(config, number);
    if (!removed) {
      console.log('');
      console.log(chalk.red(`  No approved Signal user found for ${phoneNumber}.`));
      console.log('');
      return;
    }

    saveConfig(config);
    console.log('');
    console.log(chalk.green(`  ✓ Removed Signal access for ${formatSignalUser(removed)}.`));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    console.log('');
  });

signalCmd
  .command('unpair')
  .description('Reset all Signal access for this Mercury instance')
  .action(() => {
    const config = loadConfig();
    const hasAnyAccess = getSignalApprovedUsers(config).length > 0 || getSignalPendingRequests(config).length > 0;
    if (!hasAnyAccess) {
      console.log('');
      console.log(chalk.dim('  Signal access is already empty.'));
      console.log('');
      return;
    }

    clearSignalAccess(config);
    saveConfig(config);

    console.log('');
    console.log(chalk.green('  ✓ Signal access reset.'));
    restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
    if (!getDaemonStatus().running) {
      console.log(chalk.dim('  New Signal users can send a message to request access.'));
      console.log(chalk.dim('  The first request must be approved from the CLI with `mercury signal approve <pairing-code>`.'));
    }
    console.log('');
  });

signalCmd
  .command('test')
  .description('Test Signal API connection and send a test message')
  .action(async () => {
    const config = loadConfig();
    if (!config.channels.signal.apiUrl || !config.channels.signal.number) {
      console.log('');
      console.log(chalk.red('  Signal is not configured. Run: mercury doctor'));
      console.log('');
      return;
    }

    console.log('');
    console.log(chalk.dim('  Testing Signal connection...'));
    const test = await testSignalConnection(config.channels.signal.apiUrl, config.channels.signal.number);
    if (!test.ok) {
      console.log(chalk.red(`  ✗ ${test.error}`));
      console.log('');
      return;
    }
    console.log(chalk.green('  ✓ Signal API reachable'));
    console.log(chalk.green(`  ✓ Number ${config.channels.signal.number} is registered`));

    // Send a test message to the group (or self if no group)
    const sendTarget = config.channels.signal.groupId || config.channels.signal.number;
    const targetLabel = config.channels.signal.groupId ? `"${config.channels.signal.groupName}" group` : 'Note to Self';
    console.log(chalk.dim(`  Sending test message to ${targetLabel}...`));
    try {
      const res = await fetch(`${config.channels.signal.apiUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Mercury Signal test — ${new Date().toLocaleString()}`,
          number: config.channels.signal.number,
          recipients: [sendTarget],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        console.log(chalk.green(`  ✓ Test message sent (check the ${targetLabel} in Signal)`));
      } else {
        const body = await res.text().catch(() => '');
        console.log(chalk.red(`  ✗ Send failed: ${body || res.status}`));
      }
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
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
    console.log(chalk.dim(`  Login at http://localhost:${loadConfig().web.port}`));
    console.log('');
  });

program.parse();
