/**
 * In-container memory search.
 *
 * Reads a per-group sqlite-vec database mounted at /workspace/vectors/vectors.db
 * (built by the host-side vector-indexer), embeds the query via Gemini, and
 * runs a KNN search. An optional temporal-decay reranker boosts recent
 * daily-memories chunks. Other group's memories are physically inaccessible
 * because each group mounts its own DB file.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs';

const VECTORS_DB_PATH = '/workspace/vectors/vectors.db';
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIM = 768;

export interface SearchOptions {
  limit: number;
  minScore: number;
  temporalDecay: boolean;
  halfLifeDays: number;
}

export interface SearchHit {
  source_path: string;
  section_title: string | null;
  start_line: number;
  end_line: number;
  content: string;
  updated_at: string;
  rawScore: number;
  finalScore: number;
  ageDays: number | null;
}

interface ChunkRow {
  source_path: string;
  section_title: string | null;
  start_line: number;
  end_line: number;
  content: string;
  updated_at: string;
  distance: number;
}

const DAILY_DATE_RE = /daily-memories\/(\d{4})-(\d{2})-(\d{2})\.md$/;

export async function searchMemory(
  query: string,
  opts: SearchOptions,
): Promise<SearchHit[]> {
  if (!fs.existsSync(VECTORS_DB_PATH)) {
    throw new Error(
      `Vector DB not found at ${VECTORS_DB_PATH}. The host indexer hasn't built one for this group yet.`,
    );
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY env var not present in container. Host should forward it via container-runner.',
    );
  }

  const queryVec = await embedQuery(query, apiKey);

  const db = new Database(VECTORS_DB_PATH, { readonly: true });
  sqliteVec.load(db);
  try {
    // Pull more than `limit` so temporal decay can rerank without losing
    // candidates that were close raw but slightly older.
    const candidateCount = Math.max(opts.limit * 4, 16);
    const rows = db
      .prepare(
        `
        SELECT c.source_path, c.section_title, c.start_line, c.end_line,
               c.content, c.updated_at, v.distance
          FROM vec_chunks v
          JOIN chunks c ON c.id = v.chunk_id
         WHERE v.embedding MATCH ?
           AND k = ?
         ORDER BY v.distance
        `,
      )
      .all(Buffer.from(queryVec.buffer), candidateCount) as ChunkRow[];

    const now = Date.now();
    const lambda = Math.LN2 / Math.max(opts.halfLifeDays, 0.001);

    const hits: SearchHit[] = rows.map((r) => {
      // sqlite-vec defaults to L2 distance over normalized embeddings.
      // For Gemini's normalized vectors the cosine-equivalent score is
      // 1 - distance^2/2, clamped to [0, 1].
      const rawScore = Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2));
      const ageDays = computeAgeDays(r.source_path, now);
      let finalScore = rawScore;
      if (opts.temporalDecay && ageDays !== null) {
        finalScore = rawScore * Math.exp(-lambda * ageDays);
      }
      return {
        source_path: r.source_path,
        section_title: r.section_title,
        start_line: r.start_line,
        end_line: r.end_line,
        content: r.content,
        updated_at: r.updated_at,
        rawScore,
        finalScore,
        ageDays,
      };
    });

    hits.sort((a, b) => b.finalScore - a.finalScore);
    return hits.filter((h) => h.finalScore >= opts.minScore).slice(0, opts.limit);
  } finally {
    db.close();
  }
}

function computeAgeDays(sourcePath: string, nowMs: number): number | null {
  const m = DAILY_DATE_RE.exec(sourcePath);
  if (!m) return null;
  const dateMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, (nowMs - dateMs) / 86_400_000);
}

async function embedQuery(text: string, apiKey: string): Promise<Float32Array> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }], role: 'user' },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: EMBEDDING_DIM,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini query embed failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { embedding?: { values: number[] } };
  if (!json.embedding) throw new Error('Gemini returned no embedding');
  return Float32Array.from(json.embedding.values);
}

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return 'No matching memories found.';
  const lines: string[] = [];
  hits.forEach((h, i) => {
    const ageNote =
      h.ageDays !== null
        ? ` age ${h.ageDays.toFixed(0)}d`
        : ' evergreen';
    const sec = h.section_title ? ` (${h.section_title})` : '';
    lines.push(
      `[${i + 1}] ${h.source_path}${sec} L${h.start_line}-${h.end_line}  score=${h.finalScore.toFixed(2)} (raw ${h.rawScore.toFixed(2)},${ageNote})`,
    );
    const snippet = h.content.length > 400 ? h.content.slice(0, 400) + '…' : h.content;
    lines.push(snippet.split('\n').map((l) => '  ' + l).join('\n'));
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}
