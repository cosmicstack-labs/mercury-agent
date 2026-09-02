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
});