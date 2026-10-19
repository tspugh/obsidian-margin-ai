import type { AnchorResolution, MarkdownAnchor } from './types';

function allOccurrences(text: string, quote: string): number[] {
	if (!quote) return [];
	const offsets: number[] = [];
	let from = 0;
	while (from <= text.length - quote.length) {
		const index = text.indexOf(quote, from);
		if (index < 0) break;
		offsets.push(index);
		from = index + Math.max(1, quote.length);
	}
	return offsets;
}

export function resolveMarkdownAnchor(text: string, anchor: MarkdownAnchor): AnchorResolution {
	const offsets = allOccurrences(text, anchor.quote);
	if (offsets.length === 0) return { status: 'missing' };
	if (offsets.length === 1) {
		return { status: 'resolved', startOffset: offsets[0], endOffset: offsets[0] + anchor.quote.length };
	}

	if (anchor.contextBefore || anchor.contextAfter) {
		const contextual = offsets.filter((offset) => {
			const before = text.slice(Math.max(0, offset - anchor.contextBefore.length), offset);
			const afterStart = offset + anchor.quote.length;
			const after = text.slice(afterStart, afterStart + anchor.contextAfter.length);
			return before === anchor.contextBefore && after === anchor.contextAfter;
		});
		if (contextual.length === 1) {
			return {
				status: 'resolved',
				startOffset: contextual[0],
				endOffset: contextual[0] + anchor.quote.length,
			};
		}
	}

	return { status: 'ambiguous', matches: offsets.length };
}
