# Feishu Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Feishu channel that accepts private messages, returns text replies, and enforces a minimal approval flow without disturbing CLI or Telegram.

**Architecture:** Keep Mercury’s existing channel abstraction intact and add Feishu as one more `Channel` implementation. Use a small Feishu-specific access store in `src/utils/config.ts`, a dedicated adapter in `src/channels/feishu.ts`, and a tiny outbound-routing helper so replies always go back to the channel that received the message. Keep the first release narrow: private chat only, text only, CLI approval only.

**Tech Stack:** TypeScript, Node.js 20, existing Mercury channel framework, `@larksuiteoapi/node-sdk`, Vitest.

---

### Task 1: Add Feishu access state and config helpers

**Files:**
- Modify: `src/utils/config.ts`
- Create: `src/utils/feishu-access.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/utils/feishu-access.test.ts -t "feishu access config helpers"`
Expected: fail with missing Feishu helper functions and/or missing `channels.feishu` config fields.

- [ ] **Step 3: Implement the minimal config helpers**

Add a Feishu section to `MercuryConfig.channels` and `getDefaultConfig()`:

```ts
feishu: {
  enabled: getEnvBool('FEISHU_ENABLED', false),
  appId: getEnv('FEISHU_APP_ID', ''),
  appSecret: getEnv('FEISHU_APP_SECRET', ''),
  allowedUserIds: getEnv('FEISHU_ALLOWED_USER_IDS', '')
    .split(',')
    .filter(Boolean)
    .map((value) => value.trim()),
  admins: [],
  members: [],
  pending: [],
},
```

Add these helpers next to the Telegram helpers in `src/utils/config.ts`:

