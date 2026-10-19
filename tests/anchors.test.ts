import { describe, expect, it } from 'vitest';
import { resolveMarkdownAnchor } from '../src/margin-ai/anchors';

describe('resolveMarkdownAnchor', () => {
  it('uses the stored offsets when the exact quote is unchanged', () => {
    const text = 'Before the exact passage after.';
    expect(resolveMarkdownAnchor(text, {
      quote: 'the exact passage',
      startOffset: 7,
      endOffset: 24,
      contextBefore: 'Before ',
      contextAfter: ' after.',
    })).toEqual({ status: 'resolved', startOffset: 7, endOffset: 24 });
  });

  it('relocates a unique exact quote after surrounding edits', () => {
    const text = 'New preface. Before the exact passage after.';
    expect(resolveMarkdownAnchor(text, {
      quote: 'the exact passage',
      startOffset: 7,
      endOffset: 24,
      contextBefore: 'Before ',
      contextAfter: ' after.',
    })).toEqual({ status: 'resolved', startOffset: 20, endOffset: 37 });
  });

  it('reports a duplicate quote as ambiguous instead of choosing one', () => {
    const text = 'same quote here; same quote there';
    expect(resolveMarkdownAnchor(text, {
      quote: 'same quote',
      startOffset: 99,
      endOffset: 109,
      contextBefore: '',
      contextAfter: '',
    })).toEqual({ status: 'ambiguous', matches: 2 });
  });

  it('does not trust a stale original offset when duplicate context disagrees', () => {
    const text = 'wrong same quote ending; right same quote context';
    expect(resolveMarkdownAnchor(text, {
      quote: 'same quote',
      startOffset: 6,
      endOffset: 16,
      contextBefore: 'right ',
      contextAfter: ' context',
    })).toEqual({ status: 'resolved', startOffset: 31, endOffset: 41 });
  });

  it('uses exact nearby context to disambiguate duplicates', () => {
    const text = 'alpha same quote omega; beta same quote gamma';
    expect(resolveMarkdownAnchor(text, {
      quote: 'same quote',
      startOffset: 99,
      endOffset: 109,
      contextBefore: 'beta ',
      contextAfter: ' gamma',
    })).toEqual({ status: 'resolved', startOffset: 29, endOffset: 39 });
  });

  it('reports a deleted quote as missing', () => {
    expect(resolveMarkdownAnchor('The passage has gone.', {
      quote: 'original passage',
      startOffset: 4,
      endOffset: 20,
      contextBefore: 'The ',
      contextAfter: '.',
    })).toEqual({ status: 'missing' });
  });
});
