import { describe, expect, it } from 'vitest';
import { toolResultValue } from './agent.js';

describe('toolResultValue', () => {
  it('reads AI SDK v6 `output`, falls back to `result`, else returns the value', () => {
    expect(toolResultValue({ type: 'tool-result', toolName: 'run_command', output: 'Command exited with code 1' })).toBe('Command exited with code 1');
    expect(toolResultValue({ result: 'legacy' })).toBe('legacy');
    expect(toolResultValue('plain')).toBe('plain');
    expect(toolResultValue(undefined)).toBeUndefined();
  });
});
