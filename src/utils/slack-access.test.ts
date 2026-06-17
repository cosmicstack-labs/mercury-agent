import { describe, expect, it } from 'vitest';
import {
  addSlackPendingRequest,
  approveSlackPendingRequest,
  clearSlackAccess,
  getDefaultConfig,
  getSlackAccessSummary,
  migrateLegacySlackAccess,
  promoteSlackUserToAdmin,
  demoteSlackAdmin,
  rejectSlackPendingRequest,
  removeSlackUser,
} from './config.js';

describe('slack access config helpers', () => {
  it('migrates legacy Slack access with missing arrays', () => {
    const config = getDefaultConfig();
    config.channels.slack.admins = undefined as any;
    config.channels.slack.members = undefined as any;
    config.channels.slack.pending = undefined as any;

    migrateLegacySlackAccess(config);

    expect(config.channels.slack.admins).toEqual([]);
    expect(config.channels.slack.members).toEqual([]);
    expect(config.channels.slack.pending).toEqual([]);
  });

  it('approves pending requests as admin or member and reports summary counts', () => {
    const config = getDefaultConfig();
    addSlackPendingRequest(config, { userId: 'U111', userName: 'alpha', displayName: 'Alpha' });
    addSlackPendingRequest(config, { userId: 'U222', userName: 'beta' });

    const admin = approveSlackPendingRequest(config, 'U111', 'admin');
    const member = approveSlackPendingRequest(config, 'U222', 'member');

    expect(admin?.userId).toBe('U111');
    expect(admin?.role).toBe('admin');
    expect(member?.userId).toBe('U222');
    expect(member?.role).toBe('member');
    expect(getSlackAccessSummary(config)).toBe('1 admin, 1 member, 0 pending');
  });

  it('supports reject, remove, promote, and demote flows', () => {
    const config = getDefaultConfig();
    addSlackPendingRequest(config, { userId: 'U111', userName: 'alpha' });
    addSlackPendingRequest(config, { userId: 'U222', userName: 'beta' });
    addSlackPendingRequest(config, { userId: 'U333', userName: 'gamma' });

    approveSlackPendingRequest(config, 'U111', 'admin');
    approveSlackPendingRequest(config, 'U222', 'member');
    expect(rejectSlackPendingRequest(config, 'U333')?.userId).toBe('U333');

    expect(promoteSlackUserToAdmin(config, 'U222')?.userId).toBe('U222');
    expect(demoteSlackAdmin(config, 'U111')?.userId).toBe('U111');
    expect(removeSlackUser(config, 'U111')?.userId).toBe('U111');

    expect(config.channels.slack.admins).toHaveLength(1);
    expect(config.channels.slack.members).toHaveLength(0);
    expect(config.channels.slack.pending).toHaveLength(0);
  });

  it('does not demote the last admin', () => {
    const config = getDefaultConfig();
    addSlackPendingRequest(config, { userId: 'U111', userName: 'solo' });
    approveSlackPendingRequest(config, 'U111', 'admin');

    expect(demoteSlackAdmin(config, 'U111')).toBeNull();
  });

  it('clears all Slack access state', () => {
    const config = getDefaultConfig();
    addSlackPendingRequest(config, { userId: 'U111', userName: 'alpha' });
    approveSlackPendingRequest(config, 'U111', 'admin');

    clearSlackAccess(config);

    expect(config.channels.slack.admins).toEqual([]);
    expect(config.channels.slack.members).toEqual([]);
    expect(config.channels.slack.pending).toEqual([]);
  });
});