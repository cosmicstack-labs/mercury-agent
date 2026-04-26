import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedMemoryStore } from './shared-memory-store.js';
import { SharedMemoryDB } from './shared-memory-db.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dbPath: string;
let store: SharedMemoryStore;

const testConfig = {
  identity: { name: 'test', owner: 'test' },
  providers: { default: 'openai' as const, openai: { enabled: false, apiKey: '', model: '' }, anthropic: { enabled: false, apiKey: '', model: '' }, deepseek: { enabled: false, apiKey: '', model: '' }, grok: { enabled: false, apiKey: '', model: '' }, ollamaCloud: { enabled: false, apiKey: '', model: '' }, ollamaLocal: { enabled: false, baseUrl: '', model: '' } },
  channels: { telegram: { enabled: false, botToken: '', admins: [], members: [], pending: [] } },
  memory: { shortTermMaxMessages: 20, secondBrain: { enabled: true, maxRecords: 50 }, sharedMemory: { enabled: true, maxRecords: 100 } },
  relay: { url: 'https://relay.mercuryagent.com', enabled: false },
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
  it('should add a friend request', () => {
    const friend = store.addFriendRequest('123456789', 'testuser', 'Test');
    expect(friend.tgId).toBe('123456789');
    expect(friend.status).toBe('pending');
    expect(friend.username).toBe('testuser');
    expect(friend.firstName).toBe('Test');
  });

  it('should return existing friend on duplicate addFriendRequest', () => {
    store.addFriendRequest('123456789', 'testuser', 'Test');
    const friend = store.addFriendRequest('123456789', 'testuser2', 'Test2');
    expect(friend.tgId).toBe('123456789');
    expect(friend.status).toBe('pending');
  });

  it('should update name fields on duplicate addFriendRequest when previously null', () => {
    store.addFriendRequest('123456789');
    const friend = store.addFriendRequest('123456789', 'testuser', 'Test');
    expect(friend.username).toBe('testuser');
    expect(friend.firstName).toBe('Test');
  });

  it('should approve a friend', () => {
    store.addFriendRequest('123456789', 'testuser', 'Test');
    const approved = store.approveFriend('123456789', ['private']);
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe('approved');
    expect(approved!.negativeTags).toEqual(['private']);
  });

  it('should reject a friend (removes them)', () => {
    store.addFriendRequest('123456789', 'testuser', 'Test');
    const result = store.rejectFriend('123456789');
    expect(result).toBe(true);
    expect(store.getFriend('123456789')).toBeNull();
  });

  it('should revoke a friend', () => {
    store.addFriendRequest('123456789', 'testuser', 'Test');
    store.approveFriend('123456789', []);
    const revoked = store.revokeFriend('123456789');
    expect(revoked).not.toBeNull();
    expect(revoked!.status).toBe('revoked');
  });

  it('should update friend info', () => {
    store.addFriendRequest('123456789');
    const updated = store.updateFriendInfo('123456789', 'newuser', 'NewName');
    expect(updated).not.toBeNull();
    expect(updated!.username).toBe('newuser');
    expect(updated!.firstName).toBe('NewName');
  });

  it('should list all friends', () => {
    store.addFriendRequest('111', 'user1', 'One');
    store.addFriendRequest('222', 'user2', 'Two');
    store.addFriendRequest('333', 'user3', 'Three');
    store.approveFriend('111', []);

    const friends = store.getFriends();
    expect(friends.length).toBe(3);

    const approved = friends.filter(f => f.status === 'approved');
    const pending = friends.filter(f => f.status === 'pending');
    expect(approved.length).toBe(1);
    expect(pending.length).toBe(2);
  });

  it('should check if friend is approved', () => {
    store.addFriendRequest('123456789');
    expect(store.isFriendApproved('123456789')).toBe(false);
    store.approveFriend('123456789', []);
    expect(store.isFriendApproved('123456789')).toBe(true);
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
    store.addFriendRequest('999', 'frienduser', 'Friend');
    store.approveFriend('999', []);
    store.remember([
      { type: 'preference', category: 'food', summary: 'User loves spicy Thai food', confidence: 0.9, importance: 0.7, durability: 0.8 },
    ]);
    const result = store.retrieveForFriend('999', 'food preferences');
    expect(result.blocked).toBe(false);
    expect(result.records.length).toBeGreaterThan(0);
  });

  it('should block access for non-approved friends', () => {
    store.addFriendRequest('888', 'pendinguser', 'Pending');
    const result = store.retrieveForFriend('888', 'food');
    expect(result.blocked).toBe(true);
  });
});