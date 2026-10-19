import type { Annotation, SourceCapture } from './types';
import { captureMarkdown } from './capture-domain';
import { resolveHighlightRanges } from './source-highlight-ranges';
import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet, ViewPlugin } from '@codemirror/view';
import { editorInfoField } from 'obsidian';

export const refreshMarginHighlights = StateEffect.define<void>();

/** CodeMirror selections need not be reflected in the browser DOM selection. */
export function createMarkdownSelectionExtension(capture: (source: SourceCapture, view: EditorView) => void) {
	return EditorView.updateListener.of((update) => {
		if (!update.selectionSet && !update.docChanged) return;
		const info = update.state.field(editorInfoField, false);
		const selection = update.state.selection.main;
		if (!info?.file?.path || selection.empty) return;
		capture(captureMarkdown(info.file.path, update.state.doc.toString(), selection.from, selection.to), update.view);
	});
}

export function createMarkdownHighlightExtension(annotations: () => readonly Annotation[], open: (id: string) => void) {
	const build = (state: EditorState): DecorationSet => {
		const info = state.field(editorInfoField, false);
		if (!info?.file?.path) return Decoration.none;
		return Decoration.set(resolveHighlightRanges(info.file.path, state.doc.toString(), annotations()).map((range) =>
			Decoration.mark({ class: 'margin-ai-source-highlight', attributes: { 'data-margin-ai-id': range.annotationId } }).range(range.from, range.to)), true);
	};
	const field = StateField.define<DecorationSet>({
		create: build,
		update(value, transaction) {
			return transaction.docChanged || transaction.effects.some((effect) => effect.is(refreshMarginHighlights)) ? build(transaction.state) : value;
		},
		provide: (source) => EditorView.decorations.from(source),
	});
	const clicks = ViewPlugin.fromClass(class {
		constructor(readonly view: EditorView) {
			this.onClick = this.onClick.bind(this); view.dom.addEventListener('click', this.onClick);
		}
		onClick(event: MouseEvent): void { const id = (event.target as HTMLElement).closest<HTMLElement>('.margin-ai-source-highlight')?.dataset.marginAiId; if (id) open(id); }
		destroy(): void { this.view.dom.removeEventListener('click', this.onClick); }
	});
	return [field, clicks];
}
