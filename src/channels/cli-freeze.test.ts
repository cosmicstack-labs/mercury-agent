import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIChannel } from './cli.js';

/** Notifications flush via setImmediate (check phase) — same pattern as cli-rerender.test.ts. */
const flushRenders = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Scroll-lock (freeze) regression guards. While frozen the TUI must write
 * NOTHING (the user is reading/copying in native scrollback) while the
 * agent's state keeps merging underneath — and a message finalized during
 * the freeze must print exactly once on resume. The freeze gate lives in
 * rerender(): state merges always, only the React notification is
 * suppressed — <Static> never commits mid-freeze (committing without
 * printing would lose finalized messages, since Static marks keys
 * committed at the React level).
 */
describe('CLIChannel TUI freeze (scroll lock)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    const gate = (globalThis as any).__mercuryFrameGate;
    if (gate) { gate.frozen = false; gate.armed = false; gate.marker = ''; }
  });

  it('freezing stops frame notifications but keeps merging state', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    let notifications = 0;
    channel.subscribeToTuiState(() => { notifications++; });

    channel.setTuiFrozen(true);
    // The hint frame is allowed through exactly once during the armed window.
    await flushRenders();
    const notificationsAfterHint = notifications;
    expect(channel.getTuiState().tuiFrozen).toBe(true);
    // The write gate closes after ink's 32ms onRender throttle (90ms timer).
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Stream continues underneath: state advances, no frame goes out.
    channel.setLiveActivity('Streaming response', 'generating answer');
    (channel as any).update({ chatMessages: [...channel.getTuiState().chatMessages] });
    await flushRenders();
    await flushRenders();
    expect(notifications).toBe(notificationsAfterHint);
    expect(channel.getTuiState().liveActivity?.phase).toBe('Streaming response');
  });

  it('resume emits exactly one notification with the merged state', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    let notifications = 0;
    channel.subscribeToTuiState(() => { notifications++; });

    channel.setTuiFrozen(true);
    await flushRenders();
    await new Promise((resolve) => setTimeout(resolve, 120)); // gate fully closed
    const afterHint = notifications;
    (channel as any).update({ toolSteps: [{ id: 's1', label: 'read_file', status: 'done' } as any] });
    await flushRenders();
    expect(notifications).toBe(afterHint); // merged silently

    channel.setTuiFrozen(false);
    await flushRenders();
    expect(notifications).toBe(afterHint + 1);
    expect(channel.getTuiState().toolSteps).toHaveLength(1);
    expect(channel.getTuiState().tuiFrozen).toBe(false);
  });

  it('a permission prompt arriving while frozen auto-resumes', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    channel.setTuiFrozen(true);
    // Wait out the armed hint window (90ms) so the gate is fully closed.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flushRenders();

    const prompt = { type: 'choice' as const, message: 'Allow?', options: [], resolve: () => {} };
    (channel as any).update({ permissionPrompt: prompt as any });
    await flushRenders();
    // The gate must be open: the prompt frame went out (listener notified).
    expect(channel.getTuiState().tuiFrozen).toBe(false);
    expect(channel.getTuiState().permissionPrompt).toBeTruthy();
  });

  it('freeze while a stream finishes keeps the finalized message for the resume frame', async () => {
    // Simulates stream() finalizing during a freeze: the message lands in
    // state (streaming: false) but React never renders it — on resume, the
    // single frame carries it and <Static> commits it exactly once.
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    channel.setTuiFrozen(true);
    await flushRenders();
    (channel as any).update({
      chatMessages: [...channel.getTuiState().chatMessages, { id: 'm1', role: 'agent', content: 'final text', timestamp: 1 }],
    });
    await flushRenders();
    await flushRenders();
    expect(channel.getTuiState().chatMessages.some((m) => m.id === 'm1')).toBe(true);

    channel.setTuiFrozen(false);
    await flushRenders();
    expect(channel.getTuiState().tuiFrozen).toBe(false);
  });

  it('teardown clears the freeze state and the ink gate', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const channel = new CLIChannel();
    (channel as any).inkInstance = { unmount: () => {}, rerender: () => {} };
    (globalThis as any).__mercuryFrameGate = { frozen: true, armed: false, marker: '⏸ frozen' };
    channel.setTuiFrozen(true);
    await flushRenders();
    (channel as any).teardownTui();
    expect((globalThis as any).__mercuryFrameGate.frozen).toBe(false);
    expect((globalThis as any).__mercuryFrameGate.marker).toBe('');
  });
});