import { describe, expect, it } from 'vitest';
import { captureMarkdown, capturePdf } from '../src/margin-ai/capture-domain';

describe('source capture snapshots', () => {
  it('captures exact Markdown selection and bounded nearby context', () => {
    const text = `${'x'.repeat(120)}selected${'y'.repeat(120)}`;
    const capture = captureMarkdown('Notes/Test.md', text, 120, 128);
    expect(capture.quote).toBe('selected');
    expect(capture.contextBefore).toHaveLength(80);
    expect(capture.contextAfter).toHaveLength(80);
    expect(capture.startOffset).toBe(120);
    expect(capture.endOffset).toBe(128);
  });

  it('captures a whole-note scope only when there is no selection', () => {
    const capture = captureMarkdown('Notes/Test.md', 'Whole note', 4, 4);
    expect(capture.quote).toBe('');
    expect(capture.contextAfter).toBe('Whole note');
    expect(capture.scopeLabel).toBe('Whole note · 10 characters');
  });

  it('captures PDF page and PDF++ selection tuple', () => {
    const capture = capturePdf('Papers/Test.pdf', 'PDF quote', 3, [1, 2, 4, 8]);
    expect(capture.link).toBe('[[Papers/Test.pdf#page=3&selection=1,2,4,8]]');
    expect(capture.page).toBe(3);
    expect(capture.quote).toBe('PDF quote');
  });
});
