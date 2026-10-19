import { Component } from 'obsidian';

import type PDFPlus from 'main';
import type { PDFPageView, ObsidianViewer } from 'typings';
import { getNodeAndOffsetOfTextPos, getTextLayerInfo } from 'utils';
import type { SavedAnnotation } from './repository';

const HIGHLIGHT_NAME = 'margin-ai-source-highlight';

type HighlightRegistry = {
	set(name: string, highlight: unknown): void;
	delete(name: string): boolean;
};

type RangeMarker = { id: string; range: Range; viewer: ObsidianViewer; page: number; overlay: boolean };
type ViewerState = {
	viewer: ObsidianViewer;
	path: string;
	pages: Map<number, PDFPageView>;
	viewerEl: HTMLElement;
	lifecycle: Component;
	onClick: (event: MouseEvent) => void;
};

function highlightApi(): { registry: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
	const root = globalThis as typeof globalThis & {
		CSS?: { highlights?: HighlightRegistry };
		Highlight?: new (...ranges: Range[]) => unknown;
	};
	return root.CSS?.highlights && root.Highlight
		? { registry: root.CSS.highlights, Highlight: root.Highlight }
		: null;
}

function pointInRect(event: MouseEvent, rect: DOMRect): boolean {
	return event.clientX >= rect.left && event.clientX <= rect.right
		&& event.clientY >= rect.top && event.clientY <= rect.bottom;
}

function validTuple(value: unknown): value is [number, number, number, number] {
	if (!Array.isArray(value) || value.length !== 4
		|| value.some((part) => !Number.isInteger(part) || part < 0)) return false;
	const [beginIndex, beginOffset, endIndex, endOffset] = value;
	return beginIndex < endIndex || (beginIndex === endIndex && beginOffset <= endOffset);
}

function makeRange(pageView: PDFPageView, tuple: [number, number, number, number]): Range | null {
	if (!pageView.textLayer) return null;
	const info = getTextLayerInfo(pageView.textLayer);
	if (!info) return null;
	const [beginIndex, beginOffset, endIndex, endOffset] = tuple;
	if (!Number.isInteger(beginIndex) || !Number.isInteger(endIndex)
		|| beginIndex < 0 || endIndex < beginIndex || endIndex >= info.textDivs.length) return null;
	const begin = getNodeAndOffsetOfTextPos(info.textDivs[beginIndex], beginOffset);
	const end = getNodeAndOffsetOfTextPos(info.textDivs[endIndex], endOffset);
	if (!begin || !end) return null;
	const range = info.textDivs[beginIndex].ownerDocument.createRange();
	try {
		range.setStart(begin.node, begin.offset);
		range.setEnd(end.node, end.offset);
	} catch {
		return null;
	}
	return range;
}

/** Temporary, source-safe PDF markers backed by the browser's Custom Highlight API. */
export class PDFSourceHighlights extends Component {
	private readonly viewers = new Map<ObsidianViewer, ViewerState>();
	private markers: RangeMarker[] = [];
	private disposed = false;
	private generation = 0;

	constructor(
		private readonly plugin: PDFPlus,
		private readonly annotations: () => readonly SavedAnnotation[],
		private readonly open: (id: string) => void,
	) {
		super();
		this.register(() => {
			this.disposed = true;
			this.generation++;
			this.clear();
		});
	}

	refresh(): void {
		if (this.disposed || !highlightApi()) return;
		const generation = this.generation;
		this.plugin.lib.workspace.iteratePDFViewerComponents((component, file) => {
			const attach = (child: typeof component.child) => {
				if (this.disposed || generation !== this.generation || !child?.pdfViewer || !file?.path) return;
				this.attach(child.pdfViewer, file.path, component);
			};
			if (component.child) attach(component.child);
			else component.then(attach);
		});
		for (const state of this.viewers.values()) {
			for (const [pageNumber, pageView] of state.pages) this.renderPage(state, pageNumber, pageView);
		}
	}

	private attach(viewer: ObsidianViewer, path: string, owner: Component): void {
		const existing = this.viewers.get(viewer);
		if (existing) {
			existing.path = path;
			return;
		}
		const viewerEl = viewer.dom?.viewerEl;
		if (!viewerEl) return;
		const lifecycle = this.addChild(new Component());
		const state: ViewerState = {
			viewer, path, pages: new Map(), viewerEl, lifecycle,
			onClick: (event) => this.handleClick(viewer, event),
		};
		this.viewers.set(viewer, state);
		viewerEl.addEventListener('click', state.onClick, { passive: true });
		owner.register(() => this.detach(viewer, true));
		this.plugin.lib.onTextLayerReady(viewer, lifecycle, (pageNumber, pageView) => {
			if (!this.viewers.has(viewer)) return;
			state.pages.set(pageNumber, pageView);
			this.renderPage(state, pageNumber, pageView);
		});
	}

	private detach(viewer: ObsidianViewer, removeLifecycle = false): void {
		const state = this.viewers.get(viewer);
		if (!state) return;
		state.viewerEl.removeEventListener('click', state.onClick);
		this.viewers.delete(viewer);
		this.markers = this.markers.filter((marker) => marker.viewer !== viewer);
		if (removeLifecycle) this.removeChild(state.lifecycle);
		this.publish();
	}

	private renderPage(state: ViewerState, pageNumber: number, pageView: PDFPageView): void {
		this.markers = this.markers.filter((marker) => marker.viewer !== state.viewer || marker.page !== pageNumber);
		for (const saved of this.annotations()) {
			const source = saved.annotation.source;
			if (source.kind !== 'pdf' || source.path !== state.path || source.page !== pageNumber || !validTuple(source.pdfSelection)) continue;
			const range = makeRange(pageView, source.pdfSelection);
			if (range) this.markers.push({ id: saved.annotation.id, range, viewer: state.viewer, page: pageNumber, overlay: !saved.annotation.pdfHighlight });
		}
		this.publish();
	}

	private publish(): void {
		const api = highlightApi();
		if (!api) return;
		api.registry.delete(HIGHLIGHT_NAME);
		const ranges = this.markers.filter(marker => marker.overlay).map(({ range }) => range);
		if (ranges.length) api.registry.set(HIGHLIGHT_NAME, new api.Highlight(...ranges));
	}

	private handleClick(viewer: ObsidianViewer, event: MouseEvent): void {
		const selection = viewer.dom?.viewerEl.ownerDocument.getSelection();
		if (selection && !selection.isCollapsed) return;
		for (const marker of this.markers) {
			if (marker.viewer === viewer && Array.from(marker.range.getClientRects()).some((rect) => pointInRect(event, rect))) {
				this.open(marker.id);
				return;
			}
		}
	}

	private clear(): void {
		for (const viewer of [...this.viewers.keys()]) this.detach(viewer);
		highlightApi()?.registry.delete(HIGHLIGHT_NAME);
	}
}
