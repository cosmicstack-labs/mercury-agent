import { describe, expect, it } from 'vitest';
import {
  addDiscordPendingRequest,
  approveDiscordPendingRequest,
  approveDiscordPendingRequestByPairingCode,
  clearDiscordAccess,
  findDiscordPendingRequestByPairingCode,
  getDefaultConfig,
  getDiscordAccessSummary,
  migrateLegacyDiscordAccess,
  promoteDiscordUserToAdmin,
  demoteDiscordAdmin,
  rejectDiscordPendingRequest,
  removeDiscordUser,
} from './config.js';

describe('discord access config helpers', () => {
  it('migrates legacy Discord access with missing arrays', () => {
    const config = getDefaultConfig();
    config.channels.discord.admins = undefined as any;
    config.channels.discord.members = undefined as any;
    config.channels.discord.pending = undefined as any;

    migrateLegacyDiscordAccess(config);

    expect(config.channels.discord.admins).toEqual([]);
    expect(config.channels.discord.members).toEqual([]);
    expect(config.channels.discord.pending).toEqual([]);
  });

  it('approves pending requests and reports summary counts', () => {
    const config = getDefaultConfig();
    addDiscordPendingRequest(config, { userId: '111', username: 'alpha', displayName: 'Alpha', pairingCode: 'ABC123' });
    addDiscordPendingRequest(config, { userId: '222', username: 'beta' });

    expect(findDiscordPendingRequestByPairingCode(config, 'ABC123')?.userId).toBe('111');
    const admin = approveDiscordPendingRequestByPairingCode(config, 'ABC123');
    const member = approveDiscordPendingRequest(config, '222', 'member');

    expect(admin?.userId).toBe('111');
    expect(member?.userId).toBe('222');
    expect(getDiscordAccessSummary(config)).toBe('1 admin, 1 member, 0 pending');
  });

  it('supports reject, remove, promote, and demote flows', () => {
    const config = getDefaultConfig();
    addDiscordPendingRequest(config, { userId: '111', username: 'alpha' });
    addDiscordPendingRequest(config, { userId: '222', username: 'beta' });
    addDiscordPendingRequest(config, { userId: '333', username: 'gamma' });

    approveDiscordPendingRequest(config, '111', 'admin');
    approveDiscordPendingRequest(config, '222', 'member');
    expect(rejectDiscordPendingRequest(config, '333')?.userId).toBe('333');

    expect(promoteDiscordUserToAdmin(config, '222')?.userId).toBe('222');
    expect(demoteDiscordAdmin(config, '111')?.userId).toBe('111');
    expect(removeDiscordUser(config, '111')?.userId).toBe('111');

    expect(config.channels.discord.admins).toHaveLength(1);
    expect(config.channels.discord.members).toHaveLength(0);
    expect(config.channels.discord.pending).toHaveLength(0);
  });

  it('does not demote the last admin', () => {
    const config = getDefaultConfig();
    addDiscordPendingRequest(config, { userId: '111', username: 'solo' });
    approveDiscordPendingRequest(config, '111', 'admin');

    expect(demoteDiscordAdmin(config, '111')).toBeNull();
  });

  it('clears all Discord access state', () => {
    const config = getDefaultConfig();
    addDiscordPendingRequest(config, { userId: '111', username: 'alpha' });
    approveDiscordPendingRequest(config, '111', 'admin');

    clearDiscordAccess(config);

    expect(config.channels.discord.admins).toEqual([]);
    expect(config.channels.discord.members).toEqual([]);
    expect(config.channels.discord.pending).toEqual([]);
  });
});