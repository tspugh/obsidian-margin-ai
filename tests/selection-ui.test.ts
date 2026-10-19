import { describe, expect, it } from 'vitest';
import { RetainedSourceCapture } from '../src/margin-ai/retained-capture';
import { captureMarkdown } from '../src/margin-ai/capture-domain';

describe('retained source capture', () => {
  it('keeps the editor selection snapshot after sidebar focus moves', () => {
    const retained = new RetainedSourceCapture();
    retained.remember(captureMarkdown('n.md', 'alpha beta', 6, 10));
    expect(retained.current()?.quote).toBe('beta');
    const copy = retained.current()!;
    copy.quote = 'changed';
    expect(retained.current()?.quote).toBe('beta');
  });

  it('resets the retained capture when the source document changes', () => {
    const retained = new RetainedSourceCapture();
    retained.remember(captureMarkdown('a.md', 'alpha', 0, 5));
    retained.resetForSource('b.md');
    expect(retained.current()).toBeNull();
  });

	 it('deep-copies PDF selection tuples', () => {
	   const retained = new RetainedSourceCapture();
	   const capture = { kind: 'pdf' as const, path: 'p.pdf', link: '[[p.pdf#page=1]]', quote: 'text', contextBefore: '', contextAfter: '', page: 1, pdfSelection: [1, 2, 3, 4] as [number, number, number, number], scopeLabel: 'PDF selection' };
	   retained.remember(capture);
	   capture.pdfSelection[0] = 99;
	   const first = retained.current()!; first.pdfSelection![1] = 88;
	   expect(retained.current()?.pdfSelection).toEqual([1, 2, 3, 4]);
	 });
});
