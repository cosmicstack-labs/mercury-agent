import { BaseChannel } from './base.js';
import type { ChannelMessage } from '../types/channel.js';
import { logger } from '../utils/logger.js';

type ApprovalResolver = () => void;

export interface ChatEvent {
  type: 'thinking' | 'provider' | 'step_start' | 'step_done' | 'text_delta' | 'text_done' | 'permission_request' | 'permission_continue' | 'permission_mode' | 'loop_warning' | 'error' | 'audio_chunk' | 'audio_end' | 'transcript_partial' | 'transcript_final';
  data?: Record<string, unknown>;
}

class SSEClient {
  controller: ReadableStreamDefaultController;
  id: string;

  constructor(controller: ReadableStreamDefaultController, id: string) {
    this.controller = controller;
    this.id = id;
  }

  send(event: ChatEvent): void {
    try {
      const data = `event: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`;
      this.controller.enqueue(new TextEncoder().encode(data));
    } catch {
      // client disconnected
    }
  }

  close(): void {
    try {
      this.controller.close();
    } catch {}
  }
}

export class WebChannel extends BaseChannel {
  readonly type = 'web' as const;
  private sseClients: Map<string, SSEClient> = new Map();
  private pendingApprovals: Map<string, ApprovalResolver> = new Map();
  private pendingContinues: Map<string, ApprovalResolver> = new Map();
  private pendingPermModes: Map<string, ApprovalResolver> = new Map();
  private agentName: string;
  private stepCounter: Map<string, number> = new Map();
  private bypassPermissions = false;
  private restrictUser = false;

  constructor(agentName: string) {
    super();
    this.agentName = agentName;
  }

  async start(): Promise<void> {
    this.ready = true;
    logger.info('Web channel started');
  }

  async stop(): Promise<void> {
    this.ready = false;
    for (const [, client] of this.sseClients) {
      client.close();
    }
    this.sseClients.clear();
  }

  addSSEClient(controller: ReadableStreamDefaultController): string {
    const id = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const client = new SSEClient(controller, id);
    this.sseClients.set(id, client);
    return id;
  }

  removeSSEClient(id: string): void {
    this.sseClients.delete(id);
  }

  private broadcast(event: ChatEvent): void {
    for (const [, client] of this.sseClients) {
      client.send(event);
    }
  }

  resolveApproval(id: string, action: string): boolean {
    const key = `${id}:${action}`;
    const resolver = this.pendingApprovals.get(key);
    if (resolver) {
      this.pendingApprovals.delete(key);
      resolver();
      return true;
    }
    // also check continues
    const continueResolver = this.pendingContinues.get(key);
    if (continueResolver) {
      this.pendingContinues.delete(key);
      continueResolver();
      return true;
    }
    // and perm modes
    const modeResolver = this.pendingPermModes.get(key);
    if (modeResolver) {
      this.pendingPermModes.delete(key);
      modeResolver();
      return true;
    }
    return false;
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    this.broadcast({
      type: 'text_done',
      data: { fullText: content, elapsedMs, targetId },
    });
  }

  async sendFile(_filePath: string, _targetId?: string): Promise<void> {
    // Not needed for web — files are referenced in text
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let fullText = '';
    // Tee text deltas → SSE clients AND (optionally) the VoiceManager.
    // The voice tee is opened lazily so users without voice configured
    // pay zero overhead, and so a slow speaker can never back-pressure
    // the SSE stream (the pipeline drains via its own queue).
    const voiceQueue = await this.openVoiceQueue(targetId);
    try {
      for await (const chunk of content) {
        fullText += chunk;
        voiceQueue?.push(chunk);
        this.broadcast({
          type: 'text_delta',
          data: { text: chunk, targetId },
        });
      }
    } finally {
      voiceQueue?.end();
    }
    // Fire and forget — TTS playback finishes asynchronously and emits
    // audio_end on the SSE stream when done.
    voiceQueue?.flush();
    return fullText;
  }

