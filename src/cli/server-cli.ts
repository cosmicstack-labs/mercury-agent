import type { Command } from 'commander';
import chalk from 'chalk';
import { getWebPort, readAttachToken } from '../web/auth.js';
import { httpServerOps, localServerOps } from '../security/server-ops.js';
import { runServerCommand, type ServerOps } from '../security/server-menu.js';

/**
 * `mercury server` — remote access and its security, from a shell on this
 * computer: the same menu and commands as `/server` in the terminal chat.
 *
 *   mercury server                 the menu
 *   mercury server approve K7Q2M   let a waiting device in
 *   mercury server off             refuse every other device
 *
 * With Mercury running it works through Mercury (so approvals and revokes
 * take effect at once, and revoked devices' live connections close); with
 * Mercury stopped it edits the settings and device list directly.
 */

export async function opsForThisComputer(): Promise<{ ops: ServerOps; live: boolean }> {
  const token = readAttachToken();
  const base = `http://127.0.0.1:${getWebPort()}`;
  if (token) {
    try {
      const res = await fetch(`${base}/api/security/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2500) });
      if (res.ok) return { ops: httpServerOps(base, token), live: true };
    } catch { /* not running */ }
  }
  return { ops: localServerOps({ by: 'cli', offline: true }), live: false };
}

export function registerServerCli(program: Command): void {
  program
    .command('server [args...]')
    .description('Remote access and security: devices, approvals, allowed addresses, the security check')
    .action(async (args: string[] = []) => {
      const { ops, live } = await opsForThisComputer();
      if (!live) console.log(chalk.dim('  Mercury is not running: changing settings directly (nothing is waiting for approval).'));
      const { selectWithArrowKeys } = await import('../utils/arrow-select.js');
      const { acknowledgeSecret } = await import('../utils/clipboard.js');
      const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
      try {
        await runServerCommand(args.join(' '), ops, {
          choose: async (title, options) => (tty ? (await selectWithArrowKeys(title, options).catch(() => '')) || null : null),
          say: async (text) => { console.log(`\n${text.replace(/\*\*(.+?)\*\*/g, (_m, t: string) => chalk.bold(t))}\n`); },
          secret: async (text, copy) => {
            console.log(`\n${text}\n`);
            if (tty) await acknowledgeSecret((t, o) => selectWithArrowKeys(t, o).catch(() => ''), 'Copy the token now: it is not shown again.', copy);
          },
          terminal: true,
          waitFor: (text, until) => {
            console.log(`\n${text}\n`);
            console.log(chalk.dim('  Waiting for your phone… Ctrl+C cancels the code.'));
            return new Promise((resolve, reject) => {
              const stop = () => { process.off('SIGINT', stop); resolve(null); };
              process.on('SIGINT', stop);
              until.then((v) => { process.off('SIGINT', stop); resolve(v); }, (e: unknown) => { process.off('SIGINT', stop); reject(e); });
            });
          },
        });
      } catch (err) {
        console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}
