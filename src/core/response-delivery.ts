import type { ChannelType } from '../types/channel.js';

export function requiresFinalSend(channelType: ChannelType, cliResponseStreamed: boolean): boolean {
  return channelType !== 'cli' || !cliResponseStreamed;
}
