import { describe, expect, it } from 'vitest';
import { assertExportDestinationAvailable, buildExportMarkdown, validateExportPath } from '../src/margin-ai/export-note';

describe('create-only export', () => {
  it('rejects unsafe and non-markdown destinations', () => {
    for (const path of ['/x.md', '../x.md', '.obsidian/x.md', 'x.txt', 'C:/x.md', 'A//x.md', 'bad\u0000.md']) expect(() => validateExportPath(path)).toThrow();
    expect(validateExportPath('Margin Notes/Idea.md')).toBe('Margin Notes/Idea.md');
  });
  it('renders source, summary, quote and normalized math transcript', () => {
    const output = buildExportMarkdown({ sourceLink: '[[Paper.pdf#page=2]]', quote: 'original', summary: 'Useful', messages: [{ role: 'assistant', content: '\\(x^2\\)' }] });
    expect(output).toContain('[[Paper.pdf#page=2]]'); expect(output).toContain('> original');
    expect(output).toContain('$x^2$'); expect(output).toContain('> [!note]- Conversation');
  });
  it('keeps consecutive transcript lines consecutive inside the collapsed callout', () => {
    const output = buildExportMarkdown({ sourceLink: '[[x]]', quote: '', messages: [{ role: 'assistant', content: '- one\n- two' }] });
    expect(output).toContain('> - one\n> - two');
    expect(output).not.toContain('> - one\n>\n> - two');
  });
  it('refuses an existing destination before any create-only write', () => {
    const exists = (path: string) => path === 'Margin Notes/Idea.md';
    expect(() => assertExportDestinationAvailable('Margin Notes/Idea.md', exists)).toThrow(/already exists/i);
    expect(assertExportDestinationAvailable('Margin Notes/New.md', exists)).toBe('Margin Notes/New.md');
  });
});
