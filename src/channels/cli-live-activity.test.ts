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
describe('CLIChannel Mercury Code tool transcript', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function* chunks(parts: Array<string | (() => Promise<void>)>): AsyncIterable<string> {
    for (const part of parts) {
      if (typeof part === 'string') yield part;
      else await part();
    }
  }

  it('interleaves streamed text and finished tool blocks in order', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    channel.enterMercuryCode(process.cwd(), 'test');
    const before = channel.getTuiState().chatMessages.length;

    const full = await channel.stream(chunks([
      'Let me read the file.',
      async () => {
        // The SDK fires tool start/finish between the model's steps.
        await channel.sendToolEvent('read_file', { path: 'a.ts' }, 'call-1');
        channel.completeToolEvent('read_file', 'x\ny', false, 10, 'call-1');
      },
      '\n\n',
      'Done reading.',
    ]));

    const added = channel.getTuiState().chatMessages.slice(before);
    expect(added.map((m) => m.tool ? `tool:${m.tool.title}` : `${m.role}:${m.content}`)).toEqual([
      'agent:Let me read the file.',
      'tool:Read',
      'agent:Done reading.',
    ]);
    expect(added.every((m) => !m.streaming)).toBe(true);
    // The caller still receives the whole reply for the session store.
    expect(full).toBe('Let me read the file.\n\nDone reading.');
  });

  it('completes parallel calls of the same tool by callId', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    channel.enterMercuryCode(process.cwd(), 'test');
    await channel.sendToolEvent('read_file', { path: 'first.ts' }, 'c1');
    await channel.sendToolEvent('read_file', { path: 'second.ts' }, 'c2');
    channel.completeToolEvent('read_file', 'one line', false, 5, 'c2');
    const blocks = channel.getTuiState().chatMessages.filter((m) => m.tool);
    expect(blocks.map((m) => m.tool!.target)).toEqual(['second.ts']);
    expect(channel.getTuiState().toolSteps.find((s) => s.callId === 'c1')?.status).toBe('running');
  });

  it('does not add tool blocks or split replies outside Mercury Code', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    await channel.stream(chunks([
      'Before.',
      async () => {
        await channel.sendToolEvent('read_file', { path: 'a.ts' }, 'call-1');
        channel.completeToolEvent('read_file', 'x', false, 10, 'call-1');
      },
      ' After.',
    ]));
    const messages = channel.getTuiState().chatMessages;
    expect(messages.some((m) => m.tool)).toBe(false);
    expect(messages.filter((m) => m.role === 'agent').map((m) => m.content)).toEqual(['Before. After.']);
  });
});

describe('CLIChannel tool output expansion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ctrl+o appends the full output of collapsed blocks, newest first', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    channel.enterMercuryCode(process.cwd(), 'test');
    const lines = (tag: string) => Array.from({ length: 30 }, (_, i) => `${tag} ${i}`).join('\n');
    await channel.sendToolEvent('run_command', { command: 'first' }, 'c1');
    channel.completeToolEvent('run_command', lines('a'), false, 5, 'c1');
    await channel.sendToolEvent('run_command', { command: 'small' }, 'c2');
    channel.completeToolEvent('run_command', 'tiny', false, 5, 'c2');
    await channel.sendToolEvent('run_command', { command: 'second' }, 'c3');
    channel.completeToolEvent('run_command', lines('b'), false, 5, 'c3');

    const lastTool = () => channel.getTuiState().chatMessages.filter((m) => m.tool).at(-1)!.tool!;
    channel.expandLastToolOutput();
    expect(lastTool()).toMatchObject({ target: 'second', summary: 'Full output · 30 lines' });
    expect(lastTool().body!.lines).toHaveLength(30);
    channel.expandLastToolOutput();
    expect(lastTool().target).toBe('first');
    // Nothing left: a notice, not a block.
    const toolCount = channel.getTuiState().chatMessages.filter((m) => m.tool).length;
    channel.expandLastToolOutput();
    expect(channel.getTuiState().chatMessages.filter((m) => m.tool)).toHaveLength(toolCount);
    expect(channel.getTuiState().chatMessages.at(-1)?.content).toContain('Nothing to expand');
  });
});
