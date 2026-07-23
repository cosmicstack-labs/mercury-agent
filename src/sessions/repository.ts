import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getMercuryHome, getMemoryDir } from '../utils/config.js';
import type { ChannelType } from '../types/channel.js';
import type { AppendSessionMessageInput, CreateSessionInput, Session, SessionBinding, SessionMessage } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_PREFIX_RE = /^[0-9a-f]{4,32}$/i;
const ALIAS_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const CHANNEL_TYPES: ChannelType[] = ['cli', 'telegram', 'web', 'internal', 'signal', 'discord', 'slack', 'whatsapp'];
const TITLE_SOURCES: Session['titleSource'][] = ['fallback', 'generated', 'user'];
const SESSION_STATUSES: Session['status'][] = ['active', 'archived', 'deleted'];
const MESSAGE_ROLES: SessionMessage['role'][] = ['user', 'assistant', 'system', 'tool'];
const MESSAGE_KINDS: SessionMessage['kind'][] = ['message', 'command', 'error', 'permission', 'progress', 'tool-call', 'tool-result'];

const ADJECTIVES = ['amber', 'brisk', 'calm', 'clear', 'cosmic', 'eager', 'gentle', 'lucky', 'quiet', 'rapid', 'silver', 'warm'];
const NOUNS = ['comet', 'falcon', 'forest', 'harbor', 'meteor', 'orbit', 'otter', 'planet', 'river', 'rocket', 'signal', 'star'];

interface SessionIndexEntry {
  id: string;
  shortId: string;
  alias: string;
  title: string;
  titleSource: Session['titleSource'];
  createdAt: number;
  updatedAt: number;
  status: Session['status'];
  revision: number;
}

interface SessionIndex {
  version: 1;
  sessions: SessionIndexEntry[];
  bindings: Record<string, string>;
  importedSources: string[];
}

export interface SessionRepositoryOptions {
  rootDir?: string;
  legacyWebChatDir?: string;
  legacyShortTermDir?: string;
  autoMigrate?: boolean;
}

export class SessionResolutionError extends Error {
  constructor(message: string, readonly matches: Array<Pick<Session, 'id' | 'shortId' | 'alias' | 'title'>>) {
    super(message);
    this.name = 'SessionResolutionError';
  }
}

export class SessionRepository {
  readonly rootDir: string;
  private readonly indexPath: string;
  private index: SessionIndex;
  private listeners = new Set<() => void>();

  constructor(options: SessionRepositoryOptions = {}) {
    this.rootDir = options.rootDir ?? join(getMercuryHome(), 'sessions');
    this.indexPath = join(this.rootDir, 'index.json');
    mkdirSync(this.rootDir, { recursive: true });
    this.index = this.loadIndex();
    if (options.autoMigrate !== false) {
      this.importLegacy(options.legacyWebChatDir ?? join(getMercuryHome(), 'web-chat-history'), options.legacyShortTermDir ?? join(getMemoryDir(), 'short-term'));
    }
  }

  create(input: CreateSessionInput = {}): Session {
    const id = (input.id ?? randomUUID()).toLowerCase();
    this.assertUuid(id);
    const existing = this.tryGetExact(id);
    if (existing) {
      if (input.binding) this.bind(existing.id, input.binding.channelType, input.binding.externalConversationId);
      return this.get(existing.id);
    }
    const alias = input.alias ? input.alias.toLowerCase() : this.generateAlias(id);
    this.assertAlias(alias);
    if (this.index.sessions.some((entry) => entry.alias.toLowerCase() === alias)) throw new Error(`Session alias already exists: ${alias}`);
    const now = Date.now();
    const title = input.title?.trim() || 'New session';
    const session: Session = {
      id,
      shortId: id.replaceAll('-', '').slice(0, 8),
      alias,
      title,
      titleSource: input.titleSource ?? (input.title ? 'user' : 'fallback'),
      createdAt: now,
      updatedAt: now,
      status: 'active',
      revision: 1,
      bindings: [],
      messages: [],
    };
    this.writeSession(session);
    this.index.sessions.push(this.toIndexEntry(session));
    this.writeIndex();
    if (input.binding) this.bind(id, input.binding.channelType, input.binding.externalConversationId);
    else this.notifyMutation();
    return this.get(id);
  }

