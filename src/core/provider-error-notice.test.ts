import { describe, expect, it } from 'vitest';
import { whitelabelProviderError } from './agent.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CLIChannel } from '../channels/cli.js';

const cliSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'channels', 'cli.ts'), 'utf8');

/**
 * Whitelabeled fallback errors: when a provider fails mid-task (expired
 * token, rate limit…) the user must see a short, respectful line naming the
 * provider, the reason, and where the task continues — rendered DURABLY in
 * Mercury Code (heartbeat rows are filtered out of the coding transcript, so
 * the old generic heartbeat notice never showed there).
 */
describe('whitelabelProviderError', () => {
  it('maps auth/token failures to a respectful one-liner', () => {
    expect(whitelabelProviderError({ message: 'Request failed with status code 401' })).toContain('token');
    expect(whitelabelProviderError({
      message: 'Incorrect API key provided',
      statusCode: 401,
      responseBody: '{"error":{"code":"invalid_api_key"}}',
    })).toContain('credentials');
    expect(whitelabelProviderError({ message: 'JWT token expired at 1757…' })).toContain('expired');
  });

  it('maps rate limits, limits, and server errors', () => {
    expect(whitelabelProviderError({ message: '429 Too Many Requests' })).toContain('Rate limited');
    expect(whitelabelProviderError({ message: 'context length exceeded' })).toContain('model limit');
    expect(whitelabelProviderError({ message: 'fetch failed: ECONNRESET' })).toContain('server error or network timeout');
  });

  it('surfaces the Codex usage-limit reset time', () => {
    const out = whitelabelProviderError({
      message: 'The usage limit has been reached',
      responseBody: '{"error":{"type":"usage_limit_reached","resets_at":1789387519}}',
    });
    expect(out).toContain('Usage limit reached');
    expect(out).toContain('resets');
  });

  it('keeps unknown errors concise (first line, no stack)', () => {
    const out = whitelabelProviderError({ message: 'weird provider quirk\n    at deep stack frame\n    more frames' });
    expect(out).toBe('weird provider quirk');
    expect(out).not.toContain('at ');
  });
});

describe('durable fallback notices', () => {
  it('sendSystemNotice renders a durable system row that survives clearHeartbeat', () => {
    const channel = new CLIChannel();
    channel.sendHeartbeat('thinking…');
    channel.sendSystemNotice('⚠ deepseek: Access token expired or rejected — switching to `openai` and continuing.');
    channel.clearHeartbeat();

    const messages = channel.getTuiState().chatMessages;
    const notice = messages.find((m) => m.content.includes('deepseek: Access token expired'));
    expect(notice).toBeDefined();
    expect(notice!.role).toBe('system');
    expect(notice!.id.startsWith('heartbeat-')).toBe(false); // must render in Mercury Code
    expect(messages.some((m) => m.id.startsWith('heartbeat-'))).toBe(false); // heartbeat cleared
  });

  it('cli: the notice path is wired into the provider failure catch block', () => {
    // The per-failure line names provider + whitelabeled reason + next hop.
    expect(cliSrc).toContain('sendSystemNotice');
    expect(agentCliWiring()).toBe(true);
  });

  it('config: migrates legacy ChatGPT IDs and preserves models newer than the build', async () => {
    const { migrateLegacyChatGPTModel } = await import('../utils/config.js');

    // The exact slug the old catalog produced — rejected by the codex backend.
    const stale = migrateLegacyChatGPTModel({
      providers: { chatgptWeb: { name: 'chatgptWeb', enabled: true, apiKey: '', baseUrl: '', model: 'gpt-5-6-thinking' } },
    } as any);
    expect(stale.providers.chatgptWeb.model).toBe('gpt-5.6-sol');

    for (const model of ['gpt-5.5', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.2-astra', 'future-codex-model']) {
      const current = migrateLegacyChatGPTModel({
        providers: { chatgptWeb: { name: 'chatgptWeb', enabled: true, apiKey: '', baseUrl: '', model } },
      } as any);
      expect(current.providers.chatgptWeb.model).toBe(model);
    }

    // Disabled provider is not migrated.
    const disabled = migrateLegacyChatGPTModel({
      providers: { chatgptWeb: { name: 'chatgptWeb', enabled: false, apiKey: '', baseUrl: '', model: 'gpt-5-6-thinking' } },
    } as any);
    expect(disabled.providers.chatgptWeb.model).toBe('gpt-5-6-thinking');
  });
});

function agentCliWiring(): boolean {
  const agentSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'agent.ts'), 'utf8');
  return agentSrc.includes('sendFallbackNotice(msg, line)')
    && agentSrc.includes('whitelabelProviderError(err)} — switching to')
    && /noticedProviderFailures/.test(agentSrc);
}
