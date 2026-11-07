import type { Command } from 'commander';
import chalk from 'chalk';
import { hostname, platform } from 'node:os';
import { createDevice, listDevices, revokeDevice } from '../web/devices.js';

/**
 * `mercury devices` — pair and manage remote clients (Mercury Desktop on
 * another machine, a phone, a script). Tokens are shown once.
 *
 *   mercury devices add "Office laptop"      → prints the token to paste
 *   mercury devices list
 *   mercury devices revoke <id>
 *
 * Runs against the device file directly; the runtime does not need to be
 * up, and a token takes effect on the next request.
 */
export function registerDevicesCli(program: Command): void {
  const devices = program
    .command('devices')
    .description('Pair remote clients (Mercury Desktop, phones, scripts) with device tokens');

  devices
    .command('add [name]')
    .description('Create a device token (shown once) for a remote client')
    .option('--platform <platform>', 'macos | windows | linux | android | ios | script', 'script')
    .option('--json', 'Print machine-readable output')
    .action((name: string | undefined, opts: { platform?: string; json?: boolean }) => {
      const created = createDevice(name ?? `${hostname()} (${platform()})`, opts.platform);
      if (opts.json) {
        console.log(JSON.stringify(created));
        return;
      }
      console.log('');
      console.log(chalk.green(`  ✓ Device "${created.device.name}" added`) + chalk.dim(` · id ${created.device.id}`));
      console.log('');
      console.log('  Paste this token into Mercury Desktop → Add connection. It is shown once:');
      console.log('');
      console.log(`    ${chalk.white(created.token)}`);
      console.log('');
      console.log(chalk.dim('  Revoke it any time with: mercury devices revoke ' + created.device.id));
      console.log('');
    });

  devices
    .command('list')
    .description('List paired devices')
    .option('--json', 'Print machine-readable output')
    .action((opts: { json?: boolean }) => {
      const list = listDevices();
      if (opts.json) {
        console.log(JSON.stringify(list));
        return;
      }
      console.log('');
      if (list.length === 0) {
        console.log(chalk.dim('  No devices paired. Add one with: mercury devices add "My laptop"'));
        console.log('');
        return;
      }
      for (const d of list) {
        const seen = d.lastSeenAt ? `last seen ${formatAgo(d.lastSeenAt)}` : 'never connected';
        console.log(`  ${chalk.white(d.id)}  ${d.name}` + chalk.dim(`  · ${d.platform} · ${seen}`));
      }
      console.log('');
    });

  devices
    .command('revoke <id>')
    .description('Revoke a device token')
    .action((id: string) => {
      if (revokeDevice(id)) {
        console.log(chalk.green(`  ✓ Device ${id} revoked`));
      } else {
        console.error(chalk.red(`  ✗ No device with id ${id}`));
        process.exitCode = 1;
      }
    });
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
