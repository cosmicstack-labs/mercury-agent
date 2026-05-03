import { describe, expect, it } from 'vitest';
import { normalizeFeishuEvent, resolveFeishuTargetId } from './feishu.js';

describe('feishu adapter helpers', () => {
  it('normalizes a private text event to a Mercury channel message', () => {
    const message = normalizeFeishuEvent({
      event_id: 'evt_1',
      event_type: 'im.message.receive_v1',
      create_time: '1710000000000',
      token: 'token',
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'msg_1',
        chat_id: 'oc_1',
        message_type: 'text',
        content: '{"text":"hello"}',
      },
    });

    expect(message).toMatchObject({
      channelType: 'feishu',
      channelId: 'feishu:oc_1',
      senderId: 'ou_1',
      content: 'hello',
    });
  });

  it('resolves Mercury target ids back to Feishu chat ids', () => {
    expect(resolveFeishuTargetId('feishu:oc_2')).toBe('oc_2');
    expect(resolveFeishuTargetId('oc_3')).toBe('oc_3');
  });
});