```ts
export interface FeishuAccessUser {
  openId: string;
  chatId: string;
  displayName?: string;
  requestedAt?: string;
  approvedAt: string;
}

export interface FeishuPendingRequest {
  openId: string;
  chatId: string;
  displayName?: string;
  requestedAt: string;
}

/** Return the approved Feishu users. */
export function getFeishuApprovedUsers(config: MercuryConfig): FeishuAccessUser[] {
  return [...config.channels.feishu.admins, ...config.channels.feishu.members];
}

/** Return the Feishu admins. */
export function getFeishuAdmins(config: MercuryConfig): FeishuAccessUser[] {
  return config.channels.feishu.admins;
}

/** Return the pending Feishu requests. */
export function getFeishuPendingRequests(config: MercuryConfig): FeishuPendingRequest[] {
  return config.channels.feishu.pending;
}

/** Find an approved Feishu user by openId. */
export function findFeishuApprovedUser(config: MercuryConfig, openId: string): FeishuAccessUser | undefined {
  return getFeishuApprovedUsers(config).find((user) => user.openId === openId);
}

/** Find a pending Feishu request by openId. */
export function findFeishuPendingRequest(config: MercuryConfig, openId: string): FeishuPendingRequest | undefined {
  return config.channels.feishu.pending.find((request) => request.openId === openId);
}

/** Check whether the config already has a Feishu admin. */
export function hasFeishuAdmins(config: MercuryConfig): boolean {
  return config.channels.feishu.admins.length > 0;
}

/** Check whether a Feishu openId is auto-allowed. */
export function isFeishuAutoAllowed(config: MercuryConfig, openId: string): boolean {
  return config.channels.feishu.allowedUserIds.includes(openId);
}

/** Summarize Feishu access state. */
export function getFeishuAccessSummary(config: MercuryConfig): string {
  return `${config.channels.feishu.admins.length} admin${config.channels.feishu.admins.length === 1 ? '' : 's'}, `
    + `${config.channels.feishu.members.length} member${config.channels.feishu.members.length === 1 ? '' : 's'}, `
    + `${config.channels.feishu.pending.length} pending`;
}

/** Add a Feishu pending request. */
export function addFeishuPendingRequest(
  config: MercuryConfig,
  request: Omit<FeishuPendingRequest, 'requestedAt'> & { requestedAt?: string },
): FeishuPendingRequest {
  const existing = findFeishuPendingRequest(config, request.openId);
  if (existing) {
    existing.chatId = request.chatId;
    existing.displayName = request.displayName || existing.displayName;
    return existing;
  }

  const created: FeishuPendingRequest = {
    ...request,
    requestedAt: request.requestedAt || new Date().toISOString(),
  };
  config.channels.feishu.pending.push(created);
  return created;
}

/** Approve a Feishu pending request. */
export function approveFeishuPendingRequest(
  config: MercuryConfig,
  openId: string,
  role: 'admin' | 'member' = 'member',
): FeishuAccessUser | null {
  const request = findFeishuPendingRequest(config, openId);
  if (!request) return null;

  const approvedUser: FeishuAccessUser = {
    openId: request.openId,
    chatId: request.chatId,
    displayName: request.displayName,
    requestedAt: request.requestedAt,
    approvedAt: new Date().toISOString(),
  };

  config.channels.feishu.pending = config.channels.feishu.pending.filter((entry) => entry.openId !== openId);
  config.channels.feishu.admins = config.channels.feishu.admins.filter((entry) => entry.openId !== openId);
  config.channels.feishu.members = config.channels.feishu.members.filter((entry) => entry.openId !== openId);

  if (role === 'admin') {
    config.channels.feishu.admins.push(approvedUser);
  } else {
    config.channels.feishu.members.push(approvedUser);
  }

  return approvedUser;
}

/** Reject a Feishu pending request. */
export function rejectFeishuPendingRequest(config: MercuryConfig, openId: string): FeishuPendingRequest | null {
  const request = findFeishuPendingRequest(config, openId);
  if (!request) return null;
  config.channels.feishu.pending = config.channels.feishu.pending.filter((entry) => entry.openId !== openId);
  return request;
}

/** Remove a Feishu user from approved access. */
export function removeFeishuUser(config: MercuryConfig, openId: string): FeishuAccessUser | null {
  const admin = config.channels.feishu.admins.find((entry) => entry.openId === openId);
  if (admin) {
    config.channels.feishu.admins = config.channels.feishu.admins.filter((entry) => entry.openId !== openId);
    return admin;
  }

  const member = config.channels.feishu.members.find((entry) => entry.openId === openId);
  if (member) {
    config.channels.feishu.members = config.channels.feishu.members.filter((entry) => entry.openId !== openId);
    return member;
  }

  return null;
}

/** Promote a Feishu member to admin. */
export function promoteFeishuUserToAdmin(config: MercuryConfig, openId: string): FeishuAccessUser | null {
  const member = config.channels.feishu.members.find((entry) => entry.openId === openId);
  if (!member) return null;
  config.channels.feishu.members = config.channels.feishu.members.filter((entry) => entry.openId !== openId);
  config.channels.feishu.admins.push(member);
  return member;
}

/** Demote a Feishu admin to member. */
export function demoteFeishuAdmin(config: MercuryConfig, openId: string): FeishuAccessUser | null {
  if (config.channels.feishu.admins.length <= 1) {
    return null;
  }

  const admin = config.channels.feishu.admins.find((entry) => entry.openId === openId);
  if (!admin) return null;
  config.channels.feishu.admins = config.channels.feishu.admins.filter((entry) => entry.openId !== openId);
  config.channels.feishu.members.push(admin);
  return admin;
}

/** Clear all Feishu access state. */
export function clearFeishuAccess(config: MercuryConfig): MercuryConfig {
  config.channels.feishu.admins = [];
  config.channels.feishu.members = [];
  config.channels.feishu.pending = [];
  return config;
}
```

Keep Telegram helpers unchanged; do not refactor them as part of this task.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/utils/feishu-access.test.ts -t "feishu access config helpers"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/config.ts src/utils/feishu-access.test.ts
git commit -m "feat: add feishu access helpers"
```

---

### Task 2: Add the Feishu channel adapter and registry wiring

**Files:**
- Create: `src/channels/feishu.ts`
- Create: `src/channels/feishu.test.ts`
- Modify: `src/channels/index.ts`
- Modify: `src/channels/registry.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeFeishuEvent, resolveFeishuTargetId } from './feishu.js';

