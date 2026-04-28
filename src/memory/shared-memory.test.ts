import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedMemoryStore } from './shared-memory-store.js';
import { SharedMemoryDB } from './shared-memory-db.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RelayFriendRequest } from '../relay/relay-client.js';

let dbPath: string;
let store: SharedMemoryStore;

const testConfig = {
  identity: { name: 'test', owner: 'test' },
  providers: { default: 'openai' as const, openai: { enabled: false, apiKey: '', model: '' }, anthropic: { enabled: false, apiKey: '', model: '' }, deepseek: { enabled: false, apiKey: '', model: '' }, grok: { enabled: false, apiKey: '', model: '' }, ollamaCloud: { enabled: false, apiKey: '', model: '' }, ollamaLocal: { enabled: false, baseUrl: '', model: '' } },
  channels: { telegram: { enabled: false, botToken: '', admins: [], members: [], pending: [] } },
  memory: { shortTermMaxMessages: 20, secondBrain: { enabled: true, maxRecords: 50 }, sharedMemory: { enabled: true, maxRecords: 100 } },
  relay: { url: 'https://mercury-relay.admin-5cc.workers.dev', enabled: false },
  heartbeat: { intervalMinutes: 60 },
  tokens: { dailyBudget: 1000000 },
} as any;

beforeEach(() => {
  dbPath = join(tmpdir(), `mercury-test-shared-memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const dir = join(dbPath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  store = new SharedMemoryStore(testConfig, 'user:test', dbPath);
});

afterEach(() => {
  store.close();
  try { rmSync(dbPath, { force: true }); } catch {}
  try { rmSync(dbPath.replace('.db', '-wal'), { force: true }); } catch {}
  try { rmSync(dbPath.replace('.db', '-shm'), { force: true }); } catch {}
});

describe('SharedMemoryDB', () => {
  it('should initialize without errors', () => {
    const db = new SharedMemoryDB(dbPath + '-init-test');
    db.init();
    db.close();
  });
});

describe('SharedMemoryStore - Friends', () => {
  const LOCAL_TG_ID = 'me';

  it('should sync friends from relay', () => {
    const relayFriends: RelayFriendRequest[] = [
      { id: 'fr_1', from_tg_id: LOCAL_TG_ID, to_tg_id: '123456789', status: 'pending', negative_tags: null, negative_rules: null, created_at: 1000, approved_at: null, from_username: 'me', from_first_name: 'Me', to_username: 'testuser', to_first_name: 'Test' },
    ];
    store.syncFriendsFromRelay(relayFriends, LOCAL_TG_ID);
    const friends = store.getFriends();
    expect(friends.length).toBe(1);
    expect(friends[0].tgId).toBe('123456789');
    expect(friends[0].status).toBe('pending');
    expect(friends[0].direction).toBe('sent');
    expect(friends[0].username).toBe('testuser');
  });

  it('should upsert friend from relay event', () => {
    store.upsertFriendFromRelayEvent('123456789', 'fr_1', 'received', 'pending', 'testuser', 'Test');
    const friend = store.getFriend('123456789');
    expect(friend).not.toBeNull();
    expect(friend!.tgId).toBe('123456789');
    expect(friend!.status).toBe('pending');
    expect(friend!.username).toBe('testuser');
  });

  it('should approve a friend in cache', () => {
    store.upsertFriendFromRelayEvent('123456789', 'fr_1', 'received', 'pending', 'testuser', 'Test');
    const approved = store.approveFriendInCache('123456789', ['private']);
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe('approved');
    expect(approved!.negativeTags).toEqual(['private']);
  });

  it('should update friend status in cache', () => {
    store.upsertFriendFromRelayEvent('123456789', 'fr_1', 'received', 'pending', 'testuser', 'Test');
    const result = store.updateFriendStatusInCache('123456789', 'rejected');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('rejected');
  });

  it('should remove friend from cache', () => {
    store.upsertFriendFromRelayEvent('123456789', 'fr_1', 'received', 'pending', 'testuser', 'Test');
    const removed = store.removeFriendFromCache('123456789');
    expect(removed).not.toBeNull();
    expect(store.getFriend('123456789')).toBeNull();
  });

  it('should check if friend is approved', () => {
    store.upsertFriendFromRelayEvent('123456789', 'fr_1', 'received', 'pending');
    expect(store.isFriendApproved('123456789')).toBe(false);
    store.approveFriendInCache('123456789', []);
    expect(store.isFriendApproved('123456789')).toBe(true);
  });

  it('should list friends by status', () => {
    store.syncFriendsFromRelay([
      { id: 'fr_1', from_tg_id: LOCAL_TG_ID, to_tg_id: '111', status: 'approved', negative_tags: null, negative_rules: null, created_at: 1000, approved_at: 1001, from_username: 'me', from_first_name: 'Me', to_username: 'user1', to_first_name: 'One' },
      { id: 'fr_2', from_tg_id: '222', to_tg_id: LOCAL_TG_ID, status: 'pending', negative_tags: null, negative_rules: null, created_at: 1002, approved_at: null, from_username: 'user2', from_first_name: 'Two', to_username: 'me', to_first_name: 'Me' },
    ], LOCAL_TG_ID);
    const approved = store.getFriendsByStatus('approved');
    const pending = store.getFriendsByStatus('pending');
    expect(approved.length).toBe(1);
    expect(pending.length).toBe(1);
  });
});

describe('SharedMemoryStore - Memory', () => {
  it('should remember and retrieve memories', () => {
    const records = store.remember([
      { type: 'preference', category: 'food', summary: 'User prefers dark chocolate over milk chocolate', confidence: 0.9, importance: 0.6, durability: 0.8 },
    ]);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].summary).toContain('dark chocolate');
  });

  it('should search memories', () => {
    store.remember([
      { type: 'preference', category: 'food', summary: 'User likes Italian food especially pasta carbonara', confidence: 0.9, importance: 0.7, durability: 0.8 },
    ]);
    const results = store.search('Italian food');
    expect(results.length).toBeGreaterThan(0);
  });

  it('should get summary', () => {
    store.remember([
      { type: 'identity', category: 'name', summary: 'User name is Alice', confidence: 0.95, importance: 0.9, durability: 0.9 },
    ]);
    const summary = store.getSummary();
    expect(summary.total).toBeGreaterThan(0);
  });

  it('should pause and resume learning', () => {
    store.setLearningPaused(true);
    expect(store.isLearningPaused()).toBe(true);
    const records = store.remember([
      { type: 'preference', category: 'test', summary: 'This should not be stored', confidence: 0.9, importance: 0.7, durability: 0.8 },
    ]);
    expect(records.length).toBe(0);
    store.setLearningPaused(false);
    expect(store.isLearningPaused()).toBe(false);
  });

  it('should retrieve relevant memories for a friend', () => {
    store.upsertFriendFromRelayEvent('999', 'fr_999', 'received', 'approved', 'frienduser', 'Friend');
    store.remember([
      { type: 'preference', category: 'food', summary: 'User loves spicy Thai food', confidence: 0.9, importance: 0.7, durability: 0.8 },
    ]);
    const result = store.retrieveForFriend('999', 'food preferences');
    expect(result.blocked).toBe(false);
    expect(result.records.length).toBeGreaterThan(0);
  });

  it('should block access for non-approved friends', () => {
    store.upsertFriendFromRelayEvent('888', 'fr_888', 'received', 'pending', 'pendinguser', 'Pending');
    const result = store.retrieveForFriend('888', 'food');
    expect(result.blocked).toBe(true);
  });
});