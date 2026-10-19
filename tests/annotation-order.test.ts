import { describe, expect, it } from 'vitest';
import { orderAnnotations } from '../src/margin-ai/annotation-order';
import type { Annotation } from '../src/margin-ai/types';

const annotation = (id: string, source: Partial<Annotation['source']>): Annotation => ({
  id, createdAt: '2026-10-13T12:00:00.000Z', messages: [],
  source: { kind: 'markdown', path: 'n.md', link: '[[n.md]]', quote: id, contextBefore: '', contextAfter: '', scopeLabel: id, ...source },
});

describe('annotation document order', () => {
  it('orders Markdown passages by resolved offsets and labels unresolved anchors last', () => {
    const items = [
      annotation('missing', { startOffset: 99, endOffset: 100, quote: 'gone' }), annotation('later', { startOffset: 6, endOffset: 10, quote: 'beta' }),
      annotation('ambiguous', { startOffset: 99, endOffset: 100, quote: 'same' }), annotation('earlier', { startOffset: 0, endOffset: 5, quote: 'alpha' }),
    ];
    expect(orderAnnotations(items, { markdownText: 'alpha beta same same' }).map(({ annotation: item, anchorStatus }) => [item.id, anchorStatus])).toEqual([
      ['earlier', 'resolved'], ['later', 'resolved'], ['ambiguous', 'ambiguous'], ['missing', 'missing'],
    ]);
  });

  it('orders PDF passages by page then selection tuple and preserves stable ties', () => {
    const items = [
      annotation('b', { kind: 'pdf', path: 'n.pdf', page: 2, pdfSelection: [5, 1, 5, 4] }),
      annotation('c', { kind: 'pdf', path: 'n.pdf', page: 1, pdfSelection: [8, 1, 8, 4] }),
      annotation('a', { kind: 'pdf', path: 'n.pdf', page: 2, pdfSelection: [5, 1, 5, 4] }),
    ];
    expect(orderAnnotations(items).map(({ annotation: item }) => item.id)).toEqual(['c', 'b', 'a']);
  });

  it('separates whole-document conversations from passage highlights', () => {
    const items = [annotation('passage', { startOffset: 0, endOffset: 1 }), annotation('whole', { quote: '', startOffset: undefined, endOffset: undefined })];
    expect(orderAnnotations(items, { markdownText: 'passage' }).map(({ annotation: item, group }) => [item.id, group])).toEqual([
      ['passage', 'passage'], ['whole', 'whole-document'],
    ]);
  });

  it('labels incomplete PDF locations as missing and sorts them after located passages', () => {
    const items = [
      annotation('unknown', { kind: 'pdf', path: 'n.pdf', page: 1, pdfSelection: undefined }),
      annotation('known', { kind: 'pdf', path: 'n.pdf', page: 2, pdfSelection: [1, 2, 3, 4] }),
    ];
    expect(orderAnnotations(items).map(({ annotation: item, anchorStatus }) => [item.id, anchorStatus])).toEqual([
      ['known', 'pdf'], ['unknown', 'missing'],
    ]);
  });
});
