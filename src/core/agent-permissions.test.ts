import { describe, expect, it } from 'vitest';
import { getMessagePermissionPolicy } from './agent.js';

describe('getMessagePermissionPolicy', () => {
  it('keeps auto-approve for internal messages without a root temp scope concept in the contract', () => {
    const policy = getMessagePermissionPolicy({
      channelType: 'internal',
      senderId: 'user-123',
    });

    expect(policy).toEqual({ autoApproveAll: true });
  });

  it('keeps auto-approve for scheduled system messages without a root temp scope concept in the contract', () => {
    const policy = getMessagePermissionPolicy({
      channelType: 'cli',
      senderId: 'system',
    });

    expect(policy).toEqual({ autoApproveAll: true });
  });

  it('does not elevate normal external messages', () => {
    const policy = getMessagePermissionPolicy({
      channelType: 'telegram',
      senderId: 'user-456',
    });

    expect(policy).toEqual({ autoApproveAll: false });
  });
});
