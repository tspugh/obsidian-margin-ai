import { describe, expect, it } from 'vitest';
import { AnnotationRepository, type AnnotationFile, type AnnotationVault } from '../src/margin-ai/repository';
import { appendMessage, createAnnotationDocument, parseAnnotation } from '../src/margin-ai/codec';
import type { Annotation, Message } from '../src/margin-ai/types';

class MemoryVault implements AnnotationVault {
  files = new Map<string, string>();
  folders = new Set<string>();

  getMarkdownFiles(): AnnotationFile[] {
    return [...this.files.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path }));
  }

  getFile(path: string): AnnotationFile | null {
    return this.files.has(path) ? { path } : null;
  }

  async read(file: AnnotationFile): Promise<string> {
    const value = this.files.get(file.path);
    if (value === undefined) throw new Error('missing');
    return value;
  }

  async create(path: string, content: string): Promise<AnnotationFile> {
    this.files.set(path, content);
    return { path };
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  async process(file: AnnotationFile, transform: (content: string) => string): Promise<string> {
    const next = transform(await this.read(file));
    this.files.set(file.path, next);
    return next;
  }
}

const base: Annotation = {
  id: 'annotation-id',
  createdAt: '2026-10-13T12:00:00.000Z',
  source: {
    kind: 'markdown', path: 'Note.md', link: '[[Note.md]]', quote: 'quote',
    contextBefore: '', contextAfter: '', startOffset: 0, endOffset: 5,
    scopeLabel: 'Selected text · 5 characters',
  },
  messages: [],
};

const pending: Message = {
  id: 'answer-id', role: 'assistant', createdAt: '2026-10-13T12:01:00.000Z',
  status: 'pending', content: 'Thinking…',
};

describe('AnnotationRepository', () => {
  it.each(['../Outside', '.obsidian/plugins', '/Absolute'])('rejects unsafe annotation folder %s', (folder) => {
    expect(() => new AnnotationRepository(new MemoryVault(), folder)).toThrow(/folder/i);
  });

  it('creates and reopens ordinary companion Markdown files', async () => {
    const vault = new MemoryVault();
    const repository = new AnnotationRepository(vault, 'Annotations');
    const path = await repository.create(base);
    expect(vault.folders.has('Annotations')).toBe(true);
    expect(path).toMatch(/^Annotations\/Note-20261013-120000-annotation\.md$/);
    expect((await repository.listForSource('Note.md'))[0].annotation).toEqual(base);
  });

  it('ignores ordinary notes but surfaces malformed Margin AI companions', async () => {
    const vault = new MemoryVault();
    vault.files.set('Annotations/ordinary.md', '# Just a note');
    vault.files.set('Annotations/broken.md', '---\nmargin-ai: true\nid: [\n---\n');
    const repository = new AnnotationRepository(vault, 'Annotations');
    await expect(repository.listForSource('Note.md')).rejects.toThrow(/broken\.md/i);
  });

  it('updates from current vault content so manual edits are never overwritten', async () => {
    const vault = new MemoryVault();
    const repository = new AnnotationRepository(vault, 'Annotations');
    const path = await repository.create({ ...base, messages: [pending] });
    vault.files.set(path, vault.files.get(path)!.replace('# Conversation', '# Conversation\n\nManual edit.'));
    await repository.replaceMessage(path, base.id, { ...pending, status: 'complete', content: 'Answer.' });
    expect(vault.files.get(path)).toContain('Manual edit.');
    expect(parseAnnotation(vault.files.get(path)!).messages[0].content).toBe('Answer.');
  });

  it('finds a renamed companion by stable annotation ID before an async result write', async () => {
    const vault = new MemoryVault();
    const repository = new AnnotationRepository(vault, 'Annotations');
    const original = await repository.create({ ...base, messages: [pending] });
    const renamed = 'Annotations/User renamed this.md';
    vault.files.set(renamed, vault.files.get(original)!);
    vault.files.delete(original);
    const actual = await repository.replaceMessage(original, base.id, { ...pending, status: 'complete', content: 'Safe answer.' });
    expect(actual).toBe(renamed);
    expect(parseAnnotation(vault.files.get(renamed)!).messages[0].content).toBe('Safe answer.');
  });

  it('marks pending messages interrupted when loading after restart', async () => {
    const vault = new MemoryVault();
    const repository = new AnnotationRepository(vault, 'Annotations');
    const path = await repository.create({ ...base, messages: [pending] });
    await repository.recoverInterrupted();
    expect(parseAnnotation(vault.files.get(path)!).messages[0].status).toBe('interrupted');
  });

  it('updates source paths without disturbing messages', async () => {
    const vault = new MemoryVault();
    vault.files.set('Annotations/a.md', appendMessage(createAnnotationDocument(base), {
      id: 'u1', role: 'user', createdAt: base.createdAt, status: 'complete', content: 'Keep this.',
    }));
    const repository = new AnnotationRepository(vault, 'Annotations');
    await repository.renameSource('Note.md', 'Archive/Note.md');
    const parsed = parseAnnotation(vault.files.get('Annotations/a.md')!);
    expect(parsed.source.path).toBe('Archive/Note.md');
    expect(parsed.messages[0].content).toBe('Keep this.');
  });
});
