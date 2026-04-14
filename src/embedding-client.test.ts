import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Config must be mocked before importing the client so GEMINI_API_KEY is defined.
vi.mock('./config.js', () => ({
  GEMINI_API_KEY: 'test-key-abc',
}));
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EMBEDDING_DIM, embedBatch, embedSingle } from './embedding-client.js';

let fetchMock: ReturnType<typeof vi.fn>;

function makeEmbedding(seed: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < EMBEDDING_DIM; i++)
    v.push(Math.sin((i + 1) * seed) * 0.1);
  return v;
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('embedding-client', () => {
  it('embedSingle sends RETRIEVAL_QUERY and returns Float32Array', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ embedding: { values: makeEmbedding(1) } }),
    );
    const result = await embedSingle('hello', 'RETRIEVAL_QUERY');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBEDDING_DIM);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain(':embedContent');
    const body = JSON.parse(call[1].body);
    expect(body.taskType).toBe('RETRIEVAL_QUERY');
    expect(body.outputDimensionality).toBe(EMBEDDING_DIM);
    expect(call[1].headers['x-goog-api-key']).toBe('test-key-abc');
  });

  it('embedBatch batches ≤100 requests and preserves order', async () => {
    const texts = Array.from({ length: 3 }, (_, i) => `text ${i}`);
    fetchMock.mockResolvedValueOnce(
      okResponse({
        embeddings: texts.map((_, i) => ({ values: makeEmbedding(i + 1) })),
      }),
    );
    const out = await embedBatch(texts);
    expect(out).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain(':batchEmbedContents');
    const body = JSON.parse(call[1].body);
    expect(body.requests).toHaveLength(3);
    expect(body.requests[0].taskType).toBe('RETRIEVAL_DOCUMENT');
  });

  it('embedBatch splits >100 inputs across multiple calls', async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return okResponse({
        embeddings: body.requests.map((_: unknown, i: number) => ({
          values: makeEmbedding(i + 1),
        })),
      });
    });
    const out = await embedBatch(texts);
    expect(out).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('embedSingle retries on 500 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('upstream overloaded', { status: 503 }),
      )
      .mockResolvedValueOnce(
        okResponse({ embedding: { values: makeEmbedding(2) } }),
      );
    const out = await embedSingle('retry me');
    expect(out).toBeInstanceOf(Float32Array);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('embedSingle surfaces a 4xx error without retrying', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'bad' } }), {
        status: 400,
      }),
    );
    await expect(embedSingle('nope')).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
