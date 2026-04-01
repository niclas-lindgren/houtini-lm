/**
 * SQLite-backed cache for chunk embeddings used by semantic_search.
 *
 * Separate DB file from model-cache.db — no coupling to model profile logic.
 * Uses the same sql.js WASM pattern as model-cache.ts.
 */

import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB_DIR = join(homedir(), '.houtini-lm');
const DB_PATH = join(DB_DIR, 'embed-cache.db');

let db: Database | null = null;

export interface CachedChunk {
  chunk_idx: number;
  content: string;
  vector: number[];
}

export async function initEmbedCache(): Promise<void> {
  if (db) return;

  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    try {
      const buf = readFileSync(DB_PATH);
      db = new SQL.Database(buf);
    } catch {
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      path      TEXT    NOT NULL,
      chunk_idx INTEGER NOT NULL,
      mtime     INTEGER NOT NULL,
      model_id  TEXT    NOT NULL,
      content   TEXT    NOT NULL,
      vector    TEXT    NOT NULL,
      PRIMARY KEY (path, chunk_idx)
    )
  `);

  saveDb();
}

function getDb(): Database {
  if (!db) throw new Error('embed cache not initialized');
  return db;
}

/**
 * Returns all cached chunks for a file if every chunk's mtime matches.
 * Returns null if any chunk is stale or the file has no cached chunks.
 */
export function getCachedChunks(path: string, mtime: number): CachedChunk[] | null {
  const rows = getDb().exec(
    'SELECT chunk_idx, mtime, content, vector FROM chunk_embeddings WHERE path = ? ORDER BY chunk_idx',
    [path],
  );
  if (!rows.length || !rows[0].values.length) return null;

  const chunks: CachedChunk[] = [];
  for (const row of rows[0].values) {
    const [chunk_idx, rowMtime, content, vectorJson] = row as [number, number, string, string];
    if (rowMtime !== mtime) return null; // stale — caller must re-embed
    chunks.push({ chunk_idx, content, vector: JSON.parse(vectorJson) as number[] });
  }
  return chunks;
}

/** Batch-insert chunks for a file, replacing any existing entries. */
export function upsertChunks(
  path: string,
  mtime: number,
  modelId: string,
  chunks: Array<{ chunk_idx: number; content: string; vector: number[] }>,
): void {
  const d = getDb();
  d.run('DELETE FROM chunk_embeddings WHERE path = ?', [path]);
  for (const { chunk_idx, content, vector } of chunks) {
    d.run(
      'INSERT INTO chunk_embeddings (path, chunk_idx, mtime, model_id, content, vector) VALUES (?, ?, ?, ?, ?, ?)',
      [path, chunk_idx, mtime, modelId, content, JSON.stringify(vector)],
    );
  }
}

export function flushEmbedCache(): void {
  saveDb();
}

function saveDb(): void {
  if (!db) return;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    const data = db.export();
    writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    process.stderr.write(`[houtini-lm] Failed to save embed cache: ${err}\n`);
  }
}
