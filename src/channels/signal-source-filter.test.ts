// Regression tests for the Signal source filter (private + group modes).
//
// Bug background: signal-cli emits a syncMessage.sentMessage envelope for EVERY
// message the account owner sends from a linked device — including 1:1 DMs to
// third parties. The sync→dataMessage conversion in handleEnvelopeInner forced
// effectiveSource to the account itself and discarded sentMessage.destination,
// so in private mode every DM the owner sent passed the "is it me?" filter and
// got answered in Note to Self. The fix gates the sync path on the destination
// being the account itself (Note to Self) in private mode.
import { describe, it, expect } from 'vitest';
import { SignalChannel } from './signal.js';
import type { MercuryConfig } from '../utils/config.js';
import type { ChannelMessage } from '../types/channel.js';

const OWNER = '+10000000000';
const ALICE = '+15555550123';
const GROUP_ID = 'group-abc';

function makeConfig(mode: string): MercuryConfig {
  return {
    channels: {
      signal: {
        enabled: true,
        phoneNumber: OWNER,
        mode,
        groupId: mode === 'group' ? GROUP_ID : undefined,
        groupName: mode === 'group' ? 'Mercury' : undefined,
        admins: [{ phoneNumber: OWNER, role: 'admin', pairedAt: new Date().toISOString() }],
        members: [{ phoneNumber: ALICE, role: 'member', pairedAt: new Date().toISOString() }],
        pending: [],
      },
    },
  } as unknown as MercuryConfig;
}

function makeChannel(config: MercuryConfig) {
  const ch = new SignalChannel(config);
  // Keep the in-memory fixture config instead of reading the real one from disk.
  (ch as any).reloadConfigFromDisk = () => {};
  const emitted: ChannelMessage[] = [];
  ch.onMessage((m) => emitted.push(m));
  return { ch, emitted };
}

let ts = 1718000000000;
function nextTs() {
  return ++ts;
}

// Envelope shapes mirror signal-cli JSON-RPC `receive` notifications.
function syncSentEnvelope(opts: { text: string; destination?: string; destinationNumber?: string; groupId?: string }) {
  const t = nextTs();
  return {
    source: OWNER, // sync envelopes always carry the account itself as source
    sourceUuid: 'owner-uuid',
    sourceName: 'You',
    timestamp: t,
    syncMessage: {
      sentMessage: {
        timestamp: t,
        message: opts.text,
        destination: opts.destination,
        destinationNumber: opts.destinationNumber,
        groupInfo: opts.groupId ? { groupId: opts.groupId, groupName: 'Some Group' } : undefined,
      },
    },
  };
}

function incomingEnvelope(opts: { from: string; text: string; groupId?: string }) {
  const t = nextTs();
  return {
    source: opts.from,
    sourceUuid: `${opts.from}-uuid`,
    sourceName: 'Sender',
    timestamp: t,
    dataMessage: {
      timestamp: t,
      message: opts.text,
      groupInfo: opts.groupId ? { groupId: opts.groupId, groupName: 'Some Group' } : undefined,
    },
  };
}

describe('Signal private mode — only Note to Self is processed', () => {
  it('drops a synced DM the owner sent to a third party', () => {
    const { ch, emitted } = makeChannel(makeConfig('private'));
    (ch as any).handleEnvelope(syncSentEnvelope({ text: 'hey Alice, lunch?', destination: ALICE }));
    expect(emitted).toHaveLength(0);
  });

  it('drops a synced DM addressed by destinationNumber only', () => {
    const { ch, emitted } = makeChannel(makeConfig('private'));
    (ch as any).handleEnvelope(syncSentEnvelope({ text: 'hey Alice', destinationNumber: ALICE }));
    expect(emitted).toHaveLength(0);
  });

  it('drops a synced message the owner sent to a group', () => {
    const { ch, emitted } = makeChannel(makeConfig('private'));
    (ch as any).handleEnvelope(syncSentEnvelope({ text: 'hi group', groupId: GROUP_ID }));
    expect(emitted).toHaveLength(0);
  });

  it('processes a synced Note to Self (destination = own number)', () => {
    const { ch, emitted } = makeChannel(makeConfig('private'));
    (ch as any).handleEnvelope(syncSentEnvelope({ text: 'remind me to buy milk', destination: OWNER }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].channelId).toBe(`signal:${OWNER}`);
  });

  it('processes a synced Note to Self addressed via destinationNumber', () => {
    const { ch, emitted } = makeChannel(makeConfig('private'));
    (ch as any).handleEnvelope(syncSentEnvelope({ text: 'note', destinationNumber: OWNER }));
    expect(emitted).toHaveLength(1);
  });

  it('processes a real incoming Note to Self dataMessage (source = self)', () => {
    const { ch, emitted } = makeChannel(makeConfig('private'));
    (ch as any).handleEnvelope(incomingEnvelope({ from: OWNER, text: 'note from another device' }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].channelId).toBe(`signal:${OWNER}`);
  });

  it('drops an incoming DM from a third party', () => {
    const { ch, emitted } = makeChannel(makeConfig('private'));
    (ch as any).handleEnvelope(incomingEnvelope({ from: ALICE, text: 'hi mercury' }));
    expect(emitted).toHaveLength(0);
  });

  it('drops an incoming group message', () => {
    const { ch, emitted } = makeChannel(makeConfig('private'));
    (ch as any).handleEnvelope(incomingEnvelope({ from: ALICE, text: 'hi all', groupId: GROUP_ID }));
    expect(emitted).toHaveLength(0);
  });
});

describe('Signal group mode — only the configured group is processed', () => {
  it('drops a synced DM the owner sent to a third party', () => {
    const { ch, emitted } = makeChannel(makeConfig('group'));
    (ch as any).handleEnvelope(syncSentEnvelope({ text: 'hey Alice', destination: ALICE }));
    expect(emitted).toHaveLength(0);
  });

  it('drops a synced message the owner sent to a DIFFERENT group', () => {
    const { ch, emitted } = makeChannel(makeConfig('group'));
    (ch as any).handleEnvelope(syncSentEnvelope({ text: 'wrong group', groupId: 'group-xyz' }));
    expect(emitted).toHaveLength(0);
  });

  it('processes a synced message the owner sent to the configured group', () => {
    const { ch, emitted } = makeChannel(makeConfig('group'));
    (ch as any).handleEnvelope(syncSentEnvelope({ text: 'hello mercury group', groupId: GROUP_ID }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].channelId).toBe(`signal:${GROUP_ID}`);
  });

  it('processes an incoming group message from a paired member', () => {
    const { ch, emitted } = makeChannel(makeConfig('group'));
    (ch as any).handleEnvelope(incomingEnvelope({ from: ALICE, text: 'hey mercury', groupId: GROUP_ID }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].channelId).toBe(`signal:${GROUP_ID}`);
  });

  it('drops an incoming 1:1 DM even from the admin', () => {
    const { ch, emitted } = makeChannel(makeConfig('group'));
    (ch as any).handleEnvelope(incomingEnvelope({ from: OWNER, text: 'private hello' }));
    expect(emitted).toHaveLength(0);
  });

  it('drops a message from a different group', () => {
    const { ch, emitted } = makeChannel(makeConfig('group'));
    (ch as any).handleEnvelope(incomingEnvelope({ from: ALICE, text: 'wrong place', groupId: 'group-xyz' }));
    expect(emitted).toHaveLength(0);
  });
});
