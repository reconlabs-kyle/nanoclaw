/**
 * Vector indexer.
 *
 * For a given registered group, scans its markdown memory sources
 * (`daily-memories/*.md`, `memories.md`, `user-context.md`), splits
 * into chunks by markdown headers + a token-sized sliding window,
 * diffs against the existing vectors.db via content hash, and upserts
 * only changed files. Embeddings come from Gemini via embedding-client.
 *
 * Designed to run on the host after each daily-reflection cron and as
 * a nightly full sweep. Idempotent and cheap when files are unchanged.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { embedBatch } from './embedding-client.js';
import { logger } from './logger.js';
import {
  ChunkInput,
  deleteChunksForPath,
  getHashesForPath,
  listIndexedSources,
  openVectorDb,
  replaceChunksForPath,
  resolveVectorDbPath,
  statsFor,
} from './vector-db.js';

/** Files relative to the group folder that are always indexed. */
const ROOT_SOURCES = ['memories.md', 'user-context.md'];

// Target chunk size in characters. Gemini's effective token ≈ 4 chars for
// Latin-heavy text and ≈ 2 chars for Korean/CJK. We keep this conservative
// so 400-token windows land comfortably under model limits.
const CHUNK_CHAR_TARGET = 1600;
const CHUNK_CHAR_OVERLAP = 320;

interface RawChunk {
  sourcePath: string; // relative to group folder
  sectionTitle: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

interface IndexStats {
  scanned: number;
  changed: number;
  unchanged: number;
  removed: number;
  chunksWritten: number;
  durationMs: number;
  dbSizeBytes: number;
  totalChunks: number;
}

export async function rebuildGroup(groupFolder: string): Promise<IndexStats> {
  const startedAt = Date.now();
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  if (!fs.existsSync(groupDir)) {
    throw new Error(`Group folder not found: ${groupDir}`);
  }

  const files = collectSources(groupDir);
  const dbPath = resolveVectorDbPath(groupFolder);
  const db = openVectorDb(dbPath);

  let changed = 0;
  let unchanged = 0;
  let chunksWritten = 0;

  try {
    const existingSources = new Set(listIndexedSources(db));
    const seenSources = new Set<string>();

    for (const file of files) {
      seenSources.add(file.relPath);
      const text = fs.readFileSync(file.absPath, 'utf-8');
      const mtime = fs.statSync(file.absPath).mtime.toISOString();
      const chunks = chunkMarkdown(file.relPath, text);
      const newHashes = chunks.map((c) => hashContent(c.content));
      const existingHashes = getHashesForPath(db, file.relPath);

      if (
        existingHashes.length === newHashes.length &&
        existingHashes.every((h, i) => h === newHashes[i])
      ) {
        unchanged++;
        continue;
      }

      if (chunks.length === 0) {
        // File emptied; just drop old rows
        deleteChunksForPath(db, file.relPath);
        changed++;
        continue;
      }

      const embeddings = await embedBatch(
        chunks.map((c) => c.content),
        'RETRIEVAL_DOCUMENT',
      );
      const rows: ChunkInput[] = chunks.map((c, i) => ({
        source_path: c.sourcePath,
        section_title: c.sectionTitle,
        start_line: c.startLine,
        end_line: c.endLine,
        content: c.content,
        content_hash: newHashes[i],
        updated_at: mtime,
        embedding: embeddings[i],
      }));
      replaceChunksForPath(db, file.relPath, rows);
      changed++;
      chunksWritten += rows.length;
      logger.debug(
        { groupFolder, file: file.relPath, chunks: rows.length },
        'indexed file',
      );
    }

    // Orphan cleanup: any indexed source not present in the current
    // scan (deleted or renamed) loses its chunks.
    let removed = 0;
    for (const src of existingSources) {
      if (!seenSources.has(src)) {
        deleteChunksForPath(db, src);
        removed++;
      }
    }

    const stats = statsFor(db, dbPath);
    return {
      scanned: files.length,
      changed,
      unchanged,
      removed,
      chunksWritten,
      durationMs: Date.now() - startedAt,
      dbSizeBytes: stats.sizeBytes,
      totalChunks: stats.chunkCount,
    };
  } finally {
    db.close();
  }
}

interface SourceFile {
  absPath: string;
  relPath: string; // relative to group folder
}

function collectSources(groupDir: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const rel of ROOT_SOURCES) {
    const abs = path.join(groupDir, rel);
    if (fs.existsSync(abs)) out.push({ absPath: abs, relPath: rel });
  }
  const dailyDir = path.join(groupDir, 'daily-memories');
  if (fs.existsSync(dailyDir) && fs.statSync(dailyDir).isDirectory()) {
    for (const name of fs.readdirSync(dailyDir).sort()) {
      if (!name.endsWith('.md')) continue;
      out.push({
        absPath: path.join(dailyDir, name),
        relPath: path.join('daily-memories', name),
      });
    }
  }
  return out;
}

/**
 * Split markdown into chunks by ## / ### headers first, then fall back
 * to a char-sized sliding window for oversized sections. Each chunk
 * carries its source file, section title, and original line range.
 */
export function chunkMarkdown(sourcePath: string, text: string): RawChunk[] {
  const lines = text.split('\n');
  if (lines.length === 0 || text.trim().length === 0) return [];

  // Pass 1: split into logical sections at level-2/3 headers
  interface Section {
    title: string | null;
    startLine: number;
    endLine: number;
    body: string;
  }
  const sections: Section[] = [];
  let currentTitle: string | null = null;
  let currentStart = 1;
  let buffer: string[] = [];

  const flush = (endLine: number) => {
    const body = buffer.join('\n').trim();
    if (body.length > 0) {
      sections.push({
        title: currentTitle,
        startLine: currentStart,
        endLine,
        body,
      });
    }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (headerMatch && headerMatch[1].length <= 3 && i > 0) {
      flush(i); // previous section ends on line i (1-indexed: line number i)
      currentTitle = headerMatch[2];
      currentStart = i + 1;
    }
    if (headerMatch && i === 0) {
      currentTitle = headerMatch[2];
    }
    buffer.push(line);
  }
  flush(lines.length);

  // Pass 2: break oversized sections into overlapping char windows
  const out: RawChunk[] = [];
  for (const sec of sections) {
    if (sec.body.length <= CHUNK_CHAR_TARGET) {
      out.push({
        sourcePath,
        sectionTitle: sec.title,
        startLine: sec.startLine,
        endLine: sec.endLine,
        content: sec.body,
      });
      continue;
    }
    // Windowed split. We approximate line ranges by dividing proportionally.
    const totalChars = sec.body.length;
    const totalLines = sec.endLine - sec.startLine + 1;
    const stride = CHUNK_CHAR_TARGET - CHUNK_CHAR_OVERLAP;
    for (let offset = 0; offset < totalChars; offset += stride) {
      const piece = sec.body.slice(offset, offset + CHUNK_CHAR_TARGET);
      if (piece.trim().length === 0) continue;
      const approxStart =
        sec.startLine + Math.floor((offset / totalChars) * totalLines);
      const approxEnd =
        sec.startLine +
        Math.floor(
          (Math.min(offset + piece.length, totalChars) / totalChars) *
            totalLines,
        );
      out.push({
        sourcePath,
        sectionTitle: sec.title,
        startLine: approxStart,
        endLine: Math.max(approxEnd, approxStart),
        content: piece.trim(),
      });
    }
  }
  return out;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
