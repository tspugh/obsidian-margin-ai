import { describe, expect, it } from 'vitest';
import { createRequestContextSnapshot, isPathAllowed, resolveContextScope, retrieveLocalContext } from '../src/margin-ai/context';
import type { ContextScope, MarkdownContextReader } from '../src/margin-ai/types';

describe('context scope', () => {
  it.each([
    [{ kind: 'folder', ancestorDepth: 0 }, 'A/B'],
    [{ kind: 'folder', ancestorDepth: 1 }, 'A'],
    [{ kind: 'folder', ancestorDepth: 2 }, ''],
  ] as const)('resolves folder ancestry %j', (scope, expected) => {
    expect(resolveContextScope('A/B/n.md', scope)).toEqual({ kind: 'folder', root: expected });
  });

  it('requires vault scope to be explicitly selected', () => {
    expect(resolveContextScope('A/B/n.md', { kind: 'vault' })).toEqual({ kind: 'vault', root: '' });
    expect(() => resolveContextScope('A/B/n.md', { kind: 'folder', ancestorDepth: 3 })).toThrow(/depth/i);
  });

  it.each(['../secret.md', '/absolute.md', 'A/../../secret.md', 'A\\note.md', '', '.obsidian/x.md'])('rejects invalid source paths: %s', (path) => {
    expect(() => resolveContextScope(path, { kind: 'document' })).toThrow(/path/i);
  });

  it('uses segment boundaries and applies built-in and configured exclusions', () => {
    const scope = resolveContextScope('A/n.md', { kind: 'folder', ancestorDepth: 0 });
    expect(isPathAllowed('A/ok.md', scope, { companionFolder: 'Margin AI', excludedFolders: ['A/private'] })).toBe(true);
    expect(isPathAllowed('AB/not-in-scope.md', scope, { companionFolder: 'Margin AI', excludedFolders: [] })).toBe(false);
    expect(isPathAllowed('A/.hidden/no.md', scope, { companionFolder: 'Margin AI', excludedFolders: [] })).toBe(false);
    expect(isPathAllowed('A/private/no.md', scope, { companionFolder: 'Margin AI', excludedFolders: ['A/private'] })).toBe(false);
    expect(isPathAllowed('A/private-ish/yes.md', scope, { companionFolder: 'Margin AI', excludedFolders: ['A/private'] })).toBe(true);
    expect(isPathAllowed('Margin AI/no.md', { kind: 'vault', root: '' }, { companionFolder: 'Margin AI', excludedFolders: [] })).toBe(false);
    expect(isPathAllowed('A/image.png', scope, { companionFolder: 'Margin AI', excludedFolders: [] })).toBe(false);
  });

  it('uses the source only for document scope and reads no files for passage scope', () => {
    const options = { companionFolder: 'Margin AI', excludedFolders: [] };
    expect(isPathAllowed('A/n.md', resolveContextScope('A/n.md', { kind: 'document' }), options)).toBe(true);
    expect(isPathAllowed('A/other.md', resolveContextScope('A/n.md', { kind: 'document' }), options)).toBe(false);
    expect(isPathAllowed('A/n.md', resolveContextScope('A/n.md', { kind: 'passage' }), options)).toBe(false);
    expect(isPathAllowed('A/private/n.md', resolveContextScope('A/private/n.md', { kind: 'document' }), {
      companionFolder: 'Margin AI', excludedFolders: ['A/private'],
    })).toBe(false);
  });
});

describe('request context snapshot', () => {
  it('copies and freezes request settings so selector changes cannot broaden retries', () => {
    const mutable: ContextScope = { kind: 'folder', ancestorDepth: 0 };
    const excludedFolders = ['Archive'];
    const sources = [{ path: 'A/related.md', excerptCharacters: 20, matchedTerms: ['alpha'] }];
    const snapshot = createRequestContextSnapshot(
      'A/B/n.md', mutable, 'gpt-test', { companionFolder: 'Margin AI', excludedFolders },
      { sources, retrieval: { examinedCount: 1, matchedCount: 1, truncated: false, noResults: false }, selectedNotePaths: ['A/chosen.md'] },
    );
    mutable.ancestorDepth = 2;
    excludedFolders.push('A');
    sources[0].matchedTerms.push('later');
    expect(snapshot).toEqual({
      sourcePath: 'A/B/n.md', scope: { kind: 'folder', ancestorDepth: 0 }, model: 'gpt-test',
      companionFolder: 'Margin AI', excludedFolders: ['Archive'],
      sources: [{ path: 'A/related.md', excerptCharacters: 20, matchedTerms: ['alpha'] }],
      retrieval: { examinedCount: 1, matchedCount: 1, truncated: false, noResults: false },
      selectedNotePaths: ['A/chosen.md'],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scope)).toBe(true);
    expect(Object.isFrozen(snapshot.excludedFolders)).toBe(true);
    expect(Object.isFrozen(snapshot.sources)).toBe(true);
    expect(Object.isFrozen(snapshot.sources?.[0].matchedTerms)).toBe(true);
    expect(Object.isFrozen(snapshot.selectedNotePaths)).toBe(true);
  });
});

