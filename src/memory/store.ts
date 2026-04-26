import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, cpSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MercuryConfig } from '../utils/config.js';
import { getMemoryDir, getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export function migrateLegacyMemory(): void {
  const legacyDir = resolve('memory');
  const newDir = getMemoryDir();
  if (!existsSync(legacyDir) || legacyDir === newDir) return;
  if (!existsSync(join(legacyDir, 'short-term')) && !existsSync(join(legacyDir, 'long-term')) && !existsSync(join(legacyDir, 'episodic')) && !existsSync(join(legacyDir, 'second-brain'))) return;
  logger.info({ from: legacyDir, to: newDir }, 'Migrating memory from legacy ./memory to ~/.mercury/memory');
  mkdirSync(newDir, { recursive: true });
  for (const sub of ['short-term', 'long-term', 'episodic', 'second-brain']) {
    const src = join(legacyDir, sub);
    const dest = join(newDir, sub);
    if (existsSync(src)) {
      cpSync(src, dest, { recursive: true });
    }
  }
  try {
    rmSync(legacyDir, { recursive: true, force: true });
    logger.info('Legacy memory directory removed');
  } catch {
    logger.warn('Could not remove legacy memory directory — please delete ./memory manually');
  }
}

export interface MemoryEntry {
  id: string;
  timestamp: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokenCount?: number;
  reasoning?: string;
  metadata?: Record<string, unknown>;
}

export interface LongTermFact {
  id: string;
  timestamp: number;
  topic: string;
  fact: string;
  source: string;
}

export interface EpisodicEvent {
  id: string;
  timestamp: number;
  type: string;
  summary: string;
  channelType: string;
  metadata?: Record<string, unknown>;
}

export class ShortTermMemory {
  private dir: string;
  private maxMessages: number;
  private conversations: Map<string, MemoryEntry[]> = new Map();

  constructor(config: MercuryConfig) {
    this.dir = join(getMemoryDir(), 'short-term');
    this.maxMessages = config.memory.shortTermMaxMessages;
    mkdirSync(this.dir, { recursive: true });
  }

  add(conversationId: string, entry: MemoryEntry): void {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, this.loadFromDisk(conversationId));
    }
    const messages = this.conversations.get(conversationId)!;
    messages.push(entry);
    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages);
    }
    this.saveToDisk(conversationId, messages);
  }

  getRecent(conversationId: string, count: number = this.maxMessages): MemoryEntry[] {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, this.loadFromDisk(conversationId));
    }
    const messages = this.conversations.get(conversationId)!;
    return messages.slice(-count);
  }

  clear(conversationId: string): void {
    this.conversations.delete(conversationId);
    const filepath = join(this.dir, `${conversationId}.json`);
    if (existsSync(filepath)) unlinkSync(filepath);
  }

  private loadFromDisk(conversationId: string): MemoryEntry[] {
    const filepath = join(this.dir, `${conversationId}.json`);
    if (!existsSync(filepath)) return [];
    try {
      return JSON.parse(readFileSync(filepath, 'utf-8'));
    } catch {
      return [];
    }
  }

  private saveToDisk(conversationId: string, messages: MemoryEntry[]): void {
    const filepath = join(this.dir, `${conversationId}.json`);
    writeFileSync(filepath, JSON.stringify(messages), 'utf-8');
  }
}

export class LongTermMemory {
  private filepath: string;
  private facts: LongTermFact[] = [];

  constructor(config: MercuryConfig) {
    this.filepath = join(getMemoryDir(), 'long-term', 'facts.jsonl');
    mkdirSync(join(getMemoryDir(), 'long-term'), { recursive: true });
    this.load();
  }

  add(fact: Omit<LongTermFact, 'id' | 'timestamp'>): void {
    const entry: LongTermFact = {
      id: generateId(),
      timestamp: Date.now(),
      ...fact,
    };
    this.facts.push(entry);
    appendFileSync(this.filepath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  search(query: string, limit: number = 5): LongTermFact[] {
    const lowerQuery = query.toLowerCase();
    const terms = lowerQuery.split(/\s+/);
    return this.facts
      .filter(f => {
        const text = `${f.topic} ${f.fact}`.toLowerCase();
        return terms.some(t => text.includes(t));
      })
      .slice(-limit);
  }

  getAll(): LongTermFact[] {
    return [...this.facts];
  }

  private load(): void {
    if (!existsSync(this.filepath)) return;
    const lines = readFileSync(this.filepath, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean);
    this.facts = lines
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((f): f is LongTermFact => f !== null);
  }
}

export class EpisodicMemory {
  private filepath: string;
  private events: EpisodicEvent[] = [];

  constructor(config: MercuryConfig) {
    this.filepath = join(getMemoryDir(), 'episodic', 'events.jsonl');
    mkdirSync(join(getMemoryDir(), 'episodic'), { recursive: true });
    this.load();
  }

  record(event: Omit<EpisodicEvent, 'id' | 'timestamp'>): void {
    const entry: EpisodicEvent = {
      id: generateId(),
      timestamp: Date.now(),
      ...event,
    };
    this.events.push(entry);
    appendFileSync(this.filepath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  getRecent(count: number = 20): EpisodicEvent[] {
    return this.events.slice(-count);
  }

  prune(olderThanDays: number = 7): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const before = this.events.length;
    this.events = this.events.filter(e => e.timestamp >= cutoff || e.metadata?.important);
    const removed = before - this.events.length;
    if (removed > 0) {
      writeFileSync(this.filepath, this.events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    }
    return removed;
  }

  private load(): void {
    if (!existsSync(this.filepath)) return;
    const lines = readFileSync(this.filepath, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean);
    this.events = lines
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((e): e is EpisodicEvent => e !== null);
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}