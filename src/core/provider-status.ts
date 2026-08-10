import type { Channel } from '../channels/base.js';
import { CLIChannel } from '../channels/cli.js';

export function updateCliProviderStatus(channel: Channel | undefined, providerName: string, model: string): void {
  if (!(channel instanceof CLIChannel)) return;
  const label = providerName === 'mercuryCloud' ? 'Mercury Cloud' : providerName;
  channel.setProvider(label, model);
}
