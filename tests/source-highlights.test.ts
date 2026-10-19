import { describe, expect, it } from 'vitest';
import { resolveHighlightRanges } from '../src/margin-ai/source-highlight-ranges';
import type { Annotation } from '../src/margin-ai/types';

const annotation = (id: string, quote: string, startOffset?: number, endOffset?: number): Annotation => ({
  id, createdAt: '2026-10-13T00:00:00Z', messages: [],
  source: { kind: 'markdown', path: 'n.md', link: '[[n.md]]', quote, contextBefore: '', contextAfter: '', startOffset, endOffset, scopeLabel: quote },
});

describe('source-safe highlight ranges', () => {
  it('supports saved highlights with no messages and does not guess missing anchors', () => {
    const ranges = resolveHighlightRanges('n.md', 'alpha beta', [
      annotation('empty-highlight', 'alpha', 0, 5),
      annotation('missing', 'gone', 20, 24),
      { ...annotation('other', 'alpha', 0, 5), source: { ...annotation('other', 'alpha', 0, 5).source, path: 'other.md' } },
    ]);
    expect(ranges).toEqual([{ annotationId: 'empty-highlight', from: 0, to: 5 }]);
  });
});
