import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdatePlanTool } from './update-plan.js';
import { CLIChannel } from '../../channels/cli.js';

describe('update_plan tool', () => {
  it('summarizes the checklist on execute', async () => {
    const tool = createUpdatePlanTool();
    const result = await (tool.execute as any)({
      steps: [
        { label: 'Create color.ts', status: 'done' },
        { label: 'Build storage.ts', status: 'active' },
        { label: 'Wire the UI', status: 'pending' },
      ],
    });
    expect(result).toContain('3 steps');
    expect(result).toContain('1 done');
    expect(result).toContain('storage.ts');
  });
});

describe('CLIChannel.setPlanProgress normalization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores a valid checklist', () => {
    const channel = new CLIChannel();
    channel.setPlanProgress([
      { label: 'Create color.ts', status: 'done' },
      { label: 'Build storage.ts', status: 'active' },
      { label: 'Wire the UI', status: 'pending' },
    ]);
    const state = channel.getTuiState().planProgress!;
    expect(state).toHaveLength(3);
    expect(state[0].status).toBe('done');
    expect(state[1].status).toBe('active');
    expect(state[2].status).toBe('pending');
  });

  it('collapses multiple active steps to one', () => {
    const channel = new CLIChannel();
    channel.setPlanProgress([
      { label: 'a', status: 'active' },
      { label: 'b', status: 'active' },
      { label: 'c', status: 'done' },
    ]);
    const state = channel.getTuiState().planProgress!;
    expect(state.filter((s) => s.status === 'active')).toHaveLength(1);
    expect(state.find((s) => s.label === 'a')?.status).toBe('active');
    expect(state.find((s) => s.label === 'b')?.status).toBe('pending');
  });

  it('drops malformed entries and dedupes labels', () => {
    const channel = new CLIChannel();
    channel.setPlanProgress([
      { label: 'step', status: 'done' },
      { label: 'step', status: 'done' },
      { label: '', status: 'done' },
      { label: 'bad status', status: 'weird' },
      'garbage',
      null,
    ]);
    expect(channel.getTuiState().planProgress!).toHaveLength(1);
  });

  it('ignores non-array input entirely', () => {
    const channel = new CLIChannel();
    channel.setPlanProgress({ steps: 'garbage' });
    channel.setPlanProgress(null);
    channel.setPlanProgress('nope');
    expect(channel.getTuiState().planProgress).toBeNull();
  });
});