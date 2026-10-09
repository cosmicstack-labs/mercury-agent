import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SQLITE_BACKEND_ENV,
  SQLITE_BACKEND_PRIORITY,
  describeSqliteBackend,
  getSqliteBackend,
  isSqliteAvailable,
  nodeSupportsBuiltinSqlite,
  openSqlite,
  resetSqliteDriverForTests,
  type SqliteBackendName,
  type SqliteDatabase,
} from './sqlite-driver.js';

// Which engines this process can actually load. Under Node 20 that is
// better-sqlite3 only; under Node >= 22.13 better-sqlite3 usually fails its
// ABI check (compiled for another major) and node:sqlite takes over; under
// Bun it is bun:sqlite.
const loadable = SQLITE_BACKEND_PRIORITY.filter((name) => {
  const db = openSqlite(':memory:', { backend: name });
  if (!db) return false;
  db.close();
  return true;
});

const tempDirs: string[] = [];
function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-sqlite-driver-'));
  tempDirs.push(dir);
  return join(dir, name);
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('sqlite-driver selection', () => {
  const savedEnv = process.env[SQLITE_BACKEND_ENV];
  beforeEach(() => resetSqliteDriverForTests());
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[SQLITE_BACKEND_ENV];
    else process.env[SQLITE_BACKEND_ENV] = savedEnv;
    resetSqliteDriverForTests();
  });

  it('reports at least one loadable engine in the test environment', () => {
    expect(loadable.length).toBeGreaterThan(0);
  });

  it('picks the highest-priority loadable backend', () => {
    delete process.env[SQLITE_BACKEND_ENV];
    expect(getSqliteBackend()).toBe(loadable[0]);
    expect(isSqliteAvailable()).toBe(true);
    const report = describeSqliteBackend();
    expect(report.backend).toBe(loadable[0]);
    expect(report.candidates.find((c) => c.name === loadable[0])?.status).toBe('active');
    expect(report.candidates.map((c) => c.name)).toEqual([...SQLITE_BACKEND_PRIORITY]);
  });

  it('honours MERCURY_SQLITE_BACKEND=json (storage is JSON-only)', () => {
    process.env[SQLITE_BACKEND_ENV] = 'json';
    expect(getSqliteBackend()).toBeNull();
    expect(isSqliteAvailable()).toBe(false);
    expect(openSqlite(':memory:')).toBeNull();
    expect(describeSqliteBackend().override).toBe('json');
  });

  it('honours MERCURY_SQLITE_BACKEND=<engine> and reports an unloadable one as unavailable', () => {
    const unloadable = SQLITE_BACKEND_PRIORITY.find((name) => !loadable.includes(name));
    if (!unloadable) return; // every engine loads here; nothing to assert
    process.env[SQLITE_BACKEND_ENV] = unloadable;
    expect(getSqliteBackend()).toBeNull();
    const report = describeSqliteBackend();
    expect(report.override).toBe(unloadable);
    const candidate = report.candidates.find((c) => c.name === unloadable);
    expect(candidate?.status).toBe('unavailable');
    expect(candidate?.reason).toBeTruthy();
  });

  it('probeAll reports every candidate with a status', () => {
    delete process.env[SQLITE_BACKEND_ENV];
    const report = describeSqliteBackend({ probeAll: true });
    for (const candidate of report.candidates) {
      expect(['active', 'available', 'unavailable']).toContain(candidate.status);
      if (candidate.status === 'unavailable') expect(candidate.reason).toBeTruthy();
      else expect(candidate.sqliteVersion).toMatch(/^\d+\.\d+/);
    }
  });

  it('gates node:sqlite on Node >= 22.5', () => {
    expect(nodeSupportsBuiltinSqlite('20.20.2')).toBe(false);
    expect(nodeSupportsBuiltinSqlite('22.4.1')).toBe(false);
    expect(nodeSupportsBuiltinSqlite('22.5.0')).toBe(true);
    expect(nodeSupportsBuiltinSqlite('22.23.2')).toBe(true);
    expect(nodeSupportsBuiltinSqlite('24.0.0')).toBe(true);
  });
});