describe('feishu adapter helpers', () => {
  it('normalizes a private text event to a Mercury channel message', () => {
    const message = normalizeFeishuEvent({
      header: {
        event_id: 'evt_1',
        event_type: 'im.message.receive_v1',
        create_time: '1710000000000',
        token: 'token',
      },
      event: {
        sender: { sender_id: { open_id: 'ou_1' } },
        message: {
          message_id: 'msg_1',
          chat_id: 'oc_1',
          message_type: 'text',
          content: '{"text":"hello"}',
        },
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/channels/feishu.test.ts -t "feishu adapter helpers"`
Expected: fail because the adapter helpers and channel class do not exist yet.

- [ ] **Step 3: Install the official Feishu SDK**

Run: `npm install @larksuiteoapi/node-sdk`
Expected: `package.json` and the lockfile record the official Feishu SDK dependency.

- [ ] **Step 4: Implement the Feishu adapter behind a thin transport interface**

Create `src/channels/feishu.ts` with a thin wrapper around the official SDK so the Mercury channel can be tested without a live bot:

```ts
import * as Lark from '@larksuiteoapi/node-sdk';
import type { ChannelMessage } from '../types/channel.js';
import type { MercuryConfig } from '../utils/config.js';
import {
  addFeishuPendingRequest,
  approveFeishuPendingRequest,
  findFeishuApprovedUser,
  isFeishuAutoAllowed,
  saveConfig,
} from '../utils/config.js';
import { BaseChannel } from './base.js';

export interface FeishuEventEnvelope { /* event_id, chat_id, open_id, text content */ }

export interface FeishuTransport {
  start(onEvent: (event: FeishuEventEnvelope) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, content: string): Promise<void>;
}

export function resolveFeishuTargetId(targetId?: string): string | undefined {
  if (!targetId) return undefined;
  return targetId.startsWith('feishu:') ? targetId.slice('feishu:'.length) : targetId;
}

export function normalizeFeishuEvent(envelope: FeishuEventEnvelope): ChannelMessage | null {
  const chatId = envelope.event?.message?.chat_id;
  const openId = envelope.event?.sender?.sender_id?.open_id;
  const rawContent = envelope.event?.message?.content;
  const messageType = envelope.event?.message?.message_type;

  if (!chatId || !openId || messageType !== 'text' || !rawContent) return null;

  let parsed: { text?: string };
  try {
    parsed = JSON.parse(rawContent) as { text?: string };
  } catch {
    return null;
  }

  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  if (!text) return null;

  return {
    id: envelope.header.event_id,
    channelId: `feishu:${chatId}`,
    channelType: 'feishu',
    senderId: openId,
    content: text,
    timestamp: Number(envelope.header.create_time),
    metadata: {
      chatId,
      eventId: envelope.header.event_id,
      messageId: envelope.event.message?.message_id,
    },
  };
}

export class FeishuChannel extends BaseChannel {
  readonly type = 'feishu' as const;
  private transport: FeishuTransport;

  constructor(private config: MercuryConfig) {
    super();
    this.transport = createFeishuTransport(config);
  }

  async start(): Promise<void> {
    await this.transport.start(async (envelope) => {
      const message = normalizeFeishuEvent(envelope);
      if (!message) return;

      if (isFeishuAutoAllowed(this.config, message.senderId) || findFeishuApprovedUser(this.config, message.senderId)) {
        this.emit(message);
        return;
      }

      addFeishuPendingRequest(this.config, {
        openId: message.senderId,
        chatId: message.channelId.slice('feishu:'.length),
        displayName: message.senderName,
      });
      saveConfig(this.config);
      await this.transport.sendText(resolveFeishuTargetId(message.channelId)!, 'Access pending. Ask Mercury CLI to approve this Feishu user.');
    });
    this.ready = true;
  }

  async stop(): Promise<void> {
    await this.transport.stop();
    this.ready = false;
  }

  async send(content: string, targetId?: string): Promise<void> {
    const chatId = resolveFeishuTargetId(targetId);
    if (!chatId) return;
    await this.transport.sendText(chatId, content);
  }

  async sendFile(): Promise<void> {
    throw new Error('Feishu file sending is not part of the MVP');
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let full = '';
    for await (const chunk of content) full += chunk;
    await this.send(full, targetId);
    return full;
  }

  async typing(): Promise<void> {
    return;
  }

  async askToContinue(): Promise<boolean> {
    return true;
  }
}

function createFeishuTransport(config: MercuryConfig): FeishuTransport {
  const client = new Lark.Client({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
  });
  const wsClient = new Lark.WSClient({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
  });

  return {
    start: async (onEvent) => {
      wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (event: FeishuEventEnvelope) => {
            await onEvent(event);
          },
        }),
      });
    },
    stop: async () => {
      await wsClient.stop();
    },
    sendText: async (chatId, content) => {
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: content }),
        },
      });
    },
  };
}
```

Before coding, verify the exact `@larksuiteoapi/node-sdk` shapes for `WSClient.start`, `EventDispatcher.register`, and `client.im.v1.message.create` in the official docs, then keep this wrapper thin and match those documented parameter names exactly.

Wire it into the registry and exports:

```ts
// src/channels/index.ts
export { FeishuChannel } from './feishu.js';

