import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from './registry.js';

// Member-level chat senders (e.g. approved Telegram members) must not be able
// to reach `install_skill`, which is admin-only and is the escalation path from
// chat access to local command execution.
describe('CapabilityRegistry.getTools sender role gating', () => {
  it('hides install_skill from members but not from admins or roleless senders', () => {
    const registry = new CapabilityRegistry({} as any);
    registry.registerAll();

    // Baseline: no role information (CLI / internal) keeps every tool.
    registry.permissions.setCurrentSenderRole(undefined);
    expect(registry.getTools().install_skill).toBeDefined();

    // Admins keep install_skill.
    registry.permissions.setCurrentSenderRole('admin');
    expect(registry.getTools().install_skill).toBeDefined();

    // Members lose it, while the rest of the tool surface is untouched.
    const admin = registry.getTools();
    registry.permissions.setCurrentSenderRole('member');
    const member = registry.getTools();
    expect(member.install_skill).toBeUndefined();
    expect(Object.keys(member).length).toBe(Object.keys(admin).length - 1);
    expect(member.use_skill).toBeDefined();
  });
});
