import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from './config.js';

/**
 * Anthropic retired claude-sonnet-4-20250514 on 2026-06-15
 * (https://platform.claude.com/docs/en/about-claude/model-deprecations), so a default that
 * still names it fails every request with not_found_error.
 */
const RETIRED = ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'];
const saved = process.env.ANTHROPIC_MODEL;

afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_MODEL;
  else process.env.ANTHROPIC_MODEL = saved;
});

describe('the Anthropic provider default', () => {
  it('names a model Anthropic still serves when ANTHROPIC_MODEL is unset', () => {
    delete process.env.ANTHROPIC_MODEL;
    expect(RETIRED).not.toContain(getDefaultConfig().providers.anthropic.model);
  });

  it('still yields to ANTHROPIC_MODEL', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-5-5';
    expect(getDefaultConfig().providers.anthropic.model).toBe('claude-opus-5-5');
  });
});