// src/channels/registry.ts
import { FeishuChannel } from './feishu.js';

if (config.channels.feishu.enabled && config.channels.feishu.appId && config.channels.feishu.appSecret) {
  this.register('feishu', new FeishuChannel(config));
}
```

Add a one-line JSDoc comment to each exported helper and to `FeishuChannel` so the new public surface matches the repository’s code-quality rule.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/channels/feishu.test.ts -t "feishu adapter helpers"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/channels/feishu.ts src/channels/feishu.test.ts src/channels/index.ts src/channels/registry.ts
git commit -m "feat: add feishu channel adapter"
```

---

### Task 3: Route replies through the source channel and expose Feishu CLI controls

**Files:**
- Create: `src/core/channel-routing.ts`
- Create: `src/core/channel-routing.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { pickOutboundChannelType } from './channel-routing.js';

describe('pickOutboundChannelType', () => {
  it('prefers the current ready channel', () => {
    expect(
      pickOutboundChannelType({
        currentChannelType: 'feishu',
        readyChannels: ['cli', 'feishu'],
        fallbackChannel: 'cli',
      }),
    ).toBe('feishu');
  });

  it('falls back to the notification channel when the current channel is not ready', () => {
    expect(
      pickOutboundChannelType({
        currentChannelType: 'feishu',
        readyChannels: ['cli'],
        fallbackChannel: 'cli',
      }),
    ).toBe('cli');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/core/channel-routing.test.ts -t "pickOutboundChannelType"`
Expected: fail because the helper does not exist yet.

- [ ] **Step 3: Implement the outbound routing helper and use it from `src/index.ts`**

Add `src/core/channel-routing.ts`:

```ts
import type { ChannelType } from '../types/channel.js';

export interface OutboundChannelContext {
  currentChannelType: ChannelType;
  readyChannels: ChannelType[];
  fallbackChannel: ChannelType;
}

export function pickOutboundChannelType(context: OutboundChannelContext): ChannelType {
  if (context.readyChannels.includes(context.currentChannelType)) {
    return context.currentChannelType;
  }
  if (context.readyChannels.includes(context.fallbackChannel)) {
    return context.fallbackChannel;
  }
  return context.readyChannels[0] ?? context.fallbackChannel;
}
```

Then in `src/index.ts`:

