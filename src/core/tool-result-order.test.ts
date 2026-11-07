import { describe, expect, it } from 'vitest';
import { resultFor } from './agent.js';

describe('tool results', () => {
  it('pair with their call by id, not by position', () => {
    const calls = [{ toolCallId: 'a', toolName: 'web_search' }, { toolCallId: 'b', toolName: 'fetch_url' }];
    const results = [{ toolCallId: 'b', output: 'page' }, { toolCallId: 'a', output: 'search results' }];
    expect(resultFor(calls, results, 0)).toEqual({ toolCallId: 'a', output: 'search results' });
    expect(resultFor(calls, results, 1)).toEqual({ toolCallId: 'b', output: 'page' });
  });

  it('fall back to position without ids', () => {
    expect(resultFor([{ toolName: 'x' }], ['r0'], 0)).toBe('r0');
    expect(resultFor([{ toolCallId: 'z' }], [{ toolCallId: 'y' }], 0)).toEqual({ toolCallId: 'y' });
    expect(resultFor([{}], undefined, 0)).toBeUndefined();
  });
});
