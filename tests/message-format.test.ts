import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters } from '../src/margin-ai/message-format';

describe('math display normalization', () => {
	it('renders inline bra-ket notation', () => {
		expect(normalizeMathDelimiters(String.raw`One qubit: \(|0\rangle\) or \(|1\rangle\).`)).toBe(String.raw`One qubit: $|0\rangle$ or $|1\rangle$.`);
	});
	it('renders display math on its own lines', () => {
		expect(normalizeMathDelimiters(String.raw`State: \[\alpha|0\rangle+\beta|1\rangle\] Next.`)).toBe('State: \n$$\n' + String.raw`\alpha|0\rangle+\beta|1\rangle` + '\n$$\n Next.');
	});
	it('preserves existing dollar math, escaped slashes and unmatched delimiters', () => {
		const content = String.raw`$x$ $$y$$ \\(literal\\) \(unfinished`;
		expect(normalizeMathDelimiters(content)).toBe(content);
	});
	it('does not convert inline or fenced code examples', () => {
		const content = '`\\(x\\)`\n```tex\n\\[x\\]\n```\n~~~tex\n\\(y\\)\n~~~';
		expect(normalizeMathDelimiters(content)).toBe(content);
	});
	it('supports multiline display math', () => {
		expect(normalizeMathDelimiters('\\[\nx + y\n\\]')).toBe('\n$$\nx + y\n$$\n');
	});
	it('preserves code spans that contain a literal backtick', () => {
		const content = '``a ` \\(x\\)``';
		expect(normalizeMathDelimiters(content)).toBe(content);
	});
	it.each([
		'``\\(x\\) ` a``',
		'```tex\n\\(x\\)\n````',
		'> ```tex\n> \\(x\\)\n> ```',
		'    \\(x\\)',
		'```tex\n\\(x\\)',
	])('preserves literal code: %s', (content) => {
		expect(normalizeMathDelimiters(content)).toBe(content);
	});
});
