import { describe, expect, it } from 'vitest';
import { ProgrammingMode } from './programming-mode.js';

describe('ProgrammingMode auto state', () => {
  it('auto is an execute-class mode: full tools, completion guards apply', () => {
    const mode = new ProgrammingMode();
    mode.setAuto();
    expect(mode.getState()).toBe('auto');
    expect(mode.isActive()).toBe(true);
    // The narration/verification/step guards key off isExecute() — auto must
    // be held to the same completion contract as manual execute.
    expect(mode.isExecute()).toBe(true);
    // Auto is NOT plan mode: full tool set, not the read-only plan set.
    expect(mode.isPlan()).toBe(false);
  });

  it('toggle cycles off → auto → plan → execute → off', () => {
    const mode = new ProgrammingMode();
    expect(mode.toggle()).toBe('auto');
    expect(mode.toggle()).toBe('plan');
    expect(mode.toggle()).toBe('execute');
    expect(mode.toggle()).toBe('off');
    expect(mode.toggle()).toBe('auto');
  });

  it('auto prompt mandates acting in the same turn and scope-gated confirmation', () => {
    const mode = new ProgrammingMode();
    mode.setAuto();
    const suffix = mode.getSystemPromptSuffix();
    expect(suffix).toContain('Mode: AUTO');
    // Anti-narration mandate — the "faking it" failure mode.
    expect(suffix).toContain('Act, don\'t announce');
    expect(suffix).toContain('same turn');
    expect(suffix).toContain('ZERO mutating tool calls');
    // Scope gating: small changes proceed without asking; large changes confirm.
    expect(suffix).toContain('implement IMMEDIATELY');
    expect(suffix).toContain('ask_user');
    expect(suffix).toContain('Once confirmed, implement without re-asking');
  });

  it('execute mode shares the same factual-completion contract', () => {
    const mode = new ProgrammingMode();
    mode.setExecute();
    const suffix = mode.getSystemPromptSuffix();
    expect(suffix).toContain('Mode: EXECUTE');
    expect(suffix).toContain('Completion is factual, not narrative');
  });

  it('auto with a stored plan skips re-planning entirely', () => {
    const mode = new ProgrammingMode();
    mode.setAuto();
    mode.storePlan('1. Create index.html\n2. Run tests');
    const suffix = mode.getSystemPromptSuffix();
    expect(suffix).toContain('APPROVED PLAN FROM PLANNING SESSION');
    expect(suffix).toContain('do NOT re-ask for confirmation');
  });

  it('off produces no prompt suffix', () => {
    const mode = new ProgrammingMode();
    expect(mode.getSystemPromptSuffix()).toBe('');
  });
});