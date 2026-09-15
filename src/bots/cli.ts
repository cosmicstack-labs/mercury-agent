import type { Command } from 'commander';
import { loadConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { BotStore } from './store.js';
import { BotQueue } from './queue.js';
import { BotJournal } from './journal.js';
import { runBotDoctor, formatDoctorReport } from './doctor.js';

/** Per-bot journal accessor matching BotManager's retention resolution. */
function journalFor(store: BotStore, config: ReturnType<typeof loadConfig>) {
  return (botId: string): BotJournal => {
    const manifest = store.get(botId);
    const retention = { ...(config.bots?.retention ?? {}), ...(manifest?.retention ?? {}) };
    return new BotJournal(store.botDir(botId), retention.journalRotateBytes, retention.journalKeepRotations);
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `mercury bots` — CLI surface for the bot fleet (doctor / list / storage).
 * Read-only: mutation happens through the agent (/bots) or the HTTP API.
 */
export function registerBotsCommand(program: Command): void {
  const bots = program
    .command('bots')
    .description('Mercury Bots fleet tooling (see /bots inside the agent for the interactive surface)');

  bots
    .command('doctor')
    .description('Read-only fleet health check — exits 1 when anything is actionable')
    .action(() => {
      const config = loadConfig();
      const store = new BotStore();
      const queue = new BotQueue(store.botsRoot, config.bots?.retention?.dlqCap);
      const getJournal = journalFor(store, config);
      const report = runBotDoctor({
        store,
        queue,
        journalFor: getJournal,
      });
      console.log(formatDoctorReport(report));
      if (!report.healthy) {
        process.exitCode = 1;
      }
    });

  bots
    .command('list')
    .description('List configured bots with their live config summary')
    .action(() => {
      const store = new BotStore();
      const manifests = store.list();
      if (manifests.length === 0) {
        console.log('No bots configured. Onboard one with /bots create <id> "Name" "Description".');
        return;
      }
      for (const m of manifests) {
        const model = m.model?.provider ? `${m.model.provider}${m.model.model ? `:${m.model.model}` : ''}` : 'inherit';
        const routines = (m.schedules?.length ?? 0);
        console.log(`${m.enabled ? '🟢' : '⛔'} ${m.id.padEnd(20)} ${m.name.padEnd(24)} model=${model.padEnd(30)} routines=${routines}`);
      }
    });

  bots
    .command('storage')
    .description('Per-bot disk usage (retention caps are enforced at write time)')
    .action(() => {
      const store = new BotStore();
      const usage = store.usage();
      if (usage.length === 0) {
        console.log('No bot storage in use.');
        return;
      }
      let total = 0;
      for (const u of usage) {
        total += u.bytes;
        console.log(`${u.id.padEnd(20)} ${formatBytes(u.bytes).padStart(10)} (journal ${formatBytes(u.journalBytes)})`);
      }
      console.log(`\nTotal: ${formatBytes(total)}`);
    });

  void logger;
}