import { Command } from 'commander';
import readline from 'node:readline';
import chalk from 'chalk';
import { loadConfig, saveConfig, isSetupComplete, getMercuryHome, ensureCreatorField } from './utils/config.js';
import { logger } from './utils/logger.js';
import { Identity } from './soul/identity.js';
import { ShortTermMemory, LongTermMemory, EpisodicMemory } from './memory/store.js';
import { ProviderRegistry } from './providers/registry.js';
import { Agent } from './core/agent.js';
import { Scheduler } from './core/scheduler.js';
import { ChannelRegistry } from './channels/registry.js';
import { CLIChannel } from './channels/cli.js';
import { TokenBudget } from './utils/tokens.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { SkillLoader } from './skills/loader.js';

function hr() {
  console.log(chalk.dim('─'.repeat(50)));
}

function banner() {
  console.log('');
  console.log(chalk.cyan(' ███╗   ███╗██╗███╗   ███╗███████╗██████╗ ████████╗'));
  console.log(chalk.cyan(' ████╗ ████║██║████╗ ████║██╔════╝██╔══██╗╚══██╔══╝'));
  console.log(chalk.cyan(' ██╔████╔██║██║██╔████╔██║█████╗  ██████╔╝   ██║   '));
  console.log(chalk.cyan(' ██║╚██╔╝██║██║██║╚██╔╝██║██╔══╝  ██╔══██╗   ██║   '));
  console.log(chalk.cyan(' ██║ ╚═╝ ██║██║██║ ╚═╝ ██║███████╗██║  ██║   ██║   '));
  console.log(chalk.cyan(' ╚═╝     ╚═╝╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝   '));
  console.log(chalk.dim('     v0.1.0 — an AI agent for personal tasks'));
  console.log(chalk.dim('     by Cosmic Stack — mercury.cosmicstack.org'));
  console.log('');
}

