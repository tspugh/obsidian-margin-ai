import { describe, expect, it } from 'vitest';
import { DocumentTextCache, buildDocumentContext, pagesMentionedInQuery, parsePageOverride, selectImagePages } from '../src/margin-ai/document-reading';

describe('document reading policy', () => {
  it('versions and bounds the extraction cache', async () => {
    const cache = new DocumentTextCache(2); let calls = 0;
    const load = async () => ({ pages: [`v${++calls}`], pageCount: 1 });
    expect((await cache.get('a.pdf', 1, 10, load)).pages[0]).toBe('v1');
    expect((await cache.get('a.pdf', 1, 10, load)).pages[0]).toBe('v1');
    expect((await cache.get('a.pdf', 2, 10, load)).pages[0]).toBe('v2');
    await cache.get('b.pdf', 1, 1, load); await cache.get('c.pdf', 1, 1, load);
    expect(cache.has('a.pdf', 2, 10)).toBe(false);
  });

  it('deduplicates concurrent extraction and bounds cached text memory', async () => {
    const cache = new DocumentTextCache(4, 8); let calls = 0;
    const load = async () => { calls++; return { pages: ['123456'], pageCount: 1 }; };
    await Promise.all([cache.get('a', 1, 1, load), cache.get('a', 1, 1, load)]);
    expect(calls).toBe(1);
    await cache.get('b', 1, 1, load);
    expect(cache.has('a', 1, 1)).toBe(false);
  });

  it('query ranks oversized pages, keeps anchor, and discloses partial coverage', () => {
    const pages = Array.from({ length: 5 }, (_, i) => i === 3 ? 'rare systems insight '.repeat(30) : `page ${i + 1} filler `.repeat(30));
    const result = buildDocumentContext(pages, 'rare systems', 2, 260);
    expect(result.text).toContain('[Page 4]');
    expect(result.text).toContain('[Page 2]');
    expect(result.partial).toBe(true);
    expect(result.disclosure).toMatch(/partial/i);
    expect(result.text.length).toBeLessThanOrEqual(260);
  });
  it('preserves every page when the whole document fits and marks clipped single pages partial', () => {
    const fitting = buildDocumentContext(['a'.repeat(70_000), 'short'], '', 1, 120_000);
    expect(fitting.partial).toBe(false); expect(fitting.text).toContain('a'.repeat(70_000)); expect(fitting.text).toContain('short');
    const clipped = buildDocumentContext(['z'.repeat(150_000)], 'z', 1, 120_000);
    expect(clipped.partial).toBe(true); expect(clipped.disclosure).toMatch(/partial/i);
  });
  it('centers an oversized one-page excerpt on query terms instead of taking only the prefix', () => {
    const text = `${'prefix '.repeat(20_000)}UNIQUE NEEDLE surrounding explanation${' suffix'.repeat(2_000)}`;
    const result = buildDocumentContext([text], 'unique needle', 1, 4_000);
    expect(result.text).toContain('UNIQUE NEEDLE surrounding explanation');
    expect(result.text).not.toContain('prefix '.repeat(500));
    expect(result.partial).toBe(true);
  });

  it('validates explicit image pages and chooses current plus relevant pages', () => {
    expect(parsePageOverride('1, 3,3', 5, 3)).toEqual([1, 3]);
    expect(() => parsePageOverride('1, 6', 5, 3)).toThrow(/1–5/);
    expect(() => parsePageOverride('1,2,3,4', 5, 3)).toThrow(/maximum 3/i);
    expect(selectImagePages(4, [2, 4, 5], 8, 3)).toEqual([4, 2, 5]);
    expect(pagesMentionedInQuery('compare page 7 with p. 3', 8)).toEqual([7, 3]);
  });
});
