import type { Channel } from '../channels/base.js';
import { CLIChannel } from '../channels/cli.js';

/**
 * The runtime's status publisher (attached terminals, dashboard). Set once at
 * boot; called whenever the provider changes so the bottom bar updates at
 * once instead of on the next poll.
 */
let publishStatusFn: (() => void) | null = null;

export function setStatusPublisher(fn: () => void): void {
  publishStatusFn = fn;
}

export function publishStatus(): void {
  try { publishStatusFn?.(); } catch { /* status is best effort */ }
}

export function updateCliProviderStatus(channel: Channel | undefined, providerName: string, model: string): void {
  if (channel instanceof CLIChannel) {
    const label = providerName === 'mercuryCloud' ? 'Mercury Cloud' : providerName;
    channel.setProvider(label, model);
  }
  publishStatus();
}
