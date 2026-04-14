import { describe, it, expect } from 'vitest';

import { chunkMarkdown } from './vector-indexer.js';

describe('chunkMarkdown', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkMarkdown('x.md', '')).toEqual([]);
    expect(chunkMarkdown('x.md', '   \n\n')).toEqual([]);
  });

  it('keeps a single short section as one chunk', () => {
    const md = `# Title\n\nHello world line.\nSecond line.`;
    const chunks = chunkMarkdown('a.md', md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionTitle).toBe('Title');
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].content).toContain('Hello world line.');
  });

  it('splits on ## and ### headers into separate chunks', () => {
    const md = [
      '# Top',
      '',
      '## First section',
      'A',
      '',
      '## Second section',
      'B',
      '',
      '### Nested',
      'C',
    ].join('\n');
    const chunks = chunkMarkdown('b.md', md);
    const titles = chunks.map((c) => c.sectionTitle);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Top',
        'First section',
        'Second section',
        'Nested',
      ]),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(4);
  });

  it('windows oversized sections with overlap', () => {
    const body = 'x'.repeat(5000); // well above CHUNK_CHAR_TARGET=1600
    const md = `## Big\n${body}`;
    const chunks = chunkMarkdown('c.md', md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(1600);
      expect(c.sectionTitle).toBe('Big');
    }
    // Consecutive windows should overlap — prior window's last characters
    // appear at the next window's start (approximate stride = 1280).
    const first = chunks[0].content;
    const second = chunks[1].content;
    expect(first.slice(-50)).toEqual(second.slice(0, 50));
  });

  it('preserves source_path on every chunk', () => {
    const md = `## Sec\nbody line`;
    const chunks = chunkMarkdown('daily-memories/2026-04-13.md', md);
    for (const c of chunks) {
      expect(c.sourcePath).toBe('daily-memories/2026-04-13.md');
    }
  });

  it('handles markdown without any headers', () => {
    const md = `just plain text\nanother line\nthird line`;
    const chunks = chunkMarkdown('notes.md', md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionTitle).toBeNull();
    expect(chunks[0].content).toContain('just plain text');
  });
});
