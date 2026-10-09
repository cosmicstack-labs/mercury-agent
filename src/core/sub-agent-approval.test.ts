import { describe, expect, it, afterAll, vi } from 'vitest';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult, LanguageModelV3Usage } from '@ai-sdk/provider';

// permissions.yaml and the task board live under MERCURY_HOME, resolved at
// import time — point it at a scratch directory before anything loads.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-subagent-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const { SubAgent } = await import('./sub-agent.js');
const { CapabilityRegistry } = await import('../capabilities/registry.js');
const { FileLockManager } = await import('./file-lock.js');
const { TaskBoard } = await import('./task-board.js');

const usage: LanguageModelV3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** First turn: call run_command with `command`; second turn: say done. */
function commandThenDone(command: string) {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      calls++;
      if (calls === 1) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'run_command', input: JSON.stringify({ command }) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] };
    },
  });
}

function makeChild(opts: { model: MockLanguageModelV3; ask?: (prompt: string) => Promise<string>; channelType?: string; allowedTools?: string[] }) {
  const registry = new CapabilityRegistry({} as any);
  registry.registerAll();
  const manifest = registry.permissions.getManifest();
  manifest.capabilities.shell.enabled = true;
  manifest.capabilities.shell.cwdOnly = false;
  // The parent's state: Ask Me mode, with the parent's approval handler.
  registry.permissions.setAutoApproveAll(false);
  if (opts.ask) registry.permissions.onAsk(opts.ask);
  registry.setChannelContext('cli', 'cli');

  const taskBoard = new TaskBoard();
  const agent = new SubAgent(
    {
      id: 'a1',
      task: 'Do the thing',
      allowedTools: opts.allowedTools,
      sourceChannelId: opts.channelType ?? 'cli',
      sourceChannelType: opts.channelType ?? 'cli',
    },
    {
      agentConfig: { identity: { name: 'Mercury', owner: 'test' } } as any,
      providers: { getDefault: () => ({ name: 'mock', getModel: () => 'mock-model', getModelInstance: () => opts.model }) } as any,
      identity: { getSystemPrompt: () => 'You are a test agent.' } as any,
      shortTerm: {} as any,
      longTerm: {} as any,
      episodic: { record() {} } as any,
      userMemory: null,
      capabilities: registry,
      tokenBudget: { getStatusText: () => '', getUsagePercentage: () => 0, recordUsage() {}, getRemaining: () => 1_000_000 } as any,
      fileLockManager: new FileLockManager(),
      taskBoard,
    },
  );
  taskBoard.create({ agentId: 'a1', task: 'Do the thing', status: 'pending', priority: 'normal', startedAt: Date.now(), filesLocked: [] });
  return { agent, registry };
}

function toolResultText(model: MockLanguageModelV3): string {
  // The second provider call carries the first call's tool result.
  return JSON.stringify(model.doGenerateCalls[1]?.prompt ?? []);
}

describe('delegated sub-agent shell commands go through the parent\'s approval flow (#75, #99)', () => {
  let scratch: string;
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('a dangerous command from a child reaches the parent\'s approval handler and is refused on "no"', async () => {
    const model = commandThenDone('rm -rf build');
    const ask = vi.fn().mockResolvedValue('no');
    const { agent } = makeChild({ model, ask });

    const result = await agent.run();

    expect(result.status).toBe('completed');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith('Run command: rm -rf build');
    expect(toolResultText(model)).toContain('User denied: rm -rf build');
  });

  it('the command runs only after the parent\'s handler says yes (no auto-approval)', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'mercury-subagent-cmd-'));
    const marker = join(scratch, 'ran.txt');
    const model = commandThenDone(`touch ${marker}`);
    const ask = vi.fn().mockResolvedValue('yes');
    const { agent } = makeChild({ model, ask });

    await agent.run();

    expect(ask).toHaveBeenCalledWith(`Run command: touch ${marker}`);
    expect(existsSync(marker)).toBe(true);
  });

  it('without any approval handler the command is denied, not auto-approved', async () => {
    const model = commandThenDone('rm -rf build');
    const { agent } = makeChild({ model });

    await agent.run();

    expect(toolResultText(model)).toMatch(/requires approval|Permission denied|denied/);
    expect(toolResultText(model)).not.toContain('(no output)');
  });

  it('a child on the internal channel still cannot run an unapproved command', async () => {
    const model = commandThenDone('rm -rf build');
    const ask = vi.fn().mockResolvedValue('yes');
    const { agent } = makeChild({ model, ask, channelType: 'internal' });

    await agent.run();

    // No prompt is possible on the internal channel, so the command is refused.
    expect(ask).not.toHaveBeenCalled();
    expect(toolResultText(model)).toMatch(/requires approval/);
  });

  it.todo('P2.2: a child\'s tool call that lands inside a concurrent internal-channel turn (setAutoApproveAll window in agent.ts) must still prompt — needs the immutable per-agent permission context');
});

describe('sub-agent tool surface and prompt (#74)', () => {
  it('does not receive delegate_task/list_agents/stop_agent unless the parent grants them', () => {
    const model = commandThenDone('true');
    const { agent, registry } = makeChild({ model });
    // Pretend the shared registry exposes the orchestration tools, as it does
    // for the main agent once a supervisor is attached.
    const tools = registry.getTools();
    (tools as any).stop_agent = { description: 'root-bound' };
    (tools as any).list_agents = { description: 'root-bound' };
    (tools as any).delegate_task = { description: 'root-bound' };
    vi.spyOn(registry, 'getTools').mockReturnValue(tools);

    const names = agent.getToolNames();
    expect(names).toContain('run_command');
    expect(names).not.toContain('stop_agent');
    expect(names).not.toContain('list_agents');
    expect(names).not.toContain('delegate_task');
  });

  it('the system prompt no longer claims full permissions and describes the real scopes', () => {
    const model = commandThenDone('true');
    const { agent, registry } = makeChild({ model });
    registry.permissions.getManifest().capabilities.filesystem.scopes = [
      { path: '/work/project', read: true, write: true },
      { path: '/work/docs', read: true, write: false },
    ];
    const prompt: string = (agent as any).buildSystemPrompt();
    expect(prompt).not.toMatch(/full permissions/i);
    expect(prompt).toContain('same permissions as the agent that delegated you');
    expect(prompt).toContain('Writable scopes: /work/project');
    expect(prompt).toContain('Read-only scopes: /work/docs');
    expect(prompt).toMatch(/go to the user for approval/);
  });
});
