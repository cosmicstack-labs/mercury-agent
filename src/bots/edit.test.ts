import { describe, it, expect } from 'vitest';
import { applyBotFieldPatch, EDITABLE_PATHS, type EditResult } from './edit.js';
import type { BotManifest } from './types.js';

function baseManifest(): BotManifest {
  return {
    id: 'researcher',
    name: 'Research',
    enabled: true,
    tools: { allow: [], deny: ['run_command'] },
    memory: { scope: 'own' },
    comms: { canMessage: [] },
    autonomy: { maxSteps: 25, dailyTokenBudget: 100_000 },
  };
}

describe('applyBotFieldPatch (/bots edit)', () => {
  it('edits nested config fields', () => {
    const m = baseManifest();
    expect(applyBotFieldPatch(m, 'name', 'Deep Research').ok).toBe(true);
    expect(m.name).toBe('Deep Research');
    expect(applyBotFieldPatch(m, 'model.provider', 'anthropic').ok).toBe(true);
    expect(m.model?.provider).toBe('anthropic');
    expect(applyBotFieldPatch(m, 'memory.scope', 'shared-read').ok).toBe(true);
    expect(m.memory?.scope).toBe('shared-read');
    expect(applyBotFieldPatch(m, 'autonomy.maxSteps', '40').ok).toBe(true);
    expect(m.autonomy?.maxSteps).toBe(40);
  });

  it('parses comma lists for bot links and tool lists', () => {
    const m = baseManifest();
    applyBotFieldPatch(m, 'comms.canMessage', 'Publisher, SOCIAL');
    expect(m.comms?.canMessage).toEqual(['publisher', 'social']);
    applyBotFieldPatch(m, 'tools.allow', 'fetch_url, read_file');
    expect(m.tools?.allow).toEqual(['fetch_url', 'read_file']);
  });

  it('dailyTokenBudget: numbers set a cap, "none" removes it (unlimited default)', () => {
    const m = baseManifest();
    const capped = applyBotFieldPatch(m, 'autonomy.dailyTokenBudget', '5000000') as Extract<EditResult, { ok: true }>;
    expect(m.autonomy?.dailyTokenBudget).toBe(5000000);
    expect(capped.display).toBe('5,000,000');
    const none = applyBotFieldPatch(m, 'autonomy.dailyTokenBudget', 'none') as Extract<EditResult, { ok: true }>;
    expect(m.autonomy?.dailyTokenBudget).toBeUndefined();
    expect('dailyTokenBudget' in (m.autonomy ?? {})).toBe(false);
    expect(none.display).toContain('unlimited');
  });

  it('rejects unknown fields and invalid values without mutating', () => {
    const m = baseManifest();
    expect(applyBotFieldPatch(m, 'id', 'new-id').ok).toBe(false);
    expect(applyBotFieldPatch(m, 'enabled', 'true').ok).toBe(false);
    expect(applyBotFieldPatch(m, 'autonomy.maxSteps', '0').ok).toBe(false);
    expect(applyBotFieldPatch(m, 'memory.scope', 'everything').ok).toBe(false);
    expect(applyBotFieldPatch(m, 'name', '').ok).toBe(false);
    // Nothing was mutated by the rejected edits
    expect(m.id).toBe('researcher');
    expect(m.memory?.scope).toBe('own');
  });

  it('editable paths exclude identity and enable (dedicated commands exist)', () => {
    expect(EDITABLE_PATHS).not.toContain('id');
    expect(EDITABLE_PATHS).not.toContain('enabled');
  });
});