describe('bounded local keyword retrieval', () => {
  const reader = (files: Record<string, string>, unsafe: string[] = []): MarkdownContextReader & { reads: string[] } => {
    const reads: string[] = [];
    return {
      reads,
      async listMarkdownPaths() { return Object.keys(files); },
      async isSafeMarkdownPath(path) { return !unsafe.includes(path); },
      async readMarkdown(path) { reads.push(path); return files[path]; },
    };
  };

  it('returns bounded excerpts near keyword matches with actual source counts', async () => {
    const files = Object.fromEntries(Array.from({ length: 110 }, (_, index) => [
      `A/${String(index).padStart(3, '0')}.md`, index < 8 ? `prefix ${'x'.repeat(200)} alpha beta ${'y'.repeat(5000)}` : 'irrelevant',
    ]));
    const vault = reader(files);
    const result = await retrieveLocalContext(vault, {
      sourcePath: 'A/source.md', scope: { kind: 'folder', ancestorDepth: 0 }, query: 'alpha beta', companionFolder: 'Margin AI', excludedFolders: [],
    });
    expect(vault.reads).toHaveLength(100);
    expect(result.examinedCount).toBe(100);
    expect(result.matchedCount).toBe(8);
    expect(result.readSources).toHaveLength(100);
    expect(result.excerpts).toHaveLength(4);
    expect(result.excerpts.every((item) => item.text.length <= 4000 && item.text.includes('alpha beta'))).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.noResults).toBe(false);
  });

  it('does not read excluded, unsafe, or out-of-scope paths', async () => {
    const vault = reader({ 'A/ok.md': 'needle', 'A/private/no.md': 'needle', 'A/link.md': 'needle', 'AB/no.md': 'needle' }, ['A/link.md']);
    const result = await retrieveLocalContext(vault, {
      sourcePath: 'A/source.md', scope: { kind: 'folder', ancestorDepth: 0 }, query: 'needle', companionFolder: 'Margin AI', excludedFolders: ['A/private'],
    });
    expect(vault.reads).toEqual(['A/ok.md']);
    expect(result.excerpts.map((item) => item.path)).toEqual(['A/ok.md']);
  });

  it('includes explicitly selected safe notes without a lexical match and reports rejected selections', async () => {
    const vault = reader({
      'A/match.md': 'needle',
      'Elsewhere/chosen.md': 'deliberately unrelated prose',
      'Private/no.md': 'needle',
      'Margin AI/companion.md': 'needle',
    });
    const result = await retrieveLocalContext(vault, {
      sourcePath: 'A/source.md', scope: { kind: 'folder', ancestorDepth: 0 }, query: 'needle',
      companionFolder: 'Margin AI', excludedFolders: ['Private'],
      selectedNotePaths: ['Elsewhere/chosen.md', 'Private/no.md', 'Margin AI/companion.md', 'missing.md'],
    });
    expect(result.excerpts.map(item => item.path)).toEqual(['Elsewhere/chosen.md', 'A/match.md']);
    expect(result.excerpts[0].matchedTerms).toEqual([]);
    expect(result.omittedSelectedNotePaths).toEqual(['Margin AI/companion.md', 'missing.md', 'Private/no.md']);
  });

  it('returns an explicit no-results report without including file contents', async () => {
    const result = await retrieveLocalContext(reader({ 'A/n.md': 'private prose' }), {
      sourcePath: 'A/n.md', scope: { kind: 'passage' }, query: 'prose', companionFolder: 'Margin AI', excludedFolders: [],
    });
    expect(result).toMatchObject({ examinedCount: 0, matchedCount: 0, readSources: [], excerpts: [], noResults: true });
  });

  it('includes bounded Markdown document text even when the query has no keyword match', async () => {
    const result = await retrieveLocalContext(reader({ 'A/n.md': `document body ${'x'.repeat(5000)}` }), {
      sourcePath: 'A/n.md', scope: { kind: 'document' }, query: 'summarize this', companionFolder: 'Margin AI', excludedFolders: [],
    });
    expect(result.excerpts).toHaveLength(1);
    expect(result.excerpts[0].path).toBe('A/n.md');
    expect(result.excerpts[0].text).toHaveLength(4000);
    expect(result.matchedCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('honors cancellation before work and after awaited adapter calls', async () => {
    const before = new AbortController();
    before.abort();
    await expect(retrieveLocalContext(reader({ 'A/n.md': 'needle' }), {
      sourcePath: 'A/n.md', scope: { kind: 'document' }, query: 'needle', companionFolder: 'Margin AI', excludedFolders: [], signal: before.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    const after = new AbortController();
    const cancellingReader: MarkdownContextReader = {
      async listMarkdownPaths() { after.abort(); return ['A/n.md']; },
      async isSafeMarkdownPath() { return true; },
      async readMarkdown() { return 'needle'; },
    };
    await expect(retrieveLocalContext(cancellingReader, {
      sourcePath: 'A/n.md', scope: { kind: 'document' }, query: 'needle', companionFolder: 'Margin AI', excludedFolders: [], signal: after.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not pretend to retrieve whole-document PDF context but permits explicit folder search from a PDF', async () => {
    await expect(retrieveLocalContext(reader({}), {
      sourcePath: 'A/paper.pdf', scope: { kind: 'document' }, query: 'needle', companionFolder: 'Margin AI', excludedFolders: [],
    })).rejects.toThrow(/PDF.*passage/i);
    const result = await retrieveLocalContext(reader({ 'A/note.md': 'needle' }), {
      sourcePath: 'A/paper.pdf', scope: { kind: 'folder', ancestorDepth: 0 }, query: 'needle', companionFolder: 'Margin AI', excludedFolders: [],
    });
    expect(result.excerpts.map((excerpt) => excerpt.path)).toEqual(['A/note.md']);
  });
});