  list(options: { includeArchived?: boolean; includeDeleted?: boolean } = {}): Session[] {
    return this.index.sessions
      .filter((entry) => entry.status === 'active' || (options.includeArchived && entry.status === 'archived') || (options.includeDeleted && entry.status === 'deleted'))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => this.readSession(entry.id));
  }

  get(ref: string): Session {
    const entry = this.resolveEntry(ref);
    return this.readSession(entry.id);
  }

  resolve(ref: string): Session {
    return this.get(ref);
  }

  getByBinding(channelType: ChannelType, externalConversationId: string): Session | null {
    const key = this.bindingKey(channelType, externalConversationId);
    const id = this.index.bindings[key];
    if (!id) return null;
    try {
      return this.get(id);
    } catch {
      return null;
    }
  }

  getOrCreateBound(channelType: ChannelType, externalConversationId: string, canonicalId?: string): Session {
    if (canonicalId) {
      this.assertUuid(canonicalId);
      const adopted = this.create({ id: canonicalId });
      this.bind(adopted.id, channelType, externalConversationId);
      return this.get(adopted.id);
    }
    const bound = this.getByBinding(channelType, externalConversationId);
    return bound?.status === 'active' ? bound : this.create({ binding: { channelType, externalConversationId } });
  }

  bind(sessionRef: string, channelType: ChannelType, externalConversationId: string): Session {
    if (!externalConversationId || externalConversationId.length > 512) throw new Error('Invalid external conversation ID');
    const session = this.get(sessionRef);
    const key = this.bindingKey(channelType, externalConversationId);
    const oldId = this.index.bindings[key];
    const existing = session.bindings.find((binding) => this.bindingKey(binding.channelType, binding.externalConversationId) === key);
    if (oldId === session.id && existing) return session;
    const now = Date.now();
    if (oldId && oldId !== session.id) {
      const old = this.tryGetExact(oldId);
      if (old) {
        old.bindings = old.bindings.filter((binding) => this.bindingKey(binding.channelType, binding.externalConversationId) !== key);
        this.touchAndWrite(old);
      }
    }
    if (existing) existing.updatedAt = now;
    else session.bindings.push({ channelType, externalConversationId, createdAt: now, updatedAt: now });
    this.index.bindings[key] = session.id;
    this.touchAndWrite(session);
    this.writeIndex();
    this.notifyMutation();
    return this.get(session.id);
  }

  appendMessage(sessionRef: string, input: AppendSessionMessageInput): SessionMessage {
    const session = this.get(sessionRef);
    if (!input.content || typeof input.content !== 'string') throw new Error('Message content is required');
    if (input.externalMessageId) {
      const existing = session.messages.find((message) => message.externalMessageId === input.externalMessageId);
      if (existing) return existing;
    }
    if (input.id) {
      this.assertUuid(input.id);
      const existing = session.messages.find((message) => message.id === input.id);
      if (existing) return existing;
    }
    const message: SessionMessage = {
      id: (input.id ?? randomUUID()).toLowerCase(),
      sessionId: session.id,
      role: input.role,
      kind: input.kind ?? 'message',
      content: input.content,
      timestamp: input.timestamp ?? Date.now(),
      sequence: (session.messages.at(-1)?.sequence ?? 0) + 1,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.tokenCount !== undefined ? { tokenCount: input.tokenCount } : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
    };
    this.assertUuid(message.id);
    session.messages.push(message);
    if (session.messages.length === 1 && message.role === 'user' && session.titleSource === 'fallback') {
      session.title = this.fallbackTitle(message.content);
    }
    this.touchAndWrite(session, message.timestamp);
    this.writeIndex();
    this.notifyMutation();
    return message;
  }

  updateTitle(ref: string, title: string, titleSource: Session['titleSource'] = 'user'): Session {
    const normalized = title.replace(/\s+/g, ' ').trim();
    if (!normalized) throw new Error('Session title is required');
    if (normalized.length > 120) throw new Error('Session title must be 120 characters or fewer');
    const session = this.get(ref);
    if (session.title === normalized && session.titleSource === titleSource) return session;
    session.title = normalized;
    session.titleSource = titleSource;
    this.touchAndWrite(session);
    this.writeIndex();
    this.notifyMutation();
    return this.get(session.id);
  }

  archive(ref: string): Session {
    const session = this.get(ref);
    if (session.status !== 'archived') {
      session.status = 'archived';
      this.touchAndWrite(session);
      this.writeIndex();
      this.notifyMutation();
    }
    return this.get(session.id);
  }

  markDeleted(ref: string): Session {
    const session = this.get(ref);
    if (session.status !== 'deleted') {
      session.status = 'deleted';
      session.messages = [];
      session.bindings = [];
      for (const [key, id] of Object.entries(this.index.bindings)) {
        if (id === session.id) delete this.index.bindings[key];
      }
      this.touchAndWrite(session);
      this.writeIndex();
      this.notifyMutation();
    }
    return this.get(session.id);
  }

  deletePermanently(ref: string): Session {
    const session = this.get(ref);
    const previousSessions = this.index.sessions;
    const previousBindings = this.index.bindings;
    this.index.sessions = this.index.sessions.filter((entry) => entry.id !== session.id);
    this.index.bindings = Object.fromEntries(
      Object.entries(this.index.bindings).filter(([, id]) => id !== session.id),
    );
    try {
      // Publish the index first so readers can never resolve a removed session file.
      this.writeIndex();
    } catch (error) {
      this.index.sessions = previousSessions;
      this.index.bindings = previousBindings;
      throw error;
    }
    const path = join(this.rootDir, `${session.id}.json`);
    if (existsSync(path)) unlinkSync(path);
    this.notifyMutation();
    return session;
  }

  purgeDeleted(sessionIds: string[]): void {
    for (const id of new Set(sessionIds)) {
      const entry = this.index.sessions.find((session) => session.id === id);
      if (entry?.status === 'deleted') this.deletePermanently(id);
    }
  }

  dump(): Session[] {
    return this.list({ includeArchived: true, includeDeleted: true });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  importLegacy(webChatDir: string, shortTermDir: string): { sessions: number; messages: number } {
    let sessions = 0;
    let messages = 0;
    for (const [sourceType, dir] of [['web', webChatDir], ['short-term', shortTermDir]] as const) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const source = `${sourceType}:${join(dir, file)}`;
        if (this.index.importedSources.includes(source)) continue;
        try {
          const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as any;
          const records: any[] = sourceType === 'web' ? (Array.isArray(parsed.messages) ? parsed.messages : []) : (Array.isArray(parsed) ? parsed : []);
          const externalId = sourceType === 'web' ? String(parsed.id || basename(file, '.json')) : basename(file, '.json');
          const channelType: ChannelType = sourceType === 'web' ? 'web' : this.legacyChannelType(externalId);
          const session = this.getByBinding(channelType, externalId) ?? this.create({
            title: sourceType === 'web' && parsed.title ? String(parsed.title) : undefined,
            titleSource: sourceType === 'web' && parsed.title ? 'user' : 'fallback',
            binding: { channelType, externalConversationId: externalId },
          });
          if (session.messages.length === 0) sessions++;
          const seen = new Set(session.messages.map((message) => `${message.role}\0${message.content}`));
          for (const record of records) {
            const role = record?.role;
            const content = typeof record?.content === 'string' ? record.content : '';
            if (!['user', 'assistant', 'system', 'tool'].includes(role) || !content) continue;
            const fingerprint = `${role}\0${content}`;
            if (seen.has(fingerprint)) continue;
            this.appendMessage(session.id, {
              role,
              content,
              timestamp: Number(record.timestamp) || Date.now(),
              tokenCount: typeof record.tokenCount === 'number' ? record.tokenCount : undefined,
              reasoning: typeof record.reasoning === 'string' ? record.reasoning : undefined,
              externalMessageId: typeof record.id === 'string' ? `legacy:${source}:${record.id}` : undefined,
              metadata: { importedFrom: source },
            });
            seen.add(fingerprint);
            messages++;
          }
          const imported = this.get(session.id);
          const sourceCreatedAt = Number(parsed.createdAt) || Number(records[0]?.timestamp);
          const sourceUpdatedAt = Number(parsed.updatedAt) || Number(records.at(-1)?.timestamp);
          if (Number.isFinite(sourceCreatedAt)) imported.createdAt = sourceCreatedAt;
          if (Number.isFinite(sourceUpdatedAt)) imported.updatedAt = Math.max(imported.createdAt, sourceUpdatedAt);
          this.writeSession(imported);
          const importedIndex = this.index.sessions.findIndex((entry) => entry.id === imported.id);
          if (importedIndex >= 0) this.index.sessions[importedIndex] = this.toIndexEntry(imported);
          this.index.importedSources.push(source);
          this.writeIndex();
        } catch {
          // A malformed legacy file remains untouched and can be retried after repair.
        }
      }
    }
    return { sessions, messages };
  }

  private resolveEntry(rawRef: string): SessionIndexEntry {
    const ref = rawRef.trim();
    if (!ref || ref.length > 128) throw new Error('Invalid session reference');
    if (UUID_RE.test(ref)) {
      const exact = this.index.sessions.find((entry) => entry.id === ref.toLowerCase());
      if (!exact) throw new Error(`Session not found: ${ref}`);
      return exact;
    }
    const compact = ref.replaceAll('-', '').toLowerCase();
    if (ID_PREFIX_RE.test(compact)) {
      const idMatches = this.index.sessions.filter((entry) => entry.id.replaceAll('-', '').startsWith(compact));
      if (idMatches.length === 1) return idMatches[0];
      if (idMatches.length > 1) throw this.ambiguous(ref, idMatches);
    }
    const exactAlias = this.index.sessions.find((entry) => entry.alias === ref);
    if (exactAlias) return exactAlias;
    const aliasMatches = this.index.sessions.filter((entry) => entry.alias.toLowerCase().startsWith(ref.toLowerCase()));
    if (aliasMatches.length === 1) return aliasMatches[0];
    if (aliasMatches.length > 1) throw this.ambiguous(ref, aliasMatches);
    throw new Error(`Session not found: ${ref}`);
  }

  private ambiguous(ref: string, entries: SessionIndexEntry[]): SessionResolutionError {
    const matches = entries.map(({ id, shortId, alias, title }) => ({ id, shortId, alias, title }));
    return new SessionResolutionError(`Ambiguous session reference "${ref}": ${matches.map((match) => `${match.alias} (${match.shortId})`).join(', ')}`, matches);
  }

  private generateAlias(id: string): string {
    const seed = Number.parseInt(id.replaceAll('-', '').slice(0, 8), 16);
    for (let offset = 0; offset < ADJECTIVES.length * NOUNS.length; offset++) {
      const alias = `${ADJECTIVES[(seed + offset) % ADJECTIVES.length]}-${NOUNS[(Math.floor(seed / ADJECTIVES.length) + offset) % NOUNS.length]}`;
      if (!this.index.sessions.some((entry) => entry.alias === alias)) return alias;
    }
    return `session-${id.replaceAll('-', '').slice(0, 8)}`;
  }

  private fallbackTitle(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized || 'New session';
  }

  private touchAndWrite(session: Session, timestamp = Date.now()): void {
    session.updatedAt = Math.max(session.updatedAt, timestamp);
    session.revision++;
    this.writeSession(session);
    const index = this.index.sessions.findIndex((entry) => entry.id === session.id);
    if (index >= 0) this.index.sessions[index] = this.toIndexEntry(session);
  }

  private toIndexEntry(session: Session): SessionIndexEntry {
    const { id, shortId, alias, title, titleSource, createdAt, updatedAt, status, revision } = session;
    return { id, shortId, alias, title, titleSource, createdAt, updatedAt, status, revision };
  }

  private loadIndex(): SessionIndex {
    let parsed: unknown;
    if (existsSync(this.indexPath)) {
      try {
        parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      } catch {
        parsed = undefined;
      }
    }

    const sessionFiles = this.sessionFileNames();
    if (this.isValidIndex(parsed, sessionFiles)) return parsed;
    if (!existsSync(this.indexPath) && sessionFiles.length === 0) return this.emptyIndex();

    if (existsSync(this.indexPath)) this.quarantine(this.indexPath);
    const sessions: Session[] = [];
    for (const file of sessionFiles) {
      const path = join(this.rootDir, file);
      try {
        const session = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!this.isValidSession(session, basename(file, '.json'))) throw new Error('Invalid session');
        sessions.push(session);
      } catch {
        this.quarantine(path);
      }
    }
    sessions.sort((a, b) => a.id.localeCompare(b.id));
    const validIds = new Set(sessions.map((session) => session.id));
    const bindings: Record<string, string> = {};
    const recoveredBindings = this.recordValue(parsed, 'bindings');
    if (recoveredBindings) {
      for (const key of Object.keys(recoveredBindings).sort()) {
        const id = recoveredBindings[key];
        if (typeof id === 'string' && validIds.has(id) && this.isValidBindingKey(key)) bindings[key] = id;
      }
    }
    for (const session of sessions) {
      for (const binding of session.bindings) {
        const key = this.bindingKey(binding.channelType, binding.externalConversationId);
        bindings[key] ??= session.id;
      }
    }
    const importedSources = this.arrayValue(parsed, 'importedSources')?.filter((source): source is string => typeof source === 'string') ?? [];
    const recovered: SessionIndex = { version: 1, sessions: sessions.map((session) => this.toIndexEntry(session)), bindings, importedSources };
    this.index = recovered;
    this.writeIndex();
    return recovered;
  }

  private readSession(id: string): Session {
    this.assertUuid(id);
    return JSON.parse(readFileSync(join(this.rootDir, `${id}.json`), 'utf8')) as Session;
  }

  private tryGetExact(id: string): Session | null {
    if (!this.index.sessions.some((entry) => entry.id === id.toLowerCase())) return null;
    return this.readSession(id.toLowerCase());
  }

  private writeSession(session: Session): void {
    this.atomicWrite(join(this.rootDir, `${session.id}.json`), session);
  }

  private writeIndex(): void {
    this.atomicWrite(this.indexPath, this.index);
  }

  private atomicWrite(path: string, value: unknown): void {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  }

  private emptyIndex(): SessionIndex {
    return { version: 1, sessions: [], bindings: {}, importedSources: [] };
  }

  private sessionFileNames(): string[] {
    return readdirSync(this.rootDir)
      .filter((file) => file.endsWith('.json') && UUID_RE.test(basename(file, '.json')))
      .sort();
  }

  private quarantine(path: string): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let destination: string;
    do {
      destination = `${path}.invalid-${timestamp}-${randomUUID()}`;
    } while (existsSync(destination));
    renameSync(path, destination);
  }

  private isValidIndex(value: unknown, sessionFiles: string[]): value is SessionIndex {
    if (!this.isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions) || !this.isRecord(value.bindings)
      || !Array.isArray(value.importedSources) || !value.importedSources.every((source) => typeof source === 'string')) return false;
    const fileIds = sessionFiles.map((file) => basename(file, '.json'));
    const entryIds: string[] = [];
    for (const entry of value.sessions) {
      if (!this.isValidIndexEntry(entry)) return false;
      entryIds.push(entry.id);
      try {
        const session = JSON.parse(readFileSync(join(this.rootDir, `${entry.id}.json`), 'utf8')) as unknown;
        if (!this.isValidSession(session, entry.id)) return false;
        const canonicalEntry = this.toIndexEntry(session);
        if (Object.entries(canonicalEntry).some(([key, value]) => entry[key as keyof SessionIndexEntry] !== value)) return false;
      } catch {
        return false;
      }
    }
    if (entryIds.length !== fileIds.length || [...new Set(entryIds)].sort().join('\0') !== fileIds.join('\0')) return false;
    return Object.entries(value.bindings).every(([key, id]) => typeof id === 'string' && entryIds.includes(id) && this.isValidBindingKey(key));
  }

  private isValidIndexEntry(value: unknown): value is SessionIndexEntry {
    return this.isRecord(value)
      && typeof value.id === 'string' && UUID_RE.test(value.id) && value.id === value.id.toLowerCase()
      && typeof value.shortId === 'string' && value.shortId === value.id.replaceAll('-', '').slice(0, 8)
      && typeof value.alias === 'string' && ALIAS_RE.test(value.alias) && value.alias.length <= 64
      && typeof value.title === 'string'
      && TITLE_SOURCES.includes(value.titleSource as Session['titleSource'])
      && this.isFiniteNumber(value.createdAt) && this.isFiniteNumber(value.updatedAt)
      && SESSION_STATUSES.includes(value.status as Session['status'])
      && Number.isInteger(value.revision) && (value.revision as number) >= 1;
  }

  private isValidSession(value: unknown, expectedId: string): value is Session {
    if (!this.isRecord(value) || !this.isValidIndexEntry(value) || value.id !== expectedId
      || !Array.isArray(value.bindings) || !Array.isArray(value.messages)) return false;
    if (!value.bindings.every((binding) => this.isValidBinding(binding))) return false;
    return value.messages.every((message) => this.isValidMessage(message, value.id));
  }

  private isValidBinding(value: unknown): value is SessionBinding {
    return this.isRecord(value)
      && CHANNEL_TYPES.includes(value.channelType as ChannelType)
      && typeof value.externalConversationId === 'string' && value.externalConversationId.length > 0 && value.externalConversationId.length <= 512
      && this.isFiniteNumber(value.createdAt) && this.isFiniteNumber(value.updatedAt);
  }

  private isValidMessage(value: unknown, sessionId: string): value is SessionMessage {
    return this.isRecord(value)
      && typeof value.id === 'string' && UUID_RE.test(value.id)
      && value.sessionId === sessionId
      && MESSAGE_ROLES.includes(value.role as SessionMessage['role'])
      && MESSAGE_KINDS.includes(value.kind as SessionMessage['kind'])
      && typeof value.content === 'string'
      && this.isFiniteNumber(value.timestamp)
      && Number.isInteger(value.sequence) && (value.sequence as number) >= 1
      && (value.metadata === undefined || this.isRecord(value.metadata))
      && (value.tokenCount === undefined || this.isFiniteNumber(value.tokenCount))
      && (value.reasoning === undefined || typeof value.reasoning === 'string')
      && (value.externalMessageId === undefined || typeof value.externalMessageId === 'string');
  }

  private isValidBindingKey(key: string): boolean {
    const separator = key.indexOf('\0');
    return separator > 0
      && CHANNEL_TYPES.includes(key.slice(0, separator) as ChannelType)
      && key.slice(separator + 1).length > 0
      && key.slice(separator + 1).length <= 512;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private recordValue(value: unknown, key: string): Record<string, unknown> | undefined {
    return this.isRecord(value) && this.isRecord(value[key]) ? value[key] : undefined;
  }

  private arrayValue(value: unknown, key: string): unknown[] | undefined {
    return this.isRecord(value) && Array.isArray(value[key]) ? value[key] : undefined;
  }

  private isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  private notifyMutation(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Persistence is authoritative; observers must never fail local writes.
      }
    }
  }

  private bindingKey(channelType: ChannelType, externalConversationId: string): string {
    return `${channelType}\0${externalConversationId}`;
  }

  private legacyChannelType(id: string): ChannelType {
    const prefix = id.split(':', 1)[0];
    return ['cli', 'telegram', 'web', 'internal', 'signal', 'discord', 'slack', 'whatsapp'].includes(prefix) ? prefix as ChannelType : 'internal';
  }

  private assertUuid(id: string): void {
    if (!UUID_RE.test(id)) throw new Error(`Invalid UUID: ${id}`);
  }

  private assertAlias(alias: string): void {
    if (!ALIAS_RE.test(alias) || alias.length > 64) throw new Error(`Invalid session alias: ${alias}`);
  }
}