  /**
   * Open a voice tee for this turn. Returns null when voice is disabled
   * or auto-speak is off. Audio frames are base64-encoded and broadcast
   * as `audio_chunk` SSE events; an `audio_end` event closes the turn.
   *
   * Note: this is invoked per stream() call. The underlying VoiceManager
   * keeps its TTS WebSocket warm across calls so there's no reconnect cost.
   */
  private async openVoiceQueue(targetId?: string): Promise<{
    push(delta: string): void;
    end(): void;
    flush(): void;
  } | null> {
    let mgr: import('../voice/index.js').VoiceManager | null = null;
    try {
      const mod = await import('../voice/index.js');
      mgr = mod.getVoiceManager();
    } catch {
      return null;
    }
    const status = mgr.getStatus();
    if (status.state !== 'ready' && status.state !== 'speaking') return null;

    const { loadConfig } = await import('../utils/config.js');
    if (loadConfig().voice?.tts?.autoSpeakReplies === false) return null;

    const buffer: string[] = [];
    let producerDone = false;
    let waiter: (() => void) | null = null;

    const iterator: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (true) {
            if (buffer.length > 0) return { value: buffer.shift()!, done: false };
            if (producerDone) return { value: undefined as unknown as string, done: true };
            await new Promise<void>((resolve) => { waiter = resolve; });
          }
        },
      }),
    };

    const self = this;
    return {
      push(delta: string) {
        if (!delta) return;
        buffer.push(delta);
        if (waiter) { const w = waiter; waiter = null; w(); }
      },
      end() {
        producerDone = true;
        if (waiter) { const w = waiter; waiter = null; w(); }
      },
      flush() {
        // Tap the audio frames as they emerge from the TTS provider and
        // broadcast each one to all connected SSE clients. We use the
        // public `pipeTTSToWeb` helper on VoiceManager (added below).
        void self.pipeTTSToSSE(mgr!, iterator, targetId).catch(() => {
          // logged inside speakStream / pipeTTSToSSE
        });
      },
    };
  }

  /**
   * Run a TTS stream and forward each audio frame to SSE clients as a
   * base64-encoded `audio_chunk` event. Emits `audio_end` when complete
   * (success, abort, or error). Sample rate / channels are reported per
   * chunk so the browser-side decoder can configure its AudioContext.
   */
  async pipeTTSToSSE(
    mgr: import('../voice/index.js').VoiceManager,
    textIter: AsyncIterable<string>,
    targetId?: string,
  ): Promise<void> {
    // We re-implement the speakStream pipeline inline so we can intercept
    // frames before they hit the (CLI-only) PlaybackSink. The provider
    // chain + SentenceBuffer logic lives in the registry / buffering
    // modules; we just compose them here.
    const { pickReadyTTS } = await import('../voice/tts/registry.js');
    const { SentenceBuffer } = await import('../voice/buffering.js');
    const { loadConfig } = await import('../utils/config.js');

    const tts = await pickReadyTTS();
    if (!tts) {
      this.broadcast({ type: 'audio_end', data: { reason: 'no-provider', targetId } });
      // Drain the producer so it doesn't deadlock.
      for await (const _ of textIter) { /* discard */ }
      return;
    }

    const ac = new AbortController();
    // Wire cancelSpeaking on VoiceManager to abort us if user interrupts.
    mgr.on('state', (e: { from: string; to: string }) => {
      if (e.to === 'ready' && !ac.signal.aborted) ac.abort();
    });

    const buffer = new SentenceBuffer({
      normalize: loadConfig().voice?.tts?.normalize !== false,
    });
    const chunkIter = pumpSentenceChunksForWeb(buffer, textIter, ac.signal);

    try {
      let chunkIdx = 0;
      for await (const frame of tts.synthesizeStream(chunkIter, { signal: ac.signal })) {
        if (ac.signal.aborted) break;
        this.broadcast({
          type: 'audio_chunk',
          data: {
            // base64-encoded raw PCM s16le
            pcm: frame.pcm.toString('base64'),
            sampleRate: frame.sampleRate,
            channels: frame.channels,
            seq: chunkIdx++,
            targetId,
          },
        });
      }
    } catch (err) {
      logger.warn({ err }, 'web.voice.pipeTTSToSSE error');
      this.broadcast({ type: 'audio_end', data: { reason: 'error', error: String(err), targetId } });
      return;
    }
    this.broadcast({
      type: 'audio_end',
      data: { reason: ac.signal.aborted ? 'aborted' : 'done', targetId },
    });
  }

  /** Broadcast a transcript delta from a /api/voice/transcribe stream. */
  broadcastTranscript(text: string, isFinal: boolean, targetId?: string): void {
    this.broadcast({
      type: isFinal ? 'transcript_final' : 'transcript_partial',
      data: { text, targetId },
    });
  }

  async typing(_targetId?: string): Promise<void> {
    this.broadcast({ type: 'thinking', data: { targetId: _targetId } });
  }

  async askPermission(prompt: string, _targetId?: string): Promise<string> {
    if (this.bypassPermissions) return 'yes';
    const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.broadcast({
      type: 'permission_request',
      data: { id, prompt, options: ['yes', 'always', 'no'], targetId: _targetId },
    });

    return new Promise((resolve) => {
      const yesKey = `${id}:yes`;
      const alwaysKey = `${id}:always`;
      const noKey = `${id}:no`;
      this.pendingApprovals.set(yesKey, () => resolve('yes'));
      this.pendingApprovals.set(alwaysKey, () => resolve('always'));
      this.pendingApprovals.set(noKey, () => resolve('no'));

      setTimeout(() => {
        this.pendingApprovals.delete(yesKey);
        this.pendingApprovals.delete(alwaysKey);
        this.pendingApprovals.delete(noKey);
        resolve('no');
      }, 120_000);
    });
  }

  async askToContinue(question: string, _targetId?: string): Promise<boolean> {
    if (this.bypassPermissions) return true;
    const id = `loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.broadcast({
      type: 'permission_continue',
      data: { id, question, options: ['yes', 'no'], targetId: _targetId },
    });

    return new Promise((resolve) => {
      const yesKey = `${id}:yes`;
      const noKey = `${id}:no`;
      this.pendingContinues.set(yesKey, () => resolve(true));
      this.pendingContinues.set(noKey, () => resolve(false));

      setTimeout(() => {
        this.pendingContinues.delete(yesKey);
        this.pendingContinues.delete(noKey);
        resolve(false);
      }, 120_000);
    });
  }

  askPermissionMode(): Promise<'allow-all' | 'ask-me'> {
    if (this.bypassPermissions) return Promise.resolve('allow-all');
    const id = `mode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.broadcast({
      type: 'permission_mode',
      data: { id, options: ['ask-me', 'allow-all'] },
    });

    return new Promise((resolve) => {
      const askKey = `${id}:ask-me`;
      const allowKey = `${id}:allow-all`;
      this.pendingPermModes.set(askKey, () => resolve('ask-me'));
      this.pendingPermModes.set(allowKey, () => resolve('allow-all'));

      setTimeout(() => {
        this.pendingPermModes.delete(askKey);
        this.pendingPermModes.delete(allowKey);
        resolve('ask-me');
      }, 120_000);
    });
  }

  sendToolFeedback(toolName: string, args: Record<string, unknown>, targetId?: string): void {
    const channelId = targetId || 'default';
    const step = (this.stepCounter.get(channelId) || 0) + 1;
    this.stepCounter.set(channelId, step);

    const label = Object.keys(args).length > 0
      ? `${toolName}(${Object.entries(args).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '...' : v}`).join(', ')})`
      : toolName;

    this.broadcast({
      type: 'step_start',
      data: { step, tool: toolName, label: String(label), targetId },
    });
  }

  sendStepDone(toolName: string, result: unknown, targetId?: string): void {
    const summary = typeof result === 'string'
      ? result.slice(0, 200)
      : String(result).slice(0, 200);
    this.broadcast({
      type: 'step_done',
      data: { tool: toolName, summary, targetId },
    });
  }

  sendProviderInfo(name: string, model: string, targetId?: string): void {
    this.broadcast({
      type: 'provider',
      data: { name, model, targetId },
    });
  }

  sendLoopWarning(message: string, targetId?: string): void {
    this.broadcast({
      type: 'loop_warning',
      data: { message, targetId },
    });
  }

  sendError(message: string, targetId?: string): void {
    this.broadcast({
      type: 'error',
      data: { message, targetId },
    });
  }

  resetStepCounter(targetId?: string): void {
    const channelId = targetId || 'default';
    this.stepCounter.delete(channelId);
  }

  emitMessage(content: string): void {
    this.emitMessageInThread(content, 'web:default');
  }

  emitMessageInThread(content: string, threadId: string): void {
    if (this.restrictUser) {
      throw new Error('Web user is restricted. Disable restrict mode to continue.');
    }
    const msg: ChannelMessage = {
      id: `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      channelId: threadId,
      channelType: 'web',
      senderId: 'web_user',
      senderName: 'You',
      content,
      timestamp: Date.now(),
    };
    this.emit(msg);
  }

  setBypassPermissions(enabled: boolean): void {
    this.bypassPermissions = enabled;
  }

  setRestrictUser(enabled: boolean): void {
    this.restrictUser = enabled;
  }

  getSettings(): { bypassPermissions: boolean; restrictUser: boolean } {
    return { bypassPermissions: this.bypassPermissions, restrictUser: this.restrictUser };
  }
}

