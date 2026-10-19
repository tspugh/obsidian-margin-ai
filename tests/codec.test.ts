import { describe, expect, it } from 'vitest';
import {
  appendMessage,
  createAnnotationDocument,
  parseAnnotation,
  replaceMessage,
  updateSourcePath,
  updateSummary,
  updatePdfHighlight,
  markPendingMessagesInterrupted,
} from '../src/margin-ai/codec';
import type { Annotation, Message } from '../src/margin-ai/types';

const annotation: Annotation = {
  id: 'ann-1',
  createdAt: '2026-10-13T12:00:00.000Z',
  source: {
    kind: 'markdown',
    path: 'Notes/A note.md',
    link: '[[Notes/A note.md]]',
    quote: 'A precise quote',
    contextBefore: 'Before ',
    contextAfter: ' after',
    startOffset: 12,
    endOffset: 27,
    scopeLabel: 'Selected text · 15 characters',
  },
  messages: [],
};

const message = (partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message => ({
  createdAt: '2026-10-13T12:01:00.000Z',
  status: 'complete',
  ...partial,
});

describe('companion Markdown codec', () => {
  it('creates a readable note and round-trips source metadata', () => {
    const markdown = createAnnotationDocument(annotation);
    expect(markdown).toContain('source: "[[Notes/A note.md]]"');
    expect(markdown).toContain('> A precise quote');
    expect(markdown).toContain('# Conversation');
    expect(parseAnnotation(markdown)).toEqual(annotation);
  });

  it('round-trips optional native PDF highlight identity and color', () => {
    const native: Annotation = {
      ...annotation,
      source: { ...annotation.source, kind: 'pdf', path: 'paper.pdf', link: '[[paper.pdf#page=2]]', page: 2, pdfSelection: [0, 1, 0, 4] },
      pdfHighlight: { annotationId: '12R0', color: 'yellow' },
    };
    expect(parseAnnotation(createAnnotationDocument(native))).toEqual(native);
  });

  it('keeps legacy annotations without native PDF metadata backward compatible', () => {
    expect(parseAnnotation(createAnnotationDocument(annotation)).pdfHighlight).toBeUndefined();
  });

  it('rejects malformed or non-PDF native highlight metadata', () => {
    const markdown=createAnnotationDocument(annotation).replace('scope:', 'pdf_highlight: invalid\nscope:');
    expect(()=>parseAnnotation(markdown)).toThrow(/PDF highlight/i);
    const nonPdf={...annotation,pdfHighlight:{annotationId:'12R0',color:'yellow'}};
    expect(()=>parseAnnotation(createAnnotationDocument(nonPdf))).toThrow(/PDF highlight/i);
  });
  it('adds native PDF highlight metadata without changing the conversation',()=>{
    const pdf={...annotation,source:{...annotation.source,kind:'pdf' as const,path:'paper.pdf',link:'[[paper.pdf#page=2]]',page:2,pdfSelection:[0,1,0,4] as [number,number,number,number]}};
    const markdown=updatePdfHighlight(createAnnotationDocument(pdf),{annotationId:'12R0',color:'yellow'});
    expect(parseAnnotation(markdown).pdfHighlight).toEqual({annotationId:'12R0',color:'yellow'});
  });

  it('appends readable human and AI message blocks', () => {
    let markdown = createAnnotationDocument(annotation);
    markdown = appendMessage(markdown, message({ id: 'u1', role: 'user', content: 'Explain this.' }));
    markdown = appendMessage(markdown, message({ id: 'a1', role: 'assistant', content: 'Here is the answer.' }));
    expect(markdown).toContain('## You');
    expect(markdown).toContain('## ChatGPT');
    expect(parseAnnotation(markdown).messages.map(({ id, role, content }) => ({ id, role, content }))).toEqual([
      { id: 'u1', role: 'user', content: 'Explain this.' },
      { id: 'a1', role: 'assistant', content: 'Here is the answer.' },
    ]);
  });

  it('updates only the targeted pending message and preserves manual edits', () => {
    let markdown = createAnnotationDocument(annotation);
    markdown = appendMessage(markdown, message({ id: 'a1', role: 'assistant', status: 'pending', content: 'Thinking…' }));
    markdown = markdown.replace('# Conversation', '# Conversation\n\nManual note outside managed blocks.');
    const updated = replaceMessage(markdown, 'a1', message({ id: 'a1', role: 'assistant', content: 'Finished.' }));
    expect(updated).toContain('Manual note outside managed blocks.');
    expect(updated).toContain('Finished.');
    expect(updated).not.toContain('Thinking…');
  });

  it.each(['error', 'cancelled'] as const)('persists %s without adding a duplicate', (status) => {
    let markdown = createAnnotationDocument(annotation);
    markdown = appendMessage(markdown, message({ id: 'a1', role: 'assistant', status: 'pending', content: 'Thinking…' }));
    markdown = replaceMessage(markdown, 'a1', message({ id: 'a1', role: 'assistant', status, content: status === 'error' ? 'Network failed.' : 'Cancelled.' }));
    const parsed = parseAnnotation(markdown);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].status).toBe(status);
  });

  it('renames source metadata without changing conversation text', () => {
    let markdown = appendMessage(createAnnotationDocument(annotation), message({ id: 'u1', role: 'user', content: 'Keep me.' }));
    markdown = updateSourcePath(markdown, 'Notes/A note.md', 'Archive/Renamed.md');
    const parsed = parseAnnotation(markdown);
    expect(parsed.source.path).toBe('Archive/Renamed.md');
    expect(parsed.source.link).toBe('[[Archive/Renamed.md]]');
    expect(parsed.messages[0].content).toBe('Keep me.');
  });

  it('round-trips multiline Markdown and marker-like content without corrupting boundaries', () => {
    const complex = {
      ...annotation,
      source: {
        ...annotation.source,
        quote: '---\n# Heading\n$x^2$\n```ts\nconst x = 1;\n```',
      },
    };
    const content = '# Reply\n\n```md\n<!-- margin-ai-message {"fake":true} -->\n<!-- margin-ai-end a1 -->\n```';
    let markdown = createAnnotationDocument(complex);
    markdown = appendMessage(markdown, message({ id: 'a1', role: 'assistant', content }));
    const parsed = parseAnnotation(markdown);
    expect(parsed.source.quote).toBe(complex.source.quote);
    expect(parsed.messages[0].content).toBe(content);
  });

  it('marks persisted pending responses as interrupted on restart', () => {
    let markdown = createAnnotationDocument(annotation);
    markdown = appendMessage(markdown, message({ id: 'a1', role: 'assistant', status: 'pending', content: 'Thinking…' }));
    const parsed = parseAnnotation(markPendingMessagesInterrupted(markdown));
    expect(parsed.messages[0].status).toBe('interrupted');
    expect(parsed.messages[0].content).toContain('interrupted');
  });

  it('parses frontmatter rewritten by Obsidian Properties with plain and block YAML values', () => {
    const markdown = createAnnotationDocument(annotation)
      .replace('id: "ann-1"', 'id: ann-1')
      .replace('source_kind: "markdown"', 'source_kind: markdown')
      .replace('quote: "A precise quote"', 'quote: |-\n  A precise quote');
    expect(parseAnnotation(markdown)).toEqual(annotation);
  });

  it('preserves unknown user properties while updating a renamed source', () => {
    const markdown = createAnnotationDocument(annotation).replace('margin-ai: 1', 'margin-ai: 1\nmy_rating: 5');
    const updated = updateSourcePath(markdown, annotation.source.path, 'Moved.md');
    expect(updated).toContain('my_rating: 5');
    expect(parseAnnotation(updated).source.path).toBe('Moved.md');
  });

  it('round-trips optional request context and source metadata', () => {
    const contextual = {
      ...annotation,
      messages: [message({
        id: 'u1', role: 'user', content: 'Compare this.',
        requestContext: {
          sourcePath: 'Notes/A note.md', scope: { kind: 'folder' as const, ancestorDepth: 1 }, model: 'gpt-test',
          companionFolder: 'Margin AI', excludedFolders: ['Private'],
          sources: [{ path: 'Notes/Related.md', excerptCharacters: 240, matchedTerms: ['compare'] }],
          retrieval: { examinedCount: 12, matchedCount: 1, truncated: false, noResults: false },
        },
      })],
    };
    expect(parseAnnotation(createAnnotationDocument(contextual))).toEqual(contextual);
  });

  it('loads legacy messages without request context', () => {
    const markdown = appendMessage(createAnnotationDocument(annotation), message({ id: 'u1', role: 'user', content: 'Legacy.' }));
    expect(parseAnnotation(markdown).messages[0].requestContext).toBeUndefined();
  });

  it('round-trips an optional conversation summary while legacy notes remain valid', () => {
    const summarized: Annotation = { ...annotation, summary: { title: 'Feedback loops', text: 'A short synthesis.', model: 'gpt-mini', updatedAt: '2026-10-15T10:00:00Z', coveredMessageIds: ['u1', 'a1'] } };
    expect(parseAnnotation(createAnnotationDocument(summarized)).summary).toEqual(summarized.summary);
    expect(parseAnnotation(createAnnotationDocument(annotation)).summary).toBeUndefined();
  });
  it('updates summary metadata without altering messages or user prose', () => {
    let markdown = appendMessage(createAnnotationDocument(annotation), message({ id: 'u1', role: 'user', content: 'Keep me.' }));
    markdown = markdown.replace('# Conversation', 'User prose\n\n# Conversation');
    const summary = { title: 'Title', text: 'Brief.', model: 'mini', updatedAt: 'now', coveredMessageIds: ['u1'], contentFingerprint: 'abc' };
    const updated = updateSummary(markdown, summary);
    expect(parseAnnotation(updated).summary).toEqual(summary); expect(updated).toContain('User prose'); expect(parseAnnotation(updated).messages[0].content).toBe('Keep me.');
  });
});
