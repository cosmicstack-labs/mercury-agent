import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOARDS_DB_FILE, BOARDS_JSON_FILE, createBoardDB } from './board-db.js';
import { SQLITE_BACKEND_ENV, isSqliteAvailable, resetSqliteDriverForTests } from '../utils/sqlite-driver.js';
import type { Board, BoardContext } from '../types/agent.js';

function board(id: string, updatedAt: number): Board {
  return {
    id,
    name: `Board ${id}`,
    description: '',
    status: 'active',
    cards: [],
    createdAt: updatedAt,
    updatedAt,
  } as unknown as Board;
}

const savedHome = process.env.MERCURY_HOME;
const savedBackend = process.env[SQLITE_BACKEND_ENV];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-board-db-'));
  process.env.MERCURY_HOME = home;
  resetSqliteDriverForTests();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MERCURY_HOME;
  else process.env.MERCURY_HOME = savedHome;
  if (savedBackend === undefined) delete process.env[SQLITE_BACKEND_ENV];
  else process.env[SQLITE_BACKEND_ENV] = savedBackend;
  resetSqliteDriverForTests();
  rmSync(home, { recursive: true, force: true });
});

describe('BoardDB', () => {
  it.skipIf(!isSqliteAvailable())('uses SQLite when an engine is available and round-trips boards and contexts', () => {
    const db = createBoardDB();
    expect(db.kind).toBe('sqlite');
    expect(existsSync(join(home, 'memory', BOARDS_DB_FILE))).toBe(true);

    db.saveBoard(board('b1', 1_000));
    db.saveBoard(board('b2', 2_000));
    db.saveBoard({ ...board('b1', 3_000), name: 'renamed' });
    expect(db.loadAll().map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(db.getBoard('b1')?.name).toBe('renamed');
    expect(db.getBoard('missing')).toBeUndefined();

    const context = { boardId: 'b1', events: [{ type: 'note', at: 1 }] } as unknown as BoardContext;
    db.saveContext('b1', context);
    expect(db.getContext('b1')).toEqual(context);
    expect(db.getContext('b2')).toBeUndefined();

    db.deleteBoard('b1');
    expect(db.getBoard('b1')).toBeUndefined();
    expect(db.getContext('b1')).toBeUndefined();
    expect(db.loadAll().map((b) => b.id)).toEqual(['b2']);

    // A second instance sees the committed state (no in-memory cache).
    const again = createBoardDB();
    expect(again.loadAll().map((b) => b.id)).toEqual(['b2']);
  });

  it('falls back to JSON files when storage is JSON-only', () => {
    process.env[SQLITE_BACKEND_ENV] = 'json';
    resetSqliteDriverForTests();
    const db = createBoardDB();
    expect(db.kind).toBe('json');
    db.saveBoard(board('j1', 10));
    db.saveContext('j1', { boardId: 'j1' } as unknown as BoardContext);
    db.flush();
    expect(existsSync(join(home, 'memory', BOARDS_JSON_FILE))).toBe(true);
    expect(existsSync(join(home, 'memory', BOARDS_DB_FILE))).toBe(false);

    const again = createBoardDB();
    expect(again.loadAll().map((b) => b.id)).toEqual(['j1']);
    expect(again.getContext('j1')).toEqual({ boardId: 'j1' });
  });
});
