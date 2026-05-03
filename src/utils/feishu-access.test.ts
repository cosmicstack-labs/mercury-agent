import { describe, expect, it } from 'vitest';
import {
  addFeishuPendingRequest,
  approveFeishuPendingRequest,
  clearFeishuAccess,
  demoteFeishuAdmin,
  getDefaultConfig,
  getFeishuAdmins,
  getFeishuAccessSummary,
  getFeishuApprovedUsers,
  getFeishuPendingRequests,
  findFeishuApprovedUser,
  findFeishuPendingRequest,
  hasFeishuAdmins,
  isFeishuAutoAllowed,
  promoteFeishuUserToAdmin,
  rejectFeishuPendingRequest,
  removeFeishuUser,
} from './config.js';

describe('feishu access config helpers', () => {
  it('creates, approves, promotes, demotes, rejects, and clears Feishu access', () => {
    const config = getDefaultConfig();
    config.channels.feishu.allowedUserIds = ['ou_allow'];

    addFeishuPendingRequest(config, { openId: 'ou_1', chatId: 'oc_1', displayName: 'alpha' });
    addFeishuPendingRequest(config, { openId: 'ou_2', chatId: 'oc_2', displayName: 'beta' });

    expect(isFeishuAutoAllowed(config, 'ou_allow')).toBe(true);
    expect(approveFeishuPendingRequest(config, 'ou_1', 'admin')?.openId).toBe('ou_1');
    expect(approveFeishuPendingRequest(config, 'ou_2', 'member')?.openId).toBe('ou_2');

    expect(promoteFeishuUserToAdmin(config, 'ou_2')?.openId).toBe('ou_2');
    expect(demoteFeishuAdmin(config, 'ou_1')?.openId).toBe('ou_1');
    expect(rejectFeishuPendingRequest(config, 'ou_missing')).toBeNull();
    expect(removeFeishuUser(config, 'ou_2')?.openId).toBe('ou_2');

    clearFeishuAccess(config);
    expect(getFeishuAccessSummary(config)).toBe('0 admins, 0 members, 0 pending');
  });
});
