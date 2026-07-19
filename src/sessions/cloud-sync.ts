import type { Session, SessionMessage } from './types.js';
import type { SessionRepository } from './repository.js';
import { logger } from '../utils/logger.js';

export interface SessionSyncConfig {
  apiUrl: string;
  agentId: string;
  token: string;
}

interface SerializedSession extends Pick<Session, 'id' | 'alias' | 'title' | 'titleSource' | 'status' | 'revision'> {
  agentId: string;
  createdAt: string;
  updatedAt: string;
}

interface SerializedMessage extends Omit<SessionMessage, 'timestamp' | 'externalMessageId'> {
  timestamp: string;
}

export interface SessionSyncBatch {
  sessions: SerializedSession[];
  messages: SerializedMessage[];
}

export function buildSessionSyncBatches(agentId: string, sessions: Session[]): SessionSyncBatch[] {
  const batches: SessionSyncBatch[] = [];
  let current: SessionSyncBatch = { sessions: [], messages: [] };

  const flush = () => {
    if (current.sessions.length || current.messages.length) batches.push(current);
    current = { sessions: [], messages: [] };
  };

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const session of sorted) {
    const serializedSession: SerializedSession = {
      id: session.id,
      alias: session.alias,
      title: session.title,
      titleSource: session.titleSource,
      status: session.status,
      revision: session.revision,
      agentId,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
    };
    const messages: SerializedMessage[] = session.messages.map(({ externalMessageId: _, ...message }) => ({
      ...message,
      reasoning: typeof message.reasoning === 'string'
        ? message.reasoning
        : message.reasoning == null
          ? undefined
          : JSON.stringify(message.reasoning),
      timestamp: new Date(message.timestamp).toISOString(),
    }));

    if (messages.length === 0) {
      if (current.sessions.length >= 100) flush();
      current.sessions.push(serializedSession);
      continue;
    }

    let offset = 0;
    while (offset < messages.length) {
      const alreadyIncluded = current.sessions.some((item) => item.id === session.id);
      if (current.messages.length >= 5000 || (!alreadyIncluded && current.sessions.length >= 100)) flush();
      if (!current.sessions.some((item) => item.id === session.id)) current.sessions.push(serializedSession);
      const capacity = 5000 - current.messages.length;
      current.messages.push(...messages.slice(offset, offset + capacity));
      offset += capacity;
      if (current.messages.length >= 5000) flush();
    }
  }
  flush();
  return batches;
}

export class CloudSessionSynchronizer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private dirty = false;
  private active = false;
  private retryMs = 1_000;
  private unsubscribe?: () => void;

  constructor(
    private repository: SessionRepository,
    private getConfig: () => SessionSyncConfig,
    private debounceMs = 1_000,
  ) {}

  start(): void {
    if (this.active) {
      this.requestSync(0);
      return;
    }
    this.active = true;
    if (!this.unsubscribe) this.unsubscribe = this.repository.subscribe(() => this.requestSync());
    this.requestSync(0);
  }

  stop(): void {
    this.active = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isEnabled(): boolean {
    return this.active;
  }

  requestSync(delayMs = this.debounceMs): void {
    if (!this.active) return;
    this.dirty = true;
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, delayMs);
    this.timer.unref?.();
  }

  private async syncNow(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.dirty = false;
    try {
      const config = this.getConfig();
      if (!config.apiUrl || !config.agentId || !config.token) throw new Error('Cloud session sync is not configured');
      const snapshot = this.repository.dump();
      const deletedSessionIds = snapshot.filter((session) => session.status === 'deleted').map((session) => session.id);
      const batches = buildSessionSyncBatches(config.agentId, snapshot);
      let sessionCount = 0;
      let messageCount = 0;
      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}/v1/agents/${encodeURIComponent(config.agentId)}/sessions/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 300);
          throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        sessionCount += batch.sessions.length;
        messageCount += batch.messages.length;
      }
      this.repository.purgeDeleted(deletedSessionIds);
      this.retryMs = 1_000;
      if (batches.length) logger.info({ batches: batches.length, sessions: sessionCount, messages: messageCount }, 'Canonical sessions synced to Mercury Cloud');
    } catch (error) {
      this.dirty = true;
      logger.warn({ err: error instanceof Error ? error.message : String(error), retryMs: this.retryMs }, 'Canonical session sync failed; local sessions remain authoritative');
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 60_000);
      this.running = false;
      if (this.active) this.requestSync(delay);
      return;
    }
    this.running = false;
    if (this.active && this.dirty) this.requestSync();
  }
}
