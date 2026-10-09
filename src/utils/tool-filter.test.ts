import { describe, expect, it } from 'vitest';
import { filterToolsByAllowlist, resolveChildTools, childMayUse, ORCHESTRATION_TOOLS } from './tool-filter.js';

const tools = {
  read_file: 1,
  write_file: 2,
  list_agents: 3,
  stop_agent: 4,
  delegate_task: 5,
};

describe('filterToolsByAllowlist', () => {
  it('returns every tool when no allowlist is given', () => {
    expect(filterToolsByAllowlist(tools)).toEqual(tools);
    expect(filterToolsByAllowlist(tools, [])).toEqual(tools);
  });

  it('keeps only the allowed tools', () => {
    expect(filterToolsByAllowlist(tools, ['read_file'])).toEqual({ read_file: 1 });
    expect(filterToolsByAllowlist(tools, ['read_file', 'write_file'])).toEqual({ read_file: 1, write_file: 2 });
  });

  it('drops orchestration tools that are not allowlisted', () => {
    const filtered = filterToolsByAllowlist(tools, ['read_file']);
    expect(filtered).not.toHaveProperty('list_agents');
    expect(filtered).not.toHaveProperty('stop_agent');
  });

  it('ignores allowlist entries that match no tool', () => {
    expect(filterToolsByAllowlist(tools, ['read_file', 'does_not_exist'])).toEqual({ read_file: 1 });
  });
});

// #74: a child spawned WITHOUT an allowlist used to inherit stop_agent and
// could halt its siblings. Orchestration tools are opt-in for children.
describe('resolveChildTools (sub-agent default tool set)', () => {
  it('strips delegate_task, list_agents and stop_agent when no allowlist is given', () => {
    expect(resolveChildTools(tools)).toEqual({ read_file: 1, write_file: 2 });
    expect(resolveChildTools(tools, [])).toEqual({ read_file: 1, write_file: 2 });
  });

  it('keeps an orchestration tool only when the allowlist names it', () => {
    expect(resolveChildTools(tools, ['read_file', 'stop_agent'])).toEqual({ read_file: 1, stop_agent: 4 });
    expect(resolveChildTools(tools, ['list_agents'])).toEqual({ list_agents: 3 });
  });

  it('still applies the allowlist to ordinary tools', () => {
    expect(resolveChildTools(tools, ['write_file'])).toEqual({ write_file: 2 });
  });

  it('childMayUse is true only for an explicitly granted orchestration tool', () => {
    for (const name of ORCHESTRATION_TOOLS) {
      expect(childMayUse(name)).toBe(false);
      expect(childMayUse(name, [])).toBe(false);
      expect(childMayUse(name, ['read_file'])).toBe(false);
      expect(childMayUse(name, [name])).toBe(true);
    }
    expect(childMayUse('read_file', ['read_file'])).toBe(false);
  });
});