function splashScreen() {
  console.log('');
  console.log(chalk.cyan(' ███╗   ███╗██╗███╗   ███╗███████╗██████╗ ████████╗'));
  console.log(chalk.cyan(' ████╗ ████║██║████╗ ████║██╔════╝██╔══██╗╚══██╔══╝'));
  console.log(chalk.cyan(' ██╔████╔██║██║██╔████╔██║█████╗  ██████╔╝   ██║   '));
  console.log(chalk.cyan(' ██║╚██╔╝██║██║██║╚██╔╝██║██╔══╝  ██╔══██╗   ██║   '));
  console.log(chalk.cyan(' ██║ ╚═╝ ██║██║██║ ╚═╝ ██║███████╗██║  ██║   ██║   '));
  console.log(chalk.cyan(' ╚═╝     ╚═╝╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝   '));
  console.log('');
  console.log(chalk.dim('     ─────────────────────────────────────'));
  console.log(chalk.white('     M E R C U R Y'));
  console.log(chalk.dim('     ─────────────────────────────────────'));
  console.log(chalk.dim('     an AI agent for personal tasks'));
  console.log(chalk.cyan('     by Cosmic Stack'));
  console.log(chalk.dim('     mercury.cosmicstack.org'));
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

async function onboarding(): Promise<void> {
  splashScreen();
  console.log(chalk.yellow('  First run detected — let\'s set you up.'));
  hr();
  console.log('');

  const config = loadConfig();

  const ownerName = await ask(chalk.white('  Your name: '));
  if (!ownerName) {
    console.log(chalk.red('  Name is required.'));
    process.exit(1);
  }
  config.identity.owner = ownerName;

  const agentName = await ask(chalk.white(`  Agent name [${config.identity.name}]: `));
  if (agentName) config.identity.name = agentName;

  config.identity.creator = 'Cosmic Stack';

  hr();
  console.log('');
  console.log(chalk.white('  LLM Providers'));
  console.log(chalk.dim('  At least one API key is required.'));
  console.log('');

  const deepseekKey = await ask(chalk.white('  DeepSeek API key: '));
  if (deepseekKey) {
    config.providers.deepseek.apiKey = deepseekKey;
    config.providers.default = 'deepseek';
  }

  const openaiKey = await ask(chalk.white('  OpenAI API key (Enter to skip): '));
  if (openaiKey) config.providers.openai.apiKey = openaiKey;

  const anthropicKey = await ask(chalk.white('  Anthropic API key (Enter to skip): '));
  if (anthropicKey) config.providers.anthropic.apiKey = anthropicKey;

  if (!deepseekKey && !openaiKey && !anthropicKey) {
    console.log(chalk.red('\n  At least one LLM API key is required.'));
    process.exit(1);
  }

  hr();
  console.log('');
  console.log(chalk.white('  Telegram (optional)'));
  console.log(chalk.dim('  Leave empty to skip. You can add it later.'));
  console.log('');

  const telegramToken = await ask(chalk.white('  Telegram Bot Token: '));
  if (telegramToken) {
    config.channels.telegram.botToken = telegramToken;
    config.channels.telegram.enabled = true;
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
  console.log('');
  console.log(chalk.cyan(`  ${config.identity.name} is ready. Run \`mercury start\` to begin.`));
  console.log(chalk.dim('  mercury.cosmicstack.org'));
  console.log('');
}

async function runAgent(): Promise<void> {
  let config = loadConfig();
  config = ensureCreatorField(config);
  const name = config.identity.name;

  banner();
  console.log(chalk.white(`  ${name} is waking up...`));
  console.log('');

  const tokenBudget = new TokenBudget(config);
  const providers = new ProviderRegistry(config);

  if (!providers.hasProviders()) {
    console.log(chalk.red('  No LLM providers available. Run `mercury setup` to configure API keys.'));
    process.exit(1);
  }

  const available = providers.listAvailable();
  console.log(chalk.dim(`  Providers: ${available.join(', ')}`));

  const skillLoader = new SkillLoader();
  const skills = skillLoader.discover();
  console.log(chalk.dim(`  Skills: ${skills.length > 0 ? skills.map(s => s.name).join(', ') : 'none installed'}`));

  const scheduler = new Scheduler(config);

  const identity = new Identity();
  const shortTerm = new ShortTermMemory(config);
  const longTerm = new LongTermMemory(config);
  const episodic = new EpisodicMemory(config);

  const channels = new ChannelRegistry(config);
  const capabilities = new CapabilityRegistry(skillLoader, scheduler);

  const agent = new Agent(
    config, providers, identity, shortTerm, longTerm, episodic, channels, tokenBudget, capabilities, scheduler,
  );

  await agent.birth();
  await agent.wake();

  const cliChannel = channels.get('cli') as CLIChannel | undefined;

  if (cliChannel) {
    capabilities.permissions.onAsk(async (prompt: string) => {
      return cliChannel.askPermission(prompt);
    });
  }

  const activeCh = channels.getActiveChannels();
  const toolNames = capabilities.getToolNames();
  console.log(chalk.dim(`  Channels: ${activeCh.join(', ')}`));
  console.log(chalk.dim(`  Tools: ${toolNames.join(', ')}`));
  console.log(chalk.dim(`  Permissions: ${getMercuryHome()}/permissions.yaml`));
  console.log(chalk.dim(`  Schedules: ${getMercuryHome()}/schedules.yaml`));
  if (config.identity.creator) {
    console.log(chalk.dim(`  Creator: ${config.identity.creator}`));
  }
  hr();
  console.log('');
  console.log(chalk.green(`  ${name} is live. Type a message and press Enter.`));
  console.log(chalk.dim('  Ctrl+C to exit.'));
  console.log('');

  cliChannel?.showPrompt();

  const shutdown = async () => {
    console.log('');
    console.log(chalk.dim(`  ${name} is shutting down...`));
    await agent.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const program = new Command();

program
  .name('mercury')
  .description('Mercury — an AI agent for personal tasks')
  .version('0.1.0')
  .option('-v, --verbose', 'Show debug logs')
  .action(async () => {
    if (!isSetupComplete()) {
      await onboarding();
      return;
    }
    await runAgent();
  });

program
  .command('start')
  .description('Start Mercury agent')
  .option('-v, --verbose', 'Show debug logs')
  .action(async () => {
    if (!isSetupComplete()) {
      await onboarding();
      return;
    }
    await runAgent();
  });

program
  .command('setup')
  .description('Re-run the setup wizard')
  .action(async () => {
    await onboarding();
  });

program
  .command('status')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfig();
    const home = getMercuryHome();
    const skillLoader = new SkillLoader();
    const skills = skillLoader.discover();
    banner();
    console.log(`  Name:     ${chalk.cyan(config.identity.name)}`);
    console.log(`  Owner:    ${chalk.white(config.identity.owner || '(not set)')}`);
    if (config.identity.creator) {
      console.log(`  Creator:  ${chalk.white(config.identity.creator)}`);
    }
    console.log(`  Provider: ${chalk.white(config.providers.default)}`);
    console.log(`  Telegram: ${config.channels.telegram.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
    console.log(`  Skills:   ${skills.length > 0 ? chalk.green(skills.map(s => s.name).join(', ')) : chalk.dim('none')}`);
    console.log(`  Budget:   ${chalk.white(config.tokens.dailyBudget)} tokens/day`);
    console.log(`  Setup:    ${isSetupComplete() ? chalk.green('complete') : chalk.red('not done')}`);
    console.log(`  Home:     ${chalk.dim(home)}`);
    console.log('');
  });

program.parse();