import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CLIChannel } from './cli.js';

const agentSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'agent.ts'), 'utf8');

/**
 * Time-weighted prompts: an unanswered question must be answered FOR the user
 * (default = No) and the visible prompt box must disappear — the request flow
 * is never left blocked on input nobody will give.
 */
describe('choice prompt timeout / dismissal', () => {
  it('resolveChoicePromptWithDefault resolves a pending choice prompt and clears it', async () => {
    const channel = new CLIChannel();
    const pending = channel.presentChoicePrompt('Proceed?', [
      { value: '0', label: 'Yes' },
      { value: '1', label: 'No' },
    ]);
    // The prompt is visible while pending.
    expect(channel.getTuiState().permissionPrompt).not.toBeNull();

    channel.resolveChoicePromptWithDefault('1');

    expect(await pending).toBe('1');
    expect(channel.getTuiState().permissionPrompt).toBeNull();
  });

  it('is a no-op when no prompt is pending', () => {
    const channel = new CLIChannel();
    expect(() => channel.resolveChoicePromptWithDefault('0')).not.toThrow();
    expect(channel.getTuiState().permissionPrompt).toBeNull();
  });

  it('agent: the hand-off prompt continues the work on BOTH answers (non-blocking)', () => {
    // The timeout default index must be the "No" choice.
    expect(agentSrc).toMatch(/MERCURY_CODE_HANDOFF_TIMEOUT_MS,\s*\n\s*1, \/\/ time-weighted default: No/);
    // Yes → Mercury Code + continue; No → normal chat. Either way the
    // original message is queued and processed (never dropped, never blocked).
    expect(agentSrc).toContain('promptMercuryCodeHandoff');
    expect(agentSrc).toMatch(/promptMercuryCodeHandoff\(channel: CLIChannel[\s\S]*?this\.queueMessage\(msg, workKey\);\s*\n\s*this\.processQueue\(\);/s);
  });

  it('agent: the choice is remembered PER SESSION and every auto-switch explains itself', () => {
    // Preference keyed by the canonical session id → a new session asks again.
    expect(agentSrc).toMatch(/getOrCreateBound\(msg\.channelType, 'current'[\s\S]*?\.id;\s*\n\s*const remembered = /s);
    expect(agentSrc).toContain('mercuryCodeHandoffPreferences');
    // Remembered "No" → never asks this session.
    expect(agentSrc).toMatch(/remembered === 'chat'[\s\S]*?this\.queueMessage\(msg, workKey\);\s*\n\s*this\.processQueue\(\);/s);
    // Remembered "Yes" → auto-switch WITH the reason.
    expect(agentSrc).toMatch(/remembered === 'code'[\s\S]*?you chose it for coding tasks earlier this session/s);
    // Timeout is NOT a choice — nothing remembered when nobody answers.
    expect(agentSrc).toContain('not remembered — nobody answered');
  });

  it('agent: the RESEARCH prompt also has a time-weighted default (never blocks forever)', () => {
    // The research prompt historically used a bare presentChoice with NO
    // timeout — an unanswered question held the chat message indefinitely.
    // It must use the same time-weighted contract, defaulting to Quick answer.
    expect(agentSrc).toMatch(/promptResearchMode[\s\S]*?this\.presentChoiceWithTimeout\(/s);
    expect(agentSrc).toMatch(/MERCURY_CODE_HANDOFF_TIMEOUT_MS,\s*\n\s*1, \/\/ unanswered = Quick answer/);
  });

  it('enterMercuryCode tears down a stranded bot chat (no parked sends afterwards)', async () => {
    const channel = new CLIChannel();
    channel.enterBotChat('researcher', 'Researcher');
    expect(channel.getActiveBotChat()).not.toBeNull();
    // While a bot chat is open, main-agent sends park into the HIDDEN main
    // transcript. After entering Mercury Code they must land visibly again.
    const tmpDir = mkdtempSync(join(tmpdir(), 'mercury-code-entry-'));
    try {
      const entered = channel.enterMercuryCode(tmpDir, 'test');
      expect(entered.ok).toBe(true);
      expect(channel.getActiveBotChat()).toBeNull();
      await channel.send('visible reply');
      const messages = channel.getTuiState().chatMessages;
      expect(messages.some(m => m.role === 'agent' && m.content === 'visible reply')).toBe(true);
    } finally {
      // enterMercuryCode kicks off an async `git` read with cwd=tmpDir; on
      // Windows the directory stays locked until that child exits.
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});