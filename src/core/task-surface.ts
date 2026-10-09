/**
 * TaskSurface — the feedback contract, implemented once.
 *
 * Every channel used to get its own copy of "begin task / deliver / pause /
 * fail" inside Agent.handleMessage, and the copies drifted: verification
 * evidence reached the CLI only, pause banners were swallowed by Telegram's
 * status card, and Discord/Slack diverged from Signal. The agent now talks
 * to one surface; channels render, they do not decide.
 *
 * States: begin → (steps, via the channel's own feedback) → done | pause | fail.
 * done carries evidence (verification note, trace id); pause and fail are
 * always persistent messages, never status-card notices.
 */
import type { Channel } from '../channels/base.js';
import type { ChannelType } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface CompletionMetaLike {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  budgetUsed: number;
  budgetTotal: number;
  budgetPercentage: number;
}

export interface DoneInput {
  finalText: string;
  elapsedMs: number;
  stepCount: number;
  meta: CompletionMetaLike;
  /** "npm test ✓" style note; shown on every surface, not only the CLI. */
  verificationNote?: string;
  /** Short id resolvable with /trace. */
  traceId: string;
  /** The CLI already streamed the text; do not send it again. */
  alreadyStreamed: boolean;
  /** Show the completion banner even for a short task (Mercury Code execution). */
  forceBanner?: boolean;
}

export interface TaskSurface {
  readonly kind: 'cli' | 'web' | 'messaging' | 'plain' | 'none';
  begin(): void;
  done(input: DoneInput): Promise<void>;
  /** Persistent pause/failure banner; flushes deferred streamed text first. */
  pause(banner: string): Promise<void>;
  /** Returns whether the message was delivered (web may report false). */
  fail(message: string): Promise<boolean>;
}

/** A task is "substantial" when it earns a completion banner. */
export const isSubstantialTask = (stepCount: number, elapsedMs: number): boolean => stepCount >= 3 && elapsedMs >= 30_000;

/** Evidence footer appended to the final text on surfaces without a banner slot. */
export function evidenceFooter(verificationNote: string | undefined, traceId: string): string {
  const parts = [verificationNote ? `Verification: ${verificationNote}` : null, `/trace ${traceId}`].filter(Boolean);
  return `_${parts.join(' · ')}_`;
}

interface MessagingTaskChannel extends Channel {
  beginTask(targetId?: string): void;
  endTask(targetId?: string): void;
  resetStepCounter(targetId?: string): void;
  popDeferredResponse(targetId?: string): string | undefined;
  deferResponse?(targetId: string | undefined, content: string): void;
  cleanupEphemeralMessages?(targetId?: string): Promise<void>;
  sendCompletion(elapsedMs: number, stepCount: number, targetId?: string, meta?: CompletionMetaLike): Promise<void>;
}

interface CliTaskChannel extends Channel {
  sendCompletion(elapsedMs: number, stepCount: number, meta?: CompletionMetaLike, outcome?: 'complete' | 'steps-paused', verificationNote?: string): void;
}

interface WebTaskChannel extends Channel {
  sendError(message: string, targetId?: string): boolean;
}

const hasFn = (obj: unknown, name: string): boolean => typeof (obj as Record<string, unknown> | null)?.[name] === 'function';

function isMessagingTaskChannel(channel: Channel): channel is MessagingTaskChannel {
  return ['beginTask', 'endTask', 'resetStepCounter', 'popDeferredResponse', 'sendCompletion'].every((n) => hasFn(channel, n));
}

const warnSend = (e: unknown) => logger.warn({ e }, 'channel send failed');

