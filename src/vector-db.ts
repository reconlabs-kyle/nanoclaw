/**
 * Per-group vector database.
 *
 * Each registered group owns a sqlite-vec backed DB at
 * `data/sessions/{group_folder}/vectors/vectors.db`. Chunks of the group's
 * markdown memory (daily-memories/*.md, memories.md, user-context.md) are
 * stored here with a Gemini text-embedding-004 vector (768-dim). The
 * container mounts this directory read-only so the agent's memory_search
 * MCP tool can KNN-query it without leaving the container.
 *
 * Isolation is physical — each group's DB is a separate file. Cross-group
 * access is impossible by filesystem construction.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export const EMBEDDING_DIM = 768;

export interface ChunkInput {
  source_path: string;
  section_title: string | null;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  updated_at: string;
  embedding: Float32Array | number[];
}

export interface ChunkRow {
  id: number;
  source_path: string;
  section_title: string | null;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  updated_at: string;
}

export interface SearchHit extends ChunkRow {
  distance: number;
}

export function resolveVectorDbPath(groupFolder: string): string {
  return path.join(DATA_DIR, 'sessions', groupFolder, 'vectors', 'vectors.db');
}

export function openVectorDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT NOT NULL,
      section_title TEXT,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_updated ON chunks(updated_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[${EMBEDDING_DIM}]
    );
  `);
  return db;
}

/**
 * Replace all chunks for a given source_path atomically. Deletes any
 * existing rows (and their vector entries) first, then inserts the new
 * set. Called when the indexer detects a file has changed.
 */
export function replaceChunksForPath(
  db: Database.Database,
  sourcePath: string,
  chunks: ChunkInput[],
): void {
  const deleteChunks = db.prepare('DELETE FROM chunks WHERE source_path = ?');
  const deleteVec = db.prepare(
    'DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE source_path = ?)',
  );
  const insertChunk = db.prepare(`
    INSERT INTO chunks (source_path, section_title, start_line, end_line, content, content_hash, updated_at)
    VALUES (@source_path, @section_title, @start_line, @end_line, @content, @content_hash, @updated_at)
  `);
  const insertVec = db.prepare(
    'INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)',
  );

  const tx = db.transaction((items: ChunkInput[]) => {
    // Delete vec rows first (while chunk ids still exist for the subquery)
    deleteVec.run(sourcePath);
    deleteChunks.run(sourcePath);
    for (const c of items) {
      const info = insertChunk.run({
        source_path: c.source_path,
        section_title: c.section_title,
        start_line: c.start_line,
        end_line: c.end_line,
        content: c.content,
        content_hash: c.content_hash,
        updated_at: c.updated_at,
      });
      // vec0 virtual table's PRIMARY KEY accepts only strict integers.
      // BigInt avoids better-sqlite3's auto-detection landing on REAL.
      const chunkId = BigInt(info.lastInsertRowid);
      const vec =
        c.embedding instanceof Float32Array
          ? c.embedding
          : Float32Array.from(c.embedding);
      insertVec.run(chunkId, Buffer.from(vec.buffer));
    }
  });
  tx(chunks);
}

/**
 * Delete all chunks for a source (when a source file was removed).
 */
export function deleteChunksForPath(
  db: Database.Database,
  sourcePath: string,
): void {
  const tx = db.transaction(() => {
    db.prepare(
      'DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE source_path = ?)',
    ).run(sourcePath);
    db.prepare('DELETE FROM chunks WHERE source_path = ?').run(sourcePath);
  });
  tx();
}

/**
 * Return the set of content hashes currently stored for a given source.
 * Used by the indexer to skip unchanged files without rebuilding.
 */
export function getHashesForPath(
  db: Database.Database,
  sourcePath: string,
): string[] {
  const rows = db
    .prepare(
      'SELECT content_hash FROM chunks WHERE source_path = ? ORDER BY start_line',
    )
    .all(sourcePath) as { content_hash: string }[];
  return rows.map((r) => r.content_hash);
}

/**
 * Return all source_paths currently indexed (for orphan detection).
 */
export function listIndexedSources(db: Database.Database): string[] {
  const rows = db.prepare('SELECT DISTINCT source_path FROM chunks').all() as {
    source_path: string;
  }[];
  return rows.map((r) => r.source_path);
}

/**
 * KNN search. Returns top-k hits with distance (lower = more similar under L2).
 */
export function knnSearch(
  db: Database.Database,
  queryEmbedding: Float32Array | number[],
  k: number,
): SearchHit[] {
  const vec =
    queryEmbedding instanceof Float32Array
      ? queryEmbedding
      : Float32Array.from(queryEmbedding);
  const rows = db
    .prepare(
      `
      SELECT c.id, c.source_path, c.section_title, c.start_line, c.end_line,
             c.content, c.content_hash, c.updated_at, v.distance
        FROM vec_chunks v
        JOIN chunks c ON c.id = v.chunk_id
       WHERE v.embedding MATCH ?
         AND k = ?
       ORDER BY v.distance
      `,
    )
    .all(Buffer.from(vec.buffer), k) as (ChunkRow & { distance: number })[];
  return rows;
}

export interface VectorDbStats {
  chunkCount: number;
  sourceCount: number;
  sizeBytes: number;
}

export function statsFor(db: Database.Database, dbPath: string): VectorDbStats {
  const c = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as {
    n: number;
  };
  const s = db
    .prepare('SELECT COUNT(DISTINCT source_path) AS n FROM chunks')
    .get() as { n: number };
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(dbPath).size;
  } catch (err) {
    logger.debug({ dbPath, err }, 'vector-db stat failed');
  }
  return { chunkCount: c.n, sourceCount: s.n, sizeBytes };
}
