import { resolveMarkdownAnchor } from './anchors';
import type { AnchorResolution, Annotation } from './types';

export interface OrderedAnnotation {
	annotation: Annotation;
	group: 'passage' | 'whole-document';
	anchorStatus: AnchorResolution['status'] | 'pdf' | 'whole-document';
}

interface Sortable extends OrderedAnnotation {
	index: number;
	key: number[];
}

export function orderAnnotations(annotations: readonly Annotation[], options: { markdownText?: string } = {}): OrderedAnnotation[] {
	const sortable: Sortable[] = annotations.map((annotation, index) => {
		const source = annotation.source;
		if (!source.quote) return { annotation, index, group: 'whole-document', anchorStatus: 'whole-document', key: [1] };
		if (source.kind === 'pdf') {
			const tuple = source.pdfSelection ?? [];
			const resolved = Number.isFinite(source.page) && tuple.length === 4 && tuple.every(Number.isFinite);
			return {
				annotation, index, group: 'passage', anchorStatus: resolved ? 'pdf' : 'missing',
				key: resolved ? [0, 0, source.page as number, ...tuple] : [0, 3],
			};
		}
		if (options.markdownText === undefined || source.startOffset === undefined || source.endOffset === undefined) {
			return { annotation, index, group: 'passage', anchorStatus: 'missing', key: [0, 3] };
		}
		const resolution = resolveMarkdownAnchor(options.markdownText, {
			quote: source.quote, contextBefore: source.contextBefore, contextAfter: source.contextAfter,
			startOffset: source.startOffset, endOffset: source.endOffset,
		});
		if (resolution.status === 'resolved') {
			return { annotation, index, group: 'passage', anchorStatus: 'resolved', key: [0, 0, resolution.startOffset, resolution.endOffset] };
		}
		return { annotation, index, group: 'passage', anchorStatus: resolution.status, key: [0, resolution.status === 'ambiguous' ? 2 : 3] };
	});
	const compareKey = (left: number[], right: number[]): number => {
		for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
			const difference = (left[index] ?? 0) - (right[index] ?? 0);
			if (difference !== 0) return difference;
		}
		return 0;
	};
	return sortable
		.sort((left, right) => compareKey(left.key, right.key) || left.index - right.index)
		.map(({ annotation, group, anchorStatus }) => ({ annotation, group, anchorStatus }));
}