/**
 * Sentence-chunk pump for the web stream variant. Same logic as the one
 * in VoiceManager, replicated here so we can drive a per-request buffer
 * without exporting internal manager state. Kept tiny on purpose — if
 * it diverges meaningfully from the manager version, refactor both to
 * share a helper module.
 */
async function* pumpSentenceChunksForWeb(
  buffer: import('../voice/buffering.js').SentenceBuffer,
  textDeltas: AsyncIterable<string>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const queue: string[] = [];
  let producerDone = false;
  let waiter: (() => void) | null = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

  const tick = setInterval(() => {
    for (const c of buffer.tick()) if (c.text) queue.push(c.text);
    wake();
  }, 50);

  const producer = (async () => {
    try {
      for await (const delta of textDeltas) {
        if (signal.aborted) break;
        for (const c of buffer.push(delta)) if (c.text) queue.push(c.text);
        wake();
      }
    } finally {
      for (const c of buffer.end()) if (c.text) queue.push(c.text);
      producerDone = true;
      wake();
    }
  })();

  try {
    while (true) {
      if (signal.aborted) return;
      while (queue.length > 0) yield queue.shift()!;
      if (producerDone) return;
      await new Promise<void>((resolve) => { waiter = resolve; });
    }
  } finally {
    clearInterval(tick);
    await producer.catch(() => {});
  }
}
