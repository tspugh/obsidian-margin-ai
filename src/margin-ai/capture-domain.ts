import type { SourceCapture } from './types';

const CONTEXT_CHARS = 80;
const WHOLE_NOTE_CHARS = 20_000;

export function captureMarkdown(path: string, text: string, startOffset: number, endOffset: number): SourceCapture {
	const start = Math.max(0, Math.min(startOffset, text.length));
	const end = Math.max(start, Math.min(endOffset, text.length));
	const quote = text.slice(start, end);
	const wholeNote = quote.length === 0;
	return {
		kind: 'markdown',
		path,
		link: `[[${path}]]`,
		quote,
		contextBefore: wholeNote ? '' : text.slice(Math.max(0, start - CONTEXT_CHARS), start),
		contextAfter: wholeNote ? text.slice(0, WHOLE_NOTE_CHARS) : text.slice(end, end + CONTEXT_CHARS),
		startOffset: start,
		endOffset: end,
		scopeLabel: wholeNote
			? `Whole note · ${text.length} characters${text.length > WHOLE_NOTE_CHARS ? ' (first 20,000 sent)' : ''}`
			: `Selected text · ${quote.length} characters`,
	};
}

export function capturePdf(
	path: string,
	quote: string,
	page: number,
	selection?: [number, number, number, number],
): SourceCapture {
	const suffix = selection ? `&selection=${selection.join(',')}` : '';
	return {
		kind: 'pdf',
		path,
		link: `[[${path}#page=${page}${suffix}]]`,
		quote,
		contextBefore: '',
		contextAfter: '',
		page,
		pdfSelection: selection,
		scopeLabel: quote ? `PDF page ${page} selection · ${quote.length} characters` : `PDF page ${page}`,
	};
}

