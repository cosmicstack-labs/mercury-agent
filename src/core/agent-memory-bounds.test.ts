import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = (p: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), p), 'utf8');

describe('agent memory bounds', () => {
  it('disables AI SDK raw request/response body retention in streamText and generateText', () => {
    const agent = src('../core/agent.ts');
    // streamText include type only supports requestBody; generateText supports both.
    expect(agent.split('experimental_include: { requestBody: false }').length - 1).toBeGreaterThanOrEqual(1);
    expect(agent.split('experimental_include: { requestBody: false, responseBody: false }').length - 1).toBeGreaterThanOrEqual(1);
  });

  it('disables raw body retention in the sub-agent loop too', () => {
    const subAgent = src('../core/sub-agent.ts');
    expect(subAgent).toContain('experimental_include: { requestBody: false, responseBody: false }');
  });

  it('caps read_file tool results at 64KB with a truncation notice', () => {
    const readTool = src('../capabilities/filesystem/read-file.ts');
    expect(readTool).toContain('MAX_RESULT_CHARS = 64 * 1024');
    expect(readTool).toContain('File truncated');
  });

  it('caps run_command echoed output at 64KB with a truncation notice', () => {
    const runTool = src('../capabilities/shell/run-command.ts');
    expect(runTool).toContain('MAX_OUTPUT_CHARS = 64 * 1024');
    expect(runTool).toContain('Output truncated');
  });

  it('checks memory at every agent step boundary (event-loop independent)', () => {
    const agent = src('../core/agent.ts');
    expect(agent).toContain('memoryGovernor(`stream-step-');
    expect(agent).toContain('memoryGovernor(`gen-step-');
    expect(agent).toContain("from './memory-governor.js'");
  });

  it('does not retry a provider attempt stopped for memory pressure', () => {
    const agent = src('../core/agent.ts');
    expect(agent).toContain('memoryPressureStop = true');
    expect(agent).toContain('memory was growing toward the process limit');
  });

  it('bounds the sub-agent loop: step checkpoints, conversation budget, concurrency cap', () => {
    const subAgent = src('../core/sub-agent.ts');
    expect(subAgent).toContain('enforceConversationBudget()');
    expect(subAgent).toContain('memoryGovernorVerdict(process.memoryUsage().heapUsed, governorThresholds)');
    const resourceManager = src('../core/resource-manager.ts');
    expect(resourceManager).toContain('MAX_CONCURRENT_SUB_AGENTS = 3');
  });

  it('bounds Ink Static output and the streaming-tail projection', () => {
    const app = src('../ui/App.tsx');
    expect(app).toContain('MAX_STATIC_MESSAGES = 100');
    // The tail budget is still bounded (32KB slice through the markdown
    // pipeline, hard 48-row ceiling) — "full preview" never means O(buffer).
    expect(app).toContain('STREAM_TAIL_CHARS = 32 * 1024');
    expect(app).toContain('STREAM_TAIL_MAX_LINES = 48');
    expect(app).toContain('!m.streaming &&');
    const channel = src('../channels/cli.ts');
    // Render notifications must leave the timer phase runnable (no microtask
    // batching, which starves the memory guard under render pressure).
    expect(channel).toContain('setImmediate(() => {');
    expect(channel).not.toContain('queueMicrotask(() => {');
  });
});