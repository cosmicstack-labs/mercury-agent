import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIChannel } from './cli.js';

describe('CLIChannel live activity feedback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes phase changes with step counters and elapsed start time', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();

    channel.setLiveActivity('Calling provider', 'mercury-flash');
    const first = channel.getTuiState().liveActivity;
    expect(first).not.toBeNull();
    expect(first?.phase).toBe('Calling provider');
    expect(first?.detail).toBe('mercury-flash');
    expect(first?.stepsDone).toBe(0);
    expect(first?.startedAt).toBeLessThanOrEqual(Date.now());

    // Same phase again: startedAt is stable (no timer reset).
    channel.setLiveActivity('Calling provider', 'mercury-flash');
    const again = channel.getTuiState().liveActivity;
    expect(again?.startedAt).toBe(first?.startedAt);

    // New phase: timer restarts.
    channel.setLiveActivity('Reading file');
    const changed = channel.getTuiState().liveActivity;
    expect(changed?.phase).toBe('Reading file');
    expect(changed?.startedAt).toBeGreaterThanOrEqual(first?.startedAt ?? 0);
  });

  it('counts steps as the generation loop completes them', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    channel.setLiveActivity('Working');
    channel.bumpLiveActivitySteps();
    channel.bumpLiveActivitySteps();
    expect(channel.getTuiState().liveActivity?.stepsDone).toBe(2);
    channel.clearLiveActivity();
    expect(channel.getTuiState().liveActivity).toBeNull();
  });

  it('real-time tool events mark a step running and pair completion by tool', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();

    await channel.sendToolEvent('read_file', { path: '/tmp/x.ts' }, 'call-1');
    let running = channel.getTuiState().toolSteps.filter((s) => s.status === 'running');
    expect(running).toHaveLength(1);
    expect(running[0].callId).toBe('call-1');
    expect(running[0].label).toContain('x.ts');

    channel.completeToolEvent('read_file', 'line1\nline2\nline3', false, 1500);
    const done = channel.getTuiState().toolSteps;
    expect(done).toHaveLength(1);
    expect(done[0].status).toBe('done');
    expect(done[0].elapsed).toBeCloseTo(1.5, 5);
    expect(done[0].result).toContain('3 lines');
  });

  it('clears live activity when a final response arrives', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    channel.setLiveActivity('Streaming response');
    await channel.send('final answer');
    expect(channel.getTuiState().liveActivity).toBeNull();
    expect(channel.getTuiState().isThinking).toBe(false);
  });

  it('turn-end cleanup clears isThinking with the phase — plain-chat spinner must not outlive the turn', () => {
    // Regression: in plain chat the final pushLiveActivity ('Finalizing
    // response') sets isThinking, then no channel.send/sendCompletion
    // follows (response already streamed, no banner for simple turns), and
    // the agent's turn-end finally only called clearLiveActivity() — which
    // cleared the phase but left isThinking true, so the TUI rendered
    // "Processing · 1m 30s / Composing response" forever after the turn
    // was over (agent lifecycle already idle).
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    // What the agent does on the 'Finalizing response' step:
    channel.setLiveActivity('Finalizing response');
    expect(channel.getTuiState().isThinking).toBe(true);
    // What the agent's turn-end finally does:
    channel.clearLiveActivity();
    expect(channel.getTuiState().liveActivity).toBeNull();
    expect(channel.getTuiState().isThinking).toBe(false);
  });
});