import type { PermissionManager } from '../capabilities/permissions.js';
import type { PermissionMode } from '../channels/base.js';

type SessionPermissionApplier = Pick<PermissionManager, 'setCurrentChannel' | 'setAutoApproveAll'>;

export function applySessionPermissionMode(
  mode: PermissionMode | undefined,
  channelId: string,
  channelType: string,
  permissions: SessionPermissionApplier,
): void {
  if (mode === undefined) {
    return;
  }

  permissions.setCurrentChannel(channelId, channelType);
  permissions.setAutoApproveAll(mode === 'allow-all');
}
