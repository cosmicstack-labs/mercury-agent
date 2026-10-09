import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { CLIChannel } from './cli.js';

const uiDir = dirname(fileURLToPath(import.meta.url));

describe('Mercury Code exit paths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exitMercuryCode tears down Mercury Code state and returns to chat', async () => {
    const channel = new CLIChannel();
    // Enter on the repo cwd: entering spawns async git reads with the dir as
    // cwd, and Windows keeps a temp dir locked while they run.
    const dir = process.cwd();
    {
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
      // Let the async git header read finish before the test ends.
      await channel.refreshMercuryCodeGit();
    }
  });

  it('rejects entering Mercury Code in a nonexistent directory', () => {
    const channel = new CLIChannel();
    const result = channel.enterMercuryCode('/nonexistent/mercury-test-dir', 'test');
    expect(result.ok).toBe(false);
    expect(channel.getTuiState().mode).not.toBe('mercury-code');
  });

  it('/mc scroll-set is matched before the generic scroll- prefix', () => {
    // Regression: the generic branch parsed 'scroll-set N' as delta 'set N'
    // (NaN) and returned, silently killing the scroll-clamp loop — after a
    // history trim the stored offset exceeded the shrunken transcript
    // forever and the viewport was stuck on the last rows ("can't scroll,
    // only see the code").
    const source = readFileSync(join(uiDir, 'cli.ts'), 'utf8');
    const setIdx = source.indexOf("sub.startsWith('scroll-set ')");
    const genericIdx = source.indexOf("sub.startsWith('scroll ')");
    expect(setIdx).toBeGreaterThan(-1);
    expect(genericIdx).toBeGreaterThan(-1);
    expect(setIdx, 'scroll-set must be parsed before the generic scroll- branch').toBeLessThan(genericIdx);
  });

  it('/code entry keeps agent-side mode in AUTO (never reverts TUI to plan)', () => {
    // Regression: after enterMercuryCode set the TUI to AUTO, the agent
    // pushed its stale 'plan' back via setProgrammingStatus — the status bar
    // showed PLAN even though AUTO was the default.
    // The /code command lives in core/commands/chat-command.ts (P2.1 split),
    // where the agent instance is `agent`.
    const agent = readFileSync(join(uiDir, '..', 'core', 'commands', 'chat-command.ts'), 'utf8');
    const entryIdx = agent.indexOf('cliChannel.enterMercuryCode');
    expect(entryIdx).toBeGreaterThan(-1);
    const syncBlock = agent.slice(entryIdx, entryIdx + 600);
    expect(syncBlock).toContain('agent.programmingMode.setAuto()');
    expect(syncBlock).not.toContain('agent.programmingMode.setPlan()');
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