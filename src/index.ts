#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, saveConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { Identity } from './soul/identity.js';
import { ShortTermMemory, LongTermMemory, EpisodicMemory } from './memory/store.js';
import { ProviderRegistry } from './providers/registry.js';
import { ChannelRegistry } from './channels/registry.js';
import { Agent } from './core/agent.js';
import { TokenBudget } from './utils/tokens.js';
import { SkillLoader } from './skills/loader.js';

const program = new Command();

program
  .name('mercury')
  .description('Mercury — an AI agent for personal tasks')
  .version('0.1.0');

program
  .command('start')
  .description('Start Mercury agent')
  .option('-m, --mode <mode>', 'Run mode: cli, daemon', 'cli')
  .action(async (opts) => {
    const config = loadConfig();

    if (!config.identity.owner) {
      logger.error('Owner not set. Run `mercury setup` first.');
      process.exit(1);
    }

    const tokenBudget = new TokenBudget(config);
    const providers = new ProviderRegistry(config);

    if (!providers.hasProviders()) {
      logger.error('No LLM providers available. Set API keys in .env or mercury.yaml.');
      process.exit(1);
    }

    const identity = new Identity(config);
    const shortTerm = new ShortTermMemory(config);
    const longTerm = new LongTermMemory(config);
    const episodic = new EpisodicMemory(config);
    const skillLoader = new SkillLoader();
    const discoveredSkills = skillLoader.discover();

    logger.info({ skills: discoveredSkills.map(s => s.name) }, 'Skills loaded');

    const channels = new ChannelRegistry(config);
    const agent = new Agent(
      config, providers, identity, shortTerm, longTerm, episodic, channels, tokenBudget,
    );

    await agent.birth();
    await agent.wake();

    const shutdown = async () => {
      await agent.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('setup')
  .description('Configure Mercury (interactive setup)')
  .action(async () => {
    const config = loadConfig();

    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log(`\n  Mercury Setup Wizard\n  ${'─'.repeat(30)}\n`);

    const ownerName = await rl.question('  Your name: ');
    config.identity.owner = ownerName || config.identity.owner;

    const agentName = await rl.question(`  Agent name [${config.identity.name}]: `);
    if (agentName) config.identity.name = agentName;

    console.log('\n  LLM Providers\n');

    const openaiKey = await rl.question('  OpenAI API key: ');
    if (openaiKey) config.providers.openai.apiKey = openaiKey;

    const anthropicKey = await rl.question('  Anthropic API key (optional): ');
    if (anthropicKey) config.providers.anthropic.apiKey = anthropicKey;

    const deepseekKey = await rl.question('  DeepSeek API key (optional): ');
    if (deepseekKey) config.providers.deepseek.apiKey = deepseekKey;

    console.log('\n  Telegram (optional)\n');

    const telegramToken = await rl.question('  Telegram Bot Token (leave empty to skip): ');
    if (telegramToken) {
      config.channels.telegram.botToken = telegramToken;
      config.channels.telegram.enabled = true;
    }

    saveConfig(config);
    console.log(`\n  Configuration saved.\n  Run \`mercury start\` to begin.\n`);

    rl.close();
  });

program
  .command('status')
  .description('Show Mercury status')
  .action(() => {
    const config = loadConfig();
    console.log(`  Name:    ${config.identity.name}`);
    console.log(`  Owner:   ${config.identity.owner || '(not set)'}`);
    console.log(`  Default: ${config.providers.default}`);
    console.log(`  Telegram: ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}`);
    console.log(`  Budget:  ${config.tokens.dailyBudget} tokens/day`);
  });

program.parse();