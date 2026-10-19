import { Component, setIcon } from 'obsidian';
import type { SourceCapture } from './types';
import type { MarginController } from './controller';
import type { EditorView } from '@codemirror/view';

export class SelectionToolbar extends Component {
	private element: HTMLElement | null = null;
	private generation = 0;
	constructor(private readonly controller: MarginController) { super(); }

	onload(): void {
		this.registerDomEvent(activeWindow.document, 'selectionchange', () => void this.update());
		this.registerDomEvent(activeWindow.document, 'keydown', (event) => { if (event.key === 'Escape') this.hide(); });
		this.register(() => this.hide());
	}

	showEditorSelection(capture: SourceCapture, view: EditorView): void {
		const generation = ++this.generation;
		view.dom.ownerDocument.defaultView?.requestAnimationFrame(() => {
			if (generation !== this.generation || !view.dom.isConnected || !view.hasFocus) return;
			const selection = view.state.selection.main;
			if (selection.empty || selection.from !== capture.startOffset || selection.to !== capture.endOffset) return;
			const rect = view.coordsAtPos(selection.from);
			if (rect) this.show({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top } as DOMRect, capture);
		});
	}

	private async update(): Promise<void> {
		const generation = ++this.generation;
		const selection = activeWindow.getSelection();
		if (!selection || selection.isCollapsed || !selection.toString().trim() || selection.rangeCount === 0) { this.hide(); return; }
		const node = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
		if (!node?.closest('.markdown-source-view, .pdf-viewer')) { this.hide(); return; }
		const capture = await this.controller.captureActive(false, false);
		if (generation !== this.generation) return;
		if (!capture?.quote) { this.hide(); return; }
		const rect = selection.getRangeAt(0).getBoundingClientRect();
		this.show(rect, capture);
	}

	private show(rect: DOMRect, capture: SourceCapture): void {
		this.hide();
		const toolbar = activeWindow.document.body.createDiv({ cls: 'margin-ai-selection-toolbar' });
		toolbar.style.left = `${Math.max(8, Math.min(rect.left, activeWindow.innerWidth - 190))}px`;
		toolbar.style.top = `${Math.max(8, rect.top - 38)}px`;
		const add = (label: string, icon: string, action: () => void) => {
			const button = toolbar.createEl('button', { attr: { 'aria-label': label } }); setIcon(button, icon);
			button.createSpan({ text: label });
			button.addEventListener('mousedown', (event) => event.preventDefault());
			button.addEventListener('click', () => { action(); this.hide(); });
		};
		const suffix = capture.kind === 'pdf' ? ' (edits PDF)' : '';
		add(`Annotate${suffix}`, 'highlighter', () => void this.controller.startAnnotation(capture));
		add(`Ask${suffix}`, 'message-square-text', () => void this.controller.startAnnotation(capture));
		this.element = toolbar;
	}

	private hide(): void { this.generation++; this.element?.remove(); this.element = null; }
}
