import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PERSONALIZATION,
	PersonalizationError,
	buildPersonalizationInstructions,
	queueMemorySuggestions,
	createDefaultPersonalization,
	parseMemorySuggestions,
	parsePersonalizationMarkdown,
	serializePersonalizationMarkdown,
} from '../src/margin-ai/personalization';

describe('personalization profile codec', () => {
	it('round trips a versioned, readable Markdown profile', () => {
		const profile = createDefaultPersonalization();
		profile.memoryEnabled = true;
		profile.memories.push({ id: 'memory-1', text: 'I understand eigenvectors but not Jordan form.', enabled: true, createdAt: '2026-10-18T00:00:00.000Z', source: { annotationPath: 'Annotations/a.md', messageId: 'u1', quote: 'I understand eigenvectors but not Jordan form.' } });
		const markdown = serializePersonalizationMarkdown(profile);
		expect(markdown).toContain('# Margin AI Profile');
		expect(markdown).toContain('```json');
		expect(parsePersonalizationMarkdown(markdown)).toEqual(profile);
	});

	it('rejects malformed and unsupported profiles instead of coercing them', () => {
		expect(() => parsePersonalizationMarkdown('# Margin AI Profile\n```json\nnope\n```')).toThrow(PersonalizationError);
		expect(() => parsePersonalizationMarkdown('# Margin AI Profile\n```json\n{"version":99}\n```')).toThrow(/unsupported version/i);
	});

	it('starts disabled with no personal facts and safe built-in styles', () => {
		expect(DEFAULT_PERSONALIZATION.memoryEnabled).toBe(false);
		expect(DEFAULT_PERSONALIZATION.suggestionsEnabled).toBe(false);
		expect(DEFAULT_PERSONALIZATION.memories).toEqual([]);
		expect(DEFAULT_PERSONALIZATION.styles.map(style => style.name)).toEqual(['Concise', 'Mathematical detail']);
		expect(DEFAULT_PERSONALIZATION.styles[1].instructions).toMatch(/do not invent/i);
	});
});

describe('personalization request context', () => {
	it('includes only enabled approved memories and the selected style', () => {
		const profile = createDefaultPersonalization();
		profile.memoryEnabled = true;
		profile.memories = [
			{ id: 'on', text: 'Comfortable with derivatives.', enabled: true, createdAt: 'now' },
			{ id: 'off', text: 'Do not include this.', enabled: false, createdAt: 'now' },
		];
		profile.pending = [{ id: 'pending', text: 'Never active yet.', evidenceQuote: 'quote', createdAt: 'now', source: { annotationPath: 'a.md', messageId: 'u' } }];
		const instructions = buildPersonalizationInstructions(profile);
		expect(instructions.style).toContain('concise');
		expect(instructions.memory).toContain('Comfortable with derivatives.');
		expect(instructions.memory).toContain('untrusted');
		expect(instructions.memory).not.toContain('Do not include this');
		expect(instructions.memory).not.toContain('Never active yet');
	});

	it('omits all memory when the master switch is disabled', () => {
		const profile = createDefaultPersonalization();
		profile.memories = [{ id: 'm', text: 'A fact.', enabled: true, createdAt: 'now' }];
		expect(buildPersonalizationInstructions(profile).memory).toBe('');
	});
});

describe('memory suggestion validation', () => {
	it('accepts bounded suggestions only when evidence is an exact user-message quote', () => {
		const result = parseMemorySuggestions('[{"text":"The user says they do not know measure theory.","evidenceQuote":"I do not know measure theory"}]', ['Could you explain? I do not know measure theory.']);
		expect(result).toHaveLength(1);
		expect(result[0].evidenceQuote).toBe('I do not know measure theory');
	});

	it('rejects invented evidence and question-only knowledge inference', () => {
		expect(parseMemorySuggestions('[{"text":"The user knows topology.","evidenceQuote":"I know topology"}]', ['What is topology?'])).toEqual([]);
		expect(parseMemorySuggestions('[{"text":"The user is learning topology.","evidenceQuote":"What is topology?"}]', ['What is topology?'])).toEqual([]);
	});

	it('queues only novel pending suggestions and preserves source evidence', () => {
		const profile = createDefaultPersonalization();
		profile.memories.push({ id: 'm', text: 'Already known.', enabled: true, createdAt: 'now' });
		profile.rejected.push({ text: 'Rejected before.', evidenceQuote: 'No thanks.', rejectedAt: 'now' });
		queueMemorySuggestions(profile, [
			{ text: 'Already known.', evidenceQuote: 'I said this.' },
			{ text: 'Rejected before.', evidenceQuote: 'No thanks.' },
			{ text: 'New preference.', evidenceQuote: 'Please show the algebra.' },
		], { annotationPath: 'Annotations/thread.md', messageId: 'user-1' }, '2026-10-19T00:00:00.000Z', () => 'suggestion-1');
		expect(profile.pending).toEqual([{ id: 'suggestion-1', text: 'New preference.', evidenceQuote: 'Please show the algebra.', createdAt: '2026-10-19T00:00:00.000Z', source: { annotationPath: 'Annotations/thread.md', messageId: 'user-1', quote: 'Please show the algebra.' } }]);
	});
});
