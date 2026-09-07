import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { CLIChannel } from './cli.js';

const uiDir = dirname(fileURLToPath(import.meta.url));

describe('Mercury Code exit paths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exitMercuryCode tears down Mercury Code state and returns to chat', () => {
    const channel = new CLIChannel();
    const dir = mkdtempSync(join(tmpdir(), 'mercury-code-exit-'));
    try {
      const entered = channel.enterMercuryCode(dir, 'test');
      expect(entered.ok).toBe(true);
      expect(channel.getTuiState().mode).toBe('mercury-code');
      expect(channel.getTuiState().mercuryCode).not.toBeNull();
      // AUTO is the Mercury Code default: plan-and-build in one flow.
      expect(channel.getTuiState().programmingMode).toBe('auto');

      channel.exitMercuryCode();

      const state = channel.getTuiState();
      expect(state.mode).toBe('chat');
      expect(state.mercuryCode).toBeNull();
      expect(state.programmingMode).toBe('off');
      expect(state.exitEscArmed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects entering Mercury Code in a nonexistent directory', () => {
    const channel = new CLIChannel();
    const result = channel.enterMercuryCode('/nonexistent/mercury-test-dir', 'test');
    expect(result.ok).toBe(false);
    expect(channel.getTuiState().mode).not.toBe('mercury-code');
  });

  it('/code entry keeps agent-side mode in AUTO (never reverts TUI to plan)', () => {
    // Regression: after enterMercuryCode set the TUI to AUTO, the agent
    // pushed its stale 'plan' back via setProgrammingStatus — the status bar
    // showed PLAN even though AUTO was the default.
    const agent = readFileSync(join(uiDir, '..', 'core', 'agent.ts'), 'utf8');
    const entryIdx = agent.indexOf('cliChannel.enterMercuryCode');
    expect(entryIdx).toBeGreaterThan(-1);
    const syncBlock = agent.slice(entryIdx, entryIdx + 600);
    expect(syncBlock).toContain('this.programmingMode.setAuto()');
    expect(syncBlock).not.toContain('this.programmingMode.setPlan()');
  });

  it('routes /code chat and /code back as instant exits in the TUI input handler', () => {
    // Source guard: the input handler is a mountTUI closure, so assert the
    // routing exists and both aliases tear down via exitMercuryCode (the
    // half-exit regression — a bare mode switch leaving mercuryCode set —
    // is what this guards against).
    const source = readFileSync(join(uiDir, 'cli.ts'), 'utf8');
    expect(source).toContain("'/code chat'");
    expect(source).toContain("'/code back'");
    const chatRouting = /trimmed === '\/chat'[\s\S]{0,400}?mercury-code'\) this\.exitMercuryCode\(\)/.exec(source);
    expect(chatRouting, '/chat must call exitMercuryCode in mercury-code mode').not.toBeNull();
  });
});