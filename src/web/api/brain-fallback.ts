import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMemoryDir } from '../../utils/config.js';

let sqlJsModule: any = null;
let dbInstance: any = null;
let dbPath: string = '';

async function getDb(): Promise<any> {
  if (dbInstance) return dbInstance;
  dbPath = join(getMemoryDir(), 'second-brain', 'second-brain.db');
  if (!existsSync(dbPath)) return null;
  try {
    if (!sqlJsModule) {
      const initSqlJs = (await import('sql.js')).default;
      const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'static', 'vendor', 'sql-wasm.wasm');
      sqlJsModule = await initSqlJs(existsSync(wasmPath)
        ? { locateFile: (f: string) => existsSync(wasmPath) ? wasmPath : f }
        : undefined);
    }
    const fileBuffer = readFileSync(dbPath);
    dbInstance = new sqlJsModule.Database(fileBuffer);
    return dbInstance;
  } catch {
    return null;
  }
}

export function closeFallbackDb(): void {
  if (dbInstance) {
    try { dbInstance.close(); } catch {}
    dbInstance = null;
  }
}

export interface FallbackMemory {
  id: string;
  type: string;
  summary: string;
  detail: string | null;
  scope: string;
  evidence_kind: string;
  source: string;
  confidence: number;
  importance: number;
  durability: number;
  evidence_count: number;
  dismissed: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
}

function toCamel(r: any): any {
  return {
    id: r.id,
    type: r.type,
    summary: r.summary,
    detail: r.detail || null,
    scope: r.scope,
    evidenceKind: r.evidence_kind,
    source: r.source,
    confidence: r.confidence,
    importance: r.importance,
    durability: r.durability,
    evidenceCount: r.evidence_count,
    dismissed: r.dismissed === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeenAt: r.last_seen_at,
  };
}

export async function fallbackGetStats(): Promise<any> {
  const db = await getDb();
  if (!db) return { total: 0, byType: {}, learningPaused: false, available: false };

  const totalRow: any = db.exec('SELECT COUNT(*) as count FROM memories WHERE dismissed = 0');
  const total = totalRow[0]?.values?.[0]?.[0] || 0;

  const typeRows: any = db.exec("SELECT type, COUNT(*) as count FROM memories WHERE dismissed = 0 GROUP BY type");
  const byType: Record<string, number> = {};
  if (typeRows[0]) {
    for (const row of typeRows[0].values) {
      byType[row[0]] = row[1];
    }
  }

  return { total, byType, learningPaused: false, available: true };
}

export async function fallbackGetMemories(limit: number, offset: number, type?: string, query?: string): Promise<any> {
  const db = await getDb();
  if (!db) return { memories: [], total: 0, available: false };

  let sql: string;
  let params: any[] = [];

  if (query) {
    const tokens = query.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) {
      sql = 'SELECT * FROM memories WHERE dismissed = 0 ORDER BY updated_at DESC LIMIT ? OFFSET ?';
      params = [limit + offset, offset];
    } else {
      const ftsQuery = tokens.join(' OR ');
      try {
        sql = `SELECT m.* FROM memories m JOIN memories_fts fts ON m.rowid = fts.rowid
               WHERE memories_fts MATCH ? AND m.dismissed = 0 ORDER BY rank LIMIT ? OFFSET ?`;
        params = [ftsQuery, limit + offset, offset];
        const rows: any = db.exec(sql, params);
        if (!rows[0] || rows[0].values.length === 0) {
          const likeClauses = tokens.map(() => '(summary LIKE ? OR detail LIKE ?)').join(' OR ');
          const likes = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);
          sql = `SELECT * FROM memories WHERE dismissed = 0 AND (${likeClauses}) ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
          params = [...likes, limit + offset, offset];
        } else {
          const results = rows[0].values.map((v: any[]) => {
            const obj: any = {};
            rows[0].columns.forEach((col: string, i: number) => { obj[col] = v[i]; });
            return toCamel(obj);
          });
          return { memories: results.slice(offset, offset + limit), total: results.length, available: true };
        }
      } catch {
        const likeClauses = tokens.map(() => '(summary LIKE ? OR detail LIKE ?)').join(' OR ');
        const likes = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);
        sql = `SELECT * FROM memories WHERE dismissed = 0 AND (${likeClauses}) ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
        params = [...likes, limit + offset, offset];
      }
    }
  } else if (type) {
    sql = 'SELECT * FROM memories WHERE dismissed = 0 AND type = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params = [type, limit + offset, offset];
  } else {
    sql = 'SELECT * FROM memories WHERE dismissed = 0 ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params = [limit + offset, offset];
  }

  const rows: any = db.exec(sql, params);
  if (!rows[0]) return { memories: [], total: 0, available: true };

  const results = rows[0].values.map((v: any[]) => {
    const obj: any = {};
    rows[0].columns.forEach((col: string, i: number) => { obj[col] = v[i]; });
    return toCamel(obj);
  });

  return { memories: results.slice(offset, offset + limit), total: results.length, available: true };
}

export async function fallbackGetGraph(): Promise<any> {
  const db = await getDb();
  if (!db) return { nodes: [], edges: [], available: false };

  const rows: any = db.exec('SELECT * FROM memories WHERE dismissed = 0 ORDER BY updated_at DESC LIMIT 500');
  if (!rows[0]) return { nodes: [], edges: [], available: true };

  const typeColors: Record<string, string> = {
    identity: '#00d4ff', preference: '#febc2e', goal: '#28c840', project: '#a855f7',
    habit: '#f97316', decision: '#3b82f6', constraint: '#ef4444', relationship: '#ec4899',
    episode: '#6366f1', reflection: '#14b8a6',
  };

  const records = rows[0].values.map((v: any[]) => {
    const obj: any = {};
    rows[0].columns.forEach((col: string, i: number) => { obj[col] = v[i]; });
    return obj;
  });

  const nodes = records.map((r: any) => ({
    id: r.id,
    label: (r.summary || '').length > 60 ? r.summary.slice(0, 57) + '...' : r.summary,
    fullLabel: r.summary,
    type: r.type,
    importance: r.importance,
    confidence: r.confidence,
    color: typeColors[r.type] || '#888888',
    size: Math.max(4, (r.importance || 0.5) * 12),
  }));

  const edges: Array<{ source: string; target: string; type: string }> = [];
  if (records.length <= 200) {
    const summaries = records.map((r: any) => ({
      id: r.id,
      words: (r.summary || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 3),
      type: r.type,
    }));
    for (let i = 0; i < summaries.length; i++) {
      for (let j = i + 1; j < summaries.length; j++) {
        const overlap = summaries[i].words.filter((w: string) => summaries[j].words.includes(w)).length;
        if (overlap >= 2) edges.push({ source: summaries[i].id, target: summaries[j].id, type: 'related' });
      }
    }
  }
  if (edges.length > 500) edges.length = 500;

  return { nodes, edges, available: true };
}