for (const backend of SQLITE_BACKEND_PRIORITY) {
  describe.skipIf(!loadable.includes(backend))(`sqlite-driver contract [${backend}]`, () => {
    let db: SqliteDatabase;
    beforeEach(() => {
      const opened = openSqlite(tempFile('contract.db'), { backend: backend as SqliteBackendName });
      if (!opened) throw new Error(`${backend} did not open`);
      db = opened;
      db.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          n INTEGER NOT NULL DEFAULT 0,
          f REAL,
          s TEXT,
          note TEXT DEFAULT '[]'
        );
      `);
    });
    afterEach(() => db.close());

    it('exposes its backend name, path and open state', () => {
      expect(db.backend).toBe(backend);
      expect(existsSync(db.path)).toBe(true);
      expect(db.open).toBe(true);
    });

    it('binds positional varargs and returns changes/lastInsertRowid from run()', () => {
      const result = db.prepare('INSERT INTO items (id, n, f, s) VALUES (?, ?, ?, ?)').run('a', 1, 1.5, 'x');
      expect(result.changes).toBe(1);
      expect(Number(result.lastInsertRowid)).toBe(1);
      expect(db.prepare('SELECT * FROM items WHERE id = ?').get('a')).toEqual({ id: 'a', n: 1, f: 1.5, s: 'x', note: '[]' });
    });

    it('binds one bare-keyed object to @name placeholders', () => {
      db.prepare('INSERT INTO items (id, n, f, s) VALUES (@id, @n, @f, @s)').run({ id: 'b', n: 2, f: null, s: null });
      expect(db.prepare('SELECT id, n, f, s FROM items WHERE id = @id').get({ id: 'b' })).toEqual({ id: 'b', n: 2, f: null, s: null });
    });

    it('ignores extra named keys and throws on missing ones', () => {
      db.prepare('INSERT INTO items (id, n) VALUES (@id, @n)').run({ id: 'c', n: 3, unused: 'ignored' });
      expect(db.prepare('SELECT n FROM items WHERE id = ?').get('c')).toEqual({ n: 3 });
      expect(() => db.prepare('INSERT INTO items (id, n) VALUES (@id, @n)').run({ id: 'd' })).toThrow(/n/);
    });

    it('does not mistake quoted text for a placeholder', () => {
      db.prepare(`INSERT INTO items (id, s) VALUES (@id, 'user@host:$1')`).run({ id: 'q' });
      expect(db.prepare('SELECT s FROM items WHERE id = ?').get('q')).toEqual({ s: 'user@host:$1' });
    });

    it('binds undefined as NULL', () => {
      db.prepare('INSERT INTO items (id, f) VALUES (?, ?)').run('u', undefined);
      expect(db.prepare('SELECT f FROM items WHERE id = ?').get('u')).toEqual({ f: null });
      db.prepare('INSERT INTO items (id, f) VALUES (@id, @f)').run({ id: 'v', f: undefined });
      expect(db.prepare('SELECT f FROM items WHERE id = ?').get('v')).toEqual({ f: null });
    });

    it('returns undefined from get() on a miss and [] from all()', () => {
      expect(db.prepare('SELECT * FROM items WHERE id = ?').get('nope')).toBeUndefined();
      expect(db.prepare('SELECT * FROM items WHERE id = ?').all('nope')).toEqual([]);
    });

    it('returns ordinary objects whose spread / JSON round-trip works', () => {
      db.prepare('INSERT INTO items (id, n) VALUES (?, ?)').run('r', 7);
      const row = db.prepare('SELECT id, n FROM items WHERE id = ?').get<{ id: string; n: number }>('r')!;
      expect({ ...row }).toEqual({ id: 'r', n: 7 });
      expect(JSON.parse(JSON.stringify(row))).toEqual({ id: 'r', n: 7 });
      expect(Object.keys(row)).toEqual(['id', 'n']);
    });

    it('all() preserves ORDER BY and LIMIT with mixed positional params', () => {
      for (const [id, n] of [['x1', 3], ['x2', 1], ['x3', 2]] as const) {
        db.prepare('INSERT INTO items (id, n) VALUES (?, ?)').run(id, n);
      }
      const rows = db.prepare('SELECT id FROM items WHERE n > ? ORDER BY n DESC LIMIT ?').all<{ id: string }>(0, 2);
      expect(rows.map((r) => r.id)).toEqual(['x1', 'x3']);
    });

    it('reports changes for UPDATE / DELETE', () => {
      db.prepare('INSERT INTO items (id, n) VALUES (?, ?)').run('m1', 1);
      db.prepare('INSERT INTO items (id, n) VALUES (?, ?)').run('m2', 1);
      expect(db.prepare('UPDATE items SET n = ? WHERE n = ?').run(9, 1).changes).toBe(2);
      expect(db.prepare('DELETE FROM items WHERE n = ?').run(9).changes).toBe(2);
      expect(db.prepare('DELETE FROM items WHERE n = ?').run(9).changes).toBe(0);
    });

    it('supports COUNT(*) AS count and GROUP BY aggregates as numbers', () => {
      db.prepare('INSERT INTO items (id, s) VALUES (?, ?)').run('g1', 'a');
      db.prepare('INSERT INTO items (id, s) VALUES (?, ?)').run('g2', 'a');
      db.prepare('INSERT INTO items (id, s) VALUES (?, ?)').run('g3', 'b');
      expect(db.prepare('SELECT COUNT(*) AS count FROM items').get<{ count: number }>()!.count).toBe(3);
      const grouped = db.prepare('SELECT s, COUNT(*) AS count FROM items GROUP BY s ORDER BY s').all<{ s: string; count: number }>();
      expect(grouped).toEqual([{ s: 'a', count: 2 }, { s: 'b', count: 1 }]);
      expect(typeof grouped[0].count).toBe('number');
    });

    it('pragma() returns rows and applies settings', () => {
      const mode = db.pragma('journal_mode = WAL');
      expect(Array.isArray(mode)).toBe(true);
      expect(String(mode[0]?.journal_mode).toLowerCase()).toBe('wal');
      expect(db.pragma('foreign_keys = ON')).toEqual([]);
      expect(db.pragma('foreign_keys')[0]).toEqual({ foreign_keys: 1 });
      const columns = db.pragma('table_info(items)') as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toEqual(['id', 'n', 'f', 's', 'note']);
    });

    it('transaction() commits on return and rolls back on throw', () => {
      const value = db.transaction(() => {
        db.prepare('INSERT INTO items (id) VALUES (?)').run('t1');
        return 42;
      });
      expect(value).toBe(42);
      expect(() => db.transaction(() => {
        db.prepare('INSERT INTO items (id) VALUES (?)').run('t2');
        throw new Error('boom');
      })).toThrow('boom');
      expect(db.prepare('SELECT id FROM items ORDER BY id').all()).toEqual([{ id: 't1' }]);
      // Nested transactions use savepoints: inner rollback keeps the outer work.
      db.transaction(() => {
        db.prepare('INSERT INTO items (id) VALUES (?)').run('t3');
        try {
          db.transaction(() => {
            db.prepare('INSERT INTO items (id) VALUES (?)').run('t4');
            throw new Error('inner');
          });
        } catch { /* expected */ }
      });
      expect(db.prepare('SELECT id FROM items ORDER BY id').all()).toEqual([{ id: 't1' }, { id: 't3' }]);
    });

    it('supports FTS5 virtual tables with triggers (the second-brain schema)', () => {
      db.exec(`
        CREATE VIRTUAL TABLE items_fts USING fts5(s, content=items, content_rowid=rowid);
        CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
          INSERT INTO items_fts(rowid, s) VALUES (new.rowid, new.s);
        END;
      `);
      db.prepare('INSERT INTO items (id, s) VALUES (?, ?)').run('f1', 'the quick brown fox');
      db.prepare('INSERT INTO items (id, s) VALUES (?, ?)').run('f2', 'lazy dog');
      const hits = db.prepare(`
        SELECT i.id FROM items i JOIN items_fts fts ON i.rowid = fts.rowid
        WHERE items_fts MATCH ? ORDER BY rank LIMIT ?
      `).all<{ id: string }>('quick OR fox', 10);
      expect(hits).toEqual([{ id: 'f1' }]);
    });

    it('run().changes counts only the statement\'s own rows, not trigger writes', () => {
      // The second-brain schema keeps an FTS5 index in sync with triggers;
      // clearByType()/moveToSubconscious() return `changes` to the caller.
      db.exec(`
        CREATE VIRTUAL TABLE items_fts2 USING fts5(s, content=items, content_rowid=rowid);
        CREATE TRIGGER items_ai2 AFTER INSERT ON items BEGIN
          INSERT INTO items_fts2(rowid, s) VALUES (new.rowid, new.s);
        END;
        CREATE TRIGGER items_au2 AFTER UPDATE ON items BEGIN
          INSERT INTO items_fts2(items_fts2, rowid, s) VALUES ('delete', old.rowid, old.s);
          INSERT INTO items_fts2(rowid, s) VALUES (new.rowid, new.s);
        END;
      `);
      expect(db.prepare('INSERT INTO items (id, s) VALUES (?, ?)').run('c1', 'alpha beta').changes).toBe(1);
      expect(db.prepare('INSERT INTO items (id, s) VALUES (?, ?)').run('c2', 'gamma delta').changes).toBe(1);
      expect(db.prepare('UPDATE items SET n = 1 WHERE n = 0').run().changes).toBe(2);
      expect(db.prepare('UPDATE items SET n = 2 WHERE id = ?').run('nope').changes).toBe(0);
    });

    it('supports ON CONFLICT upserts and INSERT OR REPLACE', () => {
      const upsert = db.prepare(`
        INSERT INTO items (id, n) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET n = excluded.n
      `);
      upsert.run('up', 1);
      upsert.run('up', 2);
      db.prepare('INSERT OR REPLACE INTO items (id, n) VALUES (?, ?)').run('rep', 5);
      db.prepare('INSERT OR REPLACE INTO items (id, n) VALUES (?, ?)').run('rep', 6);
      expect(db.prepare('SELECT id, n FROM items ORDER BY id').all()).toEqual([{ id: 'rep', n: 6 }, { id: 'up', n: 2 }]);
    });

    it('close() is idempotent and flips open', () => {
      db.close();
      expect(db.open).toBe(false);
      expect(() => db.close()).not.toThrow();
    });

    it('persists across reopen of the same file', () => {
      db.prepare('INSERT INTO items (id, n) VALUES (?, ?)').run('p', 1);
      const path = db.path;
      db.close();
      const again = openSqlite(path, { backend: backend as SqliteBackendName })!;
      try {
        expect(again.prepare('SELECT n FROM items WHERE id = ?').get('p')).toEqual({ n: 1 });
      } finally {
        again.close();
      }
    });
  });
}
