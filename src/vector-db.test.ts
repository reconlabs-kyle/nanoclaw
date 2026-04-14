import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  EMBEDDING_DIM,
  deleteChunksForPath,
  getHashesForPath,
  knnSearch,
  listIndexedSources,
  openVectorDb,
  replaceChunksForPath,
  statsFor,
} from './vector-db.js';

function fakeEmbedding(seed: number): Float32Array {
  // Deterministic but distinct: each axis varies with the seed so two
  // different seeds produce vectors that are unambiguously closer/farther.
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    v[i] = Math.sin((i + 1) * seed) * 0.1;
  }
  return v;
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-vecdb-'));
  dbPath = path.join(tmpDir, 'v.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('vector-db', () => {
  it('creates schema and loads sqlite-vec extension', () => {
    const db = openVectorDb(dbPath);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['chunks', 'vec_chunks']),
    );
    db.close();
  });

  it('upserts chunks and can KNN search', () => {
    const db = openVectorDb(dbPath);
    replaceChunksForPath(db, 'daily-memories/2026-04-12.md', [
      {
        source_path: 'daily-memories/2026-04-12.md',
        section_title: 'Intro',
        start_line: 1,
        end_line: 4,
        content: 'alpha text',
        content_hash: 'h1',
        updated_at: '2026-04-12T00:00:00Z',
        embedding: fakeEmbedding(1),
      },
      {
        source_path: 'daily-memories/2026-04-12.md',
        section_title: 'Body',
        start_line: 5,
        end_line: 10,
        content: 'beta text',
        content_hash: 'h2',
        updated_at: '2026-04-12T00:00:00Z',
        embedding: fakeEmbedding(9),
      },
    ]);

    const hits = knnSearch(db, fakeEmbedding(1), 2);
    expect(hits).toHaveLength(2);
    // Closest to seed=1 must be the first chunk
    expect(hits[0].content).toBe('alpha text');
    expect(hits[0].distance).toBeLessThanOrEqual(hits[1].distance);
    db.close();
  });

  it('replaceChunksForPath removes old rows for the same source', () => {
    const db = openVectorDb(dbPath);
    replaceChunksForPath(db, 'memories.md', [
      {
        source_path: 'memories.md',
        section_title: null,
        start_line: 1,
        end_line: 2,
        content: 'old',
        content_hash: 'old-hash',
        updated_at: '2026-04-01T00:00:00Z',
        embedding: fakeEmbedding(2),
      },
    ]);
    replaceChunksForPath(db, 'memories.md', [
      {
        source_path: 'memories.md',
        section_title: null,
        start_line: 1,
        end_line: 2,
        content: 'new',
        content_hash: 'new-hash',
        updated_at: '2026-04-13T00:00:00Z',
        embedding: fakeEmbedding(3),
      },
    ]);
    const hashes = getHashesForPath(db, 'memories.md');
    expect(hashes).toEqual(['new-hash']);
    db.close();
  });

  it('deleteChunksForPath removes a source entirely', () => {
    const db = openVectorDb(dbPath);
    replaceChunksForPath(db, 'x.md', [
      {
        source_path: 'x.md',
        section_title: null,
        start_line: 1,
        end_line: 1,
        content: 'c',
        content_hash: 'hc',
        updated_at: '2026-04-13T00:00:00Z',
        embedding: fakeEmbedding(4),
      },
    ]);
    expect(listIndexedSources(db)).toContain('x.md');
    deleteChunksForPath(db, 'x.md');
    expect(listIndexedSources(db)).not.toContain('x.md');
    db.close();
  });

  it('statsFor reports chunk and source counts', () => {
    const db = openVectorDb(dbPath);
    replaceChunksForPath(db, 'a.md', [
      {
        source_path: 'a.md',
        section_title: null,
        start_line: 1,
        end_line: 1,
        content: '1',
        content_hash: 'h-a-1',
        updated_at: '2026-04-13T00:00:00Z',
        embedding: fakeEmbedding(5),
      },
    ]);
    replaceChunksForPath(db, 'b.md', [
      {
        source_path: 'b.md',
        section_title: null,
        start_line: 1,
        end_line: 1,
        content: '2',
        content_hash: 'h-b-1',
        updated_at: '2026-04-13T00:00:00Z',
        embedding: fakeEmbedding(6),
      },
      {
        source_path: 'b.md',
        section_title: null,
        start_line: 2,
        end_line: 2,
        content: '3',
        content_hash: 'h-b-2',
        updated_at: '2026-04-13T00:00:00Z',
        embedding: fakeEmbedding(7),
      },
    ]);
    const s = statsFor(db, dbPath);
    expect(s.chunkCount).toBe(3);
    expect(s.sourceCount).toBe(2);
    expect(s.sizeBytes).toBeGreaterThan(0);
    db.close();
  });
});
