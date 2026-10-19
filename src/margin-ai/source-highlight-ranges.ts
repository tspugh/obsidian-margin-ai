import { resolveMarkdownAnchor } from './anchors';
import type { Annotation } from './types';

export interface HighlightRange { annotationId: string; from: number; to: number }
export function resolveHighlightRanges(path: string, text: string, annotations: readonly Annotation[]): HighlightRange[] {
	const ranges: HighlightRange[] = [];
	for (const annotation of annotations) {
		const source = annotation.source;
		if (source.kind !== 'markdown' || source.path !== path || !source.quote || source.startOffset === undefined || source.endOffset === undefined) continue;
		const result = resolveMarkdownAnchor(text, source as Required<Pick<typeof source, 'quote' | 'contextBefore' | 'contextAfter' | 'startOffset' | 'endOffset'>>);
		if (result.status === 'resolved') ranges.push({ annotationId: annotation.id, from: result.startOffset, to: result.endOffset });
	}
	return ranges;
}