export function createTaskSurface(channel: Channel | undefined, channelType: ChannelType, channelId: string): TaskSurface {
  if (!channel || channelType === 'internal') return NONE;

  if (channelType === 'cli') {
    const cli = channel as CliTaskChannel;
    return {
      kind: 'cli',
      begin() {},
      async done({ finalText, elapsedMs, stepCount, meta, verificationNote, traceId, alreadyStreamed, forceBanner }) {
        if (!alreadyStreamed) await cli.send(finalText, channelId, elapsedMs);
        if (isSubstantialTask(stepCount, elapsedMs) || forceBanner) {
          const note = verificationNote ? `${verificationNote} · /trace ${traceId}` : `/trace ${traceId}`;
          cli.sendCompletion(elapsedMs, stepCount, meta, undefined, note);
        }
      },
      async pause(banner) {
        await cli.send(banner, channelId).catch(warnSend);
      },
      async fail(message) {
        await cli.send(message, channelId);
        return true;
      },
    };
  }

  if (channelType === 'web') {
    const web = channel as WebTaskChannel;
    return {
      kind: 'web',
      begin() {},
      async done({ finalText, elapsedMs }) {
        await web.send(finalText, channelId, elapsedMs);
      },
      async pause(banner) {
        await web.send(banner, channelId).catch(warnSend);
      },
      async fail(message) {
        return hasFn(web, 'sendError') ? web.sendError(message, channelId) : (await web.send(message, channelId), true);
      },
    };
  }

  if (isMessagingTaskChannel(channel)) {
    const ch = channel;
    const finish = (): string | undefined => {
      ch.endTask(channelId);
      ch.resetStepCounter(channelId);
      return ch.popDeferredResponse(channelId);
    };
    return {
      kind: 'messaging',
      begin() {
        ch.resetStepCounter(channelId);
        ch.beginTask(channelId);
      },
      async done({ finalText, elapsedMs, stepCount, meta, verificationNote, traceId }) {
        // Evidence used to reach the CLI only; messaging users got "done"
        // with nothing to back it. Carry it in the final text instead.
        const footer = verificationNote ? `\n\n${evidenceFooter(verificationNote, traceId)}` : '';
        const text = `${finalText}${footer}`;
        if (isSubstantialTask(stepCount, elapsedMs)) {
          // sendCompletion owns endTask + deferred flush + cleanup on these channels.
          if (ch.deferResponse) {
            if (text.trim()) ch.deferResponse(channelId, text);
          } else {
            await ch.stream((async function* () { yield text; })(), channelId);
          }
          await ch.sendCompletion(elapsedMs, stepCount, channelId, meta);
          return;
        }
        ch.endTask(channelId);
        // The streamed answer was parked while the task was active; it wins
        // over finalText, but must still carry the evidence footer (it used
        // to be dropped on every streaming messaging channel).
        const deferred = ch.popDeferredResponse(channelId);
        const responseText = deferred && deferred.trim() ? `${deferred}${footer}` : text;
        if (responseText && responseText.trim()) await ch.send(responseText, channelId, elapsedMs);
        if (stepCount > 0 && ch.cleanupEphemeralMessages) await ch.cleanupEphemeralMessages(channelId);
        ch.resetStepCounter(channelId);
      },
      async pause(banner) {
        // End the task FIRST: while a task is active these channels route
        // short sends into the status card (truncated) and delete the card
        // on finalize, which made a pause look like silence.
        const deferred = finish();
        if (deferred && deferred.trim()) await ch.send(deferred, channelId).catch(warnSend);
        await ch.send(banner, channelId).catch(warnSend);
      },
      async fail(message) {
        finish();
        await ch.send(message, channelId);
        return true;
      },
    };
  }

  return {
    kind: 'plain',
    begin() {},
    async done({ finalText, elapsedMs }) {
      await channel.send(finalText, channelId, elapsedMs);
    },
    async pause(banner) {
      await channel.send(banner, channelId).catch(warnSend);
    },
    async fail(message) {
      await channel.send(message, channelId);
      return true;
    },
  };
}

const NONE: TaskSurface = {
  kind: 'none',
  begin() {},
  async done() {},
  async pause() {},
  async fail() {
    return false;
  },
};
