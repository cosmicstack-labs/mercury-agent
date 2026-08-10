import { describe, expect, it } from 'vitest';
import { CLIChannel } from '../channels/cli.js';
import { updateCliProviderStatus } from './provider-status.js';

describe('live CLI provider status', () => {
  it('updates the visible provider and model without restarting the CLI', () => {
    const channel = new CLIChannel();

    updateCliProviderStatus(channel, 'openai', 'gpt-5');
    expect((channel as any).state.provider).toEqual({ name: 'openai', model: 'gpt-5', badge: undefined });

    updateCliProviderStatus(channel, 'mercuryCloud', 'mercury-flash');
    expect((channel as any).state.provider).toEqual({ name: 'Mercury Cloud', model: 'mercury-flash', badge: undefined });
  });
});
