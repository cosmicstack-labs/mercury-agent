import type { ChannelType } from '../types/channel.js';

export interface OutboundChannelContext {
  currentChannelType: ChannelType;
  readyChannels: ChannelType[];
  fallbackChannel: ChannelType;
}

/** Pick the outbound channel type based on context. */
export function pickOutboundChannelType(context: OutboundChannelContext): ChannelType {
  if (context.readyChannels.includes(context.currentChannelType)) {
    return context.currentChannelType;
  }
  if (context.readyChannels.includes(context.fallbackChannel)) {
    return context.fallbackChannel;
  }
  return context.readyChannels[0] ?? context.fallbackChannel;
}
