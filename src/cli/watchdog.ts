import { logger } from '../utils/logger.js';
import { writeCrashFlag } from '../core/crash-flag.js';

const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 60_000;
const BASE_DELAY_MS = 1_000;

export async function runWithWatchdog(agentFn: () => Promise<void>): Promise<void> {
  const restarts: number[] = [];

  async function attempt(): Promise<void> {
    try {
      await agentFn();
    } catch (err) {
      const now = Date.now();
      restarts.push(now);
      const recentRestarts = restarts.filter(t => now - t < RESTART_WINDOW_MS);
      const restartCount = recentRestarts.length;

      if (restartCount >= MAX_RESTARTS) {
        logger.error({ restartCount }, 'Max restarts exceeded within 60s. Exiting.');
        writeCrashFlag({
          reason: `Max restarts exceeded (${restartCount} crashes in 60s). Last error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
          timestamp: Date.now(),
        });
        // Last-gasp: synchronous stderr write so the log always shows
        // even if the logger is broken.
        process.stderr.write(`[mercury] FATAL: Max restarts exceeded (${restartCount} in 60s). Last error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      const delay = BASE_DELAY_MS * Math.pow(1.25, restartCount);
      logger.warn({ err, restartCount, delay }, 'Crash detected. Restarting with backoff...');
      await sleep(delay);
      await attempt();
    }
  }

  await attempt();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}