```ts
capabilities.setSendFileHandler(async (filePath: string) => {
  const { channelId, channelType } = capabilities.getChannelContext();
  const targetType = pickOutboundChannelType({
    currentChannelType: channelType as ChannelType,
    readyChannels: channels.getActiveChannels(),
    fallbackChannel: 'cli',
  });
  const targetChannel = channels.get(targetType);
  if (targetChannel) {
    await targetChannel.sendFile(filePath, channelId);
    return;
  }
  throw new Error(`No outbound channel available for ${filePath}`);
});

capabilities.setSendMessageHandler(async (content: string) => {
  const { channelId, channelType } = capabilities.getChannelContext();
  const targetType = pickOutboundChannelType({
    currentChannelType: channelType as ChannelType,
    readyChannels: channels.getActiveChannels(),
    fallbackChannel: 'cli',
  });
  const targetChannel = channels.get(targetType);
  if (!targetChannel) {
    throw new Error('No outbound channel available.');
  }
  await targetChannel.send(content, channelId);
});
```

Add Feishu setup/status output next to Telegram in the CLI wizard and `status` command:

```ts
console.log(chalk.bold.white('  Feishu (optional)'));
console.log(chalk.dim('  Mercury can also connect to Feishu private chats.'));
console.log(chalk.dim('  Leave empty to skip. You can add it later with mercury doctor.'));

const feishuAppId = await ask(chalk.white('  Feishu App ID: '));
const feishuAppSecret = await ask(chalk.white('  Feishu App Secret: '));
const feishuAllowed = await ask(chalk.white('  Feishu Allowed User IDs (comma-separated, optional): '));
```

Add a Feishu command group that mirrors Telegram access management:

```ts
const feishuCmd = program.command('feishu').description('Manage Feishu access approvals and admins');
feishuCmd.command('list')
  .description('Show approved Feishu users and pending requests')
  .action(() => {
    const config = loadConfig();
    console.log('');
    console.log(`  Feishu Access: ${chalk.white(getFeishuAccessSummary(config))}`);
    console.log(`  Admins:        ${config.channels.feishu.admins.length > 0 ? chalk.green(getFeishuAdmins(config).map(formatFeishuUser).join(', ')) : chalk.dim('none')}`);
    console.log(`  Members:       ${config.channels.feishu.members.length > 0 ? chalk.green(getFeishuApprovedUsers(config).filter((user) => !config.channels.feishu.admins.some((admin) => admin.openId === user.openId)).map(formatFeishuUser).join(', ')) : chalk.dim('none')}`);
    console.log(`  Pending:       ${config.channels.feishu.pending.length > 0 ? chalk.yellow(getFeishuPendingRequests(config).map(formatFeishuPending).join(', ')) : chalk.dim('none')}`);
    console.log('');
  });

feishuCmd.command('approve <openId>').description('Approve a pending Feishu access request by openId').action((openId: string) => {
  const config = loadConfig();
  const approved = approveFeishuPendingRequest(config, openId, hasFeishuAdmins(config) ? 'member' : 'admin');
  if (!approved) {
    console.log('');
    console.log(chalk.red(`  No pending Feishu request found for openId ${openId}.`));
    console.log('');
    return;
  }
  saveConfig(config);
  console.log('');
  console.log(chalk.green(`  ✓ Approved Feishu ${formatFeishuUser(approved)}.`));
  restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
  console.log('');
});
feishuCmd.command('reject <openId>').description('Reject a pending Feishu access request').action((openId: string) => {
  const config = loadConfig();
  const rejected = rejectFeishuPendingRequest(config, openId);
  if (!rejected) {
    console.log('');
    console.log(chalk.red(`  No pending Feishu request found for openId ${openId}.`));
    console.log('');
    return;
  }
  saveConfig(config);
  console.log('');
  console.log(chalk.green(`  ✓ Rejected Feishu request for ${formatFeishuPending(rejected)}.`));
  restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
  console.log('');
});
feishuCmd.command('remove <openId>').description('Remove an approved Feishu admin or member').action((openId: string) => {
  const config = loadConfig();
  const removed = removeFeishuUser(config, openId);
  if (!removed) {
    console.log('');
    console.log(chalk.red(`  No approved Feishu user found for openId ${openId}.`));
    console.log('');
    return;
  }
  saveConfig(config);
  console.log('');
  console.log(chalk.green(`  ✓ Removed Feishu access for ${formatFeishuUser(removed)}.`));
  restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
  console.log('');
});
feishuCmd.command('promote <openId>').description('Promote a Feishu member to admin').action((openId: string) => {
  const config = loadConfig();
  const promoted = promoteFeishuUserToAdmin(config, openId);
  if (!promoted) {
    console.log('');
    console.log(chalk.red(`  No Feishu member found for openId ${openId}.`));
    console.log('');
    return;
  }
  saveConfig(config);
  console.log('');
  console.log(chalk.green(`  ✓ Promoted ${formatFeishuUser(promoted)} to Feishu admin.`));
  restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
  console.log('');
});
feishuCmd.command('demote <openId>').description('Demote a Feishu admin to member').action((openId: string) => {
  const config = loadConfig();
  const demoted = demoteFeishuAdmin(config, openId);
  if (!demoted) {
    console.log('');
    console.log(chalk.red(`  No Feishu admin found for openId ${openId}, or this is the last admin.`));
    console.log('');
    return;
  }
  saveConfig(config);
  console.log('');
  console.log(chalk.green(`  ✓ Demoted ${formatFeishuUser(demoted)} to Feishu member.`));
  restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
  console.log('');
});
feishuCmd.command('reset').description('Clear all Feishu access state').action(() => {
  const config = loadConfig();
  clearFeishuAccess(config);
  saveConfig(config);
  console.log('');
  console.log(chalk.green('  ✓ Cleared all Feishu access state.'));
  restartDaemonIfRunning('Restarting the background daemon to apply the change immediately...');
  console.log('');
});
```

Keep the CLI behavior aligned with Telegram: every Feishu command should print a blank line before and after, should save config only after a successful mutation, and should show an explicit error message when the target `openId` is not found or a demotion would leave zero admins.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/core/channel-routing.test.ts -t "pickOutboundChannelType"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/channel-routing.ts src/core/channel-routing.test.ts src/index.ts
git commit -m "feat: route replies through active channel"
```

---

### Task 4: Verify the complete Feishu MVP path

**Files:**
- No new files; verify the files changed in Tasks 1–3.

- [ ] **Step 1: Run the full build**

Run: `npm run build`
Expected: TypeScript builds successfully and tsup completes without errors.

- [ ] **Step 2: Run lint/type-check**

Run: `npm run lint`
Expected: `tsc --noEmit` passes with no type errors.

- [ ] **Step 3: Run the test suite**

Run: `npm run test`
Expected: All Vitest tests pass, including the new Feishu helper tests.

- [ ] **Step 4: Run the CLI and daemon checks**

Run: `mercury status`
Expected: output shows Feishu enabled/disabled state and Feishu access summary.

Run: `mercury feishu list`
Expected: output lists approved and pending Feishu users without throwing.

Run: `mercury start`
Expected: Mercury starts normally with Feishu configured or disabled.

- [ ] **Step 5: Perform a manual smoke check with a configured Feishu bot**

1. Start Mercury with Feishu enabled.
2. Send a private message from an unapproved Feishu user.
3. Confirm the user appears in `feishu list` as pending.
4. Approve that `openId` with the CLI command.
5. Send another message from the same Feishu chat.
6. Confirm Mercury replies back into the same Feishu chat.

- [ ] **Step 6: Commit the verified implementation**

```bash
git add src/utils/config.ts src/utils/feishu-access.test.ts src/channels/feishu.ts src/channels/feishu.test.ts src/channels/index.ts src/channels/registry.ts src/core/channel-routing.ts src/core/channel-routing.test.ts src/index.ts
git commit -m "feat: add feishu channel MVP"
```
