import { describe, it, expect } from 'vitest';
import { CapabilityRegistry } from './registry.js';

/**
 * Security boundary: a non-admin group member ("guest") must never reach the
 * tools that operate the owner's machine or accounts. getGuestTools() is a
 * deny-by-default allowlist; these tests lock that contract so a future tool
 * addition (or a broken filter) can't silently hand guests shell/filesystem
 * access.
 */
describe('CapabilityRegistry.getGuestTools', () => {
  function buildRegistry(): CapabilityRegistry {
    const registry = new CapabilityRegistry();
    registry.registerAll();
    return registry;
  }

  // Tools that must NEVER be available to a guest, regardless of manifest.
  const FORBIDDEN_FOR_GUEST = [
    'run_command', 'cd', 'approve_command',
    'read_file', 'write_file', 'create_file', 'edit_file', 'delete_file',
    'list_dir', 'send_file', 'approve_scope',
    'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit', 'git_push',
    'create_pr', 'review_pr', 'create_issue', 'list_issues', 'github_api',
    'delegate_task', 'list_agents', 'stop_agent',
    'schedule_task', 'list_scheduled_tasks', 'cancel_scheduled_task',
    'install_skill', 'use_skill',
    'save_memory', 'store_memory',
    'send_message',
  ];

  it('returns only allowlisted tool names', () => {
    const guestTools = buildRegistry().getGuestTools();
    const allowed = new Set(['fetch_url', 'ask_user']);
    for (const name of Object.keys(guestTools)) {
      expect(allowed.has(name)).toBe(true);
    }
  });

  it('never exposes any system, filesystem, shell, git, or memory tool to guests', () => {
    const guestTools = buildRegistry().getGuestTools();
    for (const forbidden of FORBIDDEN_FOR_GUEST) {
      expect(guestTools[forbidden]).toBeUndefined();
    }
  });

  it('guest toolset is a strict subset of the full toolset', () => {
    const registry = buildRegistry();
    const full = registry.getTools();
    const guest = registry.getGuestTools();
    for (const name of Object.keys(guest)) {
      expect(full[name]).toBeDefined();
    }
    expect(Object.keys(guest).length).toBeLessThan(Object.keys(full).length);
  });

  it('still grants guests the safe conversational tools when registered', () => {
    const guestTools = buildRegistry().getGuestTools();
    // fetch_url is always registered, so a guest can still look things up.
    expect(guestTools.fetch_url).toBeDefined();
  });
});
