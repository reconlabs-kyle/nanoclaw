/**
 * Gemini embedding client.
 *
 * Uses Google's `gemini-embedding-001` at 768 output dimensions.
 * API key is read from GEMINI_API_KEY (.env or process.env). Calls go
 * direct to `generativelanguage.googleapis.com` — OneCLI's gateway does
 * not currently ship a plug-in for Google's embeddings API, and routing
 * the call through a Node proxy agent adds latency without benefit since
 * the key is already local to this host.
 */
import { GEMINI_API_KEY } from './config.js';
import { logger } from './logger.js';

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIM = 768;

// Gemini batchEmbedContents limit is 100 requests per call at time of writing.
const MAX_BATCH_SIZE = 100;

export type EmbedTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

interface EmbedContentResponse {
  embedding?: { values: number[] };
  error?: { code: number; message: string; status: string };
}

interface BatchEmbedResponse {
  embeddings?: { values: number[] }[];
  error?: { code: number; message: string; status: string };
}

function assertKey(): string {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to .env to enable embeddings.',
    );
  }
  return GEMINI_API_KEY;
}

/**
 * Embed a single string. Use for `RETRIEVAL_QUERY` at search time.
 */
export async function embedSingle(
  text: string,
  taskType: EmbedTaskType = 'RETRIEVAL_QUERY',
): Promise<Float32Array> {
  const key = assertKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;
  const body = {
    model: `models/${EMBEDDING_MODEL}`,
    content: { parts: [{ text }], role: 'user' },
    taskType,
    outputDimensionality: EMBEDDING_DIM,
  };

  const res = await fetchWithRetry(url, key, body);
  const json = (await res.json()) as EmbedContentResponse;
  if (!json.embedding) {
    throw new Error(
      `Gemini embedContent failed: ${json.error?.message ?? 'no embedding'}`,
    );
  }
  return Float32Array.from(json.embedding.values);
}

/**
 * Embed many strings. Automatically batched into chunks of MAX_BATCH_SIZE.
 * Returns embeddings in the same order as the input.
 */
export async function embedBatch(
  texts: string[],
  taskType: EmbedTaskType = 'RETRIEVAL_DOCUMENT',
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const key = assertKey();
  const results: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const slice = texts.slice(i, i + MAX_BATCH_SIZE);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`;
    const body = {
      requests: slice.map((text) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }], role: 'user' },
        taskType,
        outputDimensionality: EMBEDDING_DIM,
      })),
    };

    const res = await fetchWithRetry(url, key, body);
    const json = (await res.json()) as BatchEmbedResponse;
    if (!json.embeddings || json.embeddings.length !== slice.length) {
      throw new Error(
        `Gemini batchEmbedContents returned ${json.embeddings?.length ?? 0} embeddings for ${slice.length} inputs: ${json.error?.message ?? 'unknown error'}`,
      );
    }
    for (const e of json.embeddings) {
      results.push(Float32Array.from(e.values));
    }
    logger.debug(
      { batch: slice.length, offset: i, total: texts.length },
      'Gemini embedBatch chunk succeeded',
    );
  }
  return results;
}

class FatalGeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalGeminiError';
  }
}

async function fetchWithRetry(
  url: string,
  apiKey: string,
  body: unknown,
  maxAttempts = 3,
): Promise<Response> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      // Retry on 429 / 5xx; surface 4xx immediately (bad request, auth).
      if (res.status >= 500 || res.status === 429) {
        const errBody = await res.text().catch(() => '');
        lastErr = new Error(
          `HTTP ${res.status} ${res.statusText} on attempt ${attempt}: ${errBody.slice(0, 200)}`,
        );
        logger.warn(
          { status: res.status, attempt, body: errBody.slice(0, 200) },
          'Gemini transient error, will retry',
        );
      } else {
        const errBody = await res.text().catch(() => '');
        throw new FatalGeminiError(
          `Gemini HTTP ${res.status}: ${errBody.slice(0, 300)}`,
        );
      }
    } catch (err) {
      if (err instanceof FatalGeminiError) throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxAttempts) break;
    }
    // Exponential backoff: 500ms, 1.5s, 4.5s
    await new Promise((r) => setTimeout(r, 500 * 3 ** (attempt - 1)));
  }
  throw lastErr ?? new Error('Gemini request failed');
}
