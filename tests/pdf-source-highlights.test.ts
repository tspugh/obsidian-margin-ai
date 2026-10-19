import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
	Component: class {
		cleanups: Array<() => void> = [];
		children: any[] = [];
		register(cleanup: () => void) { this.cleanups.push(cleanup); }
		addChild<T>(child: T): T { this.children.push(child); (child as any).load(); return child; }
		removeChild(child: any) { this.children = this.children.filter((entry) => entry !== child); child.unload(); }
		load() {}
		unload() { for (const child of this.children.splice(0).reverse()) child.unload(); for (const cleanup of this.cleanups.splice(0).reverse()) cleanup(); }
	},
}));

vi.mock('utils', () => ({
	getTextLayerInfo: (layer: unknown) => layer,
	getNodeAndOffsetOfTextPos: (element: any, offset: number) => ({ node: element.textNode, offset }),
}));

import { PDFSourceHighlights } from '../src/margin-ai/pdf-source-highlights';

function fixture() {
	const listeners = new Map<string, EventListener>();
	const selection = { isCollapsed: true };
	const viewerEl = {
		ownerDocument: { getSelection: () => selection },
		addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
		removeEventListener: vi.fn((name: string) => listeners.delete(name)),
	};
	const range = {
		setStart: vi.fn(), setEnd: vi.fn(),
		getClientRects: () => [{ left: 10, right: 30, top: 20, bottom: 40 }],
	};
	const textDiv = { textNode: {}, ownerDocument: { createRange: () => range } };
	const page = { textLayer: { textDivs: [textDiv], textContentItems: [{ str: 'hello' }] } };
	let ready: ((pageNumber: number, pageView: any) => void) | undefined;
	let lifecycleOwner: unknown;
	const child = { file: { path: 'paper.pdf' }, pdfViewer: { dom: { viewerEl }, eventBus: {}, pdfViewer: { _pages: [page] } } };
	const component: any = { child, cleanups: [] as Array<() => void>, register(cleanup: () => void) { this.cleanups.push(cleanup); } };
	const plugin: any = { lib: {
		workspace: { iteratePDFViewerComponents: (callback: (component: any, file: any) => void) => callback(component, child.file) },
		onTextLayerReady: (_viewer: unknown, owner: unknown, callback: typeof ready) => { lifecycleOwner = owner; ready = callback; callback!(1, page); },
	} };
	return { plugin, listeners, range, page, rerender: () => ready!(1, page), viewerEl, selection, component, lifecycleOwner: () => lifecycleOwner };
}

describe('PDFSourceHighlights', () => {
	beforeEach(() => {
		const highlights = new Map<string, unknown>();
		(globalThis as any).CSS = { highlights: { set: vi.fn((key: string, value: unknown) => highlights.set(key, value)), delete: vi.fn((key: string) => highlights.delete(key)) } };
		(globalThis as any).Highlight = class { constructor(public range: unknown) {} };
	});

	it('renders matching text ranges, opens them by rect hit-test, and cleans up', () => {
		const { plugin, listeners, range, rerender, viewerEl, component, lifecycleOwner } = fixture();
		const open = vi.fn();
		const marker = new PDFSourceHighlights(plugin, () => [{ path: 'note.md', annotation: {
			id: 'ann-1', createdAt: '', messages: [],
			source: { kind: 'pdf', path: 'paper.pdf', link: '', quote: 'ell', contextBefore: '', contextAfter: '', page: 1, pdfSelection: [0, 1, 0, 4], scopeLabel: '' },
		} }], open);
		marker.load(); marker.refresh();
		expect(lifecycleOwner()).not.toBe(component);

		expect(range.setStart).toHaveBeenCalledWith(expect.anything(), 1);
		expect(range.setEnd).toHaveBeenCalledWith(expect.anything(), 4);
		listeners.get('click')!({ clientX: 15, clientY: 25 } as MouseEvent);
		expect(open).toHaveBeenCalledWith('ann-1');

		rerender();
		expect((CSS as any).highlights.delete).toHaveBeenCalled();
		marker.unload();
		expect(viewerEl.removeEventListener).toHaveBeenCalledWith('click', expect.any(Function));
	});

	it('does nothing when custom highlights are unsupported', () => {
		delete (globalThis as any).Highlight;
		const { plugin, viewerEl } = fixture();
		const marker = new PDFSourceHighlights(plugin, () => [], vi.fn());
		marker.load(); marker.refresh();
		expect(viewerEl.addEventListener).not.toHaveBeenCalled();
	});

	it('does not attach when a delayed viewer resolves after unload', () => {
		let resolve!: (child: any) => void;
		const viewerEl = { ownerDocument: { getSelection: () => ({ isCollapsed: true }) }, addEventListener: vi.fn(), removeEventListener: vi.fn() };
		const component: any = { child: null, then: (callback: typeof resolve) => { resolve = callback; }, register: vi.fn() };
		const plugin: any = { lib: {
			workspace: { iteratePDFViewerComponents: (callback: (component: any, file: any) => void) => callback(component, { path: 'paper.pdf' }) },
			onTextLayerReady: vi.fn(),
		} };
		const marker = new PDFSourceHighlights(plugin, () => [], vi.fn());
		marker.load(); marker.refresh(); marker.unload();
		resolve({ pdfViewer: { dom: { viewerEl }, eventBus: {}, pdfViewer: { _pages: [] } } });
		expect(viewerEl.addEventListener).not.toHaveBeenCalled();
		expect(plugin.lib.onTextLayerReady).not.toHaveBeenCalled();
	});

	it('ignores malformed tuples and clicks made during a text selection', () => {
		const { plugin, listeners, range, selection } = fixture();
		const open = vi.fn();
		const marker = new PDFSourceHighlights(plugin, () => [{ path: 'note.md', annotation: {
			id: 'bad', createdAt: '', messages: [],
			source: { kind: 'pdf', path: 'paper.pdf', link: '', quote: '', contextBefore: '', contextAfter: '', page: 1, pdfSelection: [0, 4, 0, 1], scopeLabel: '' },
		} }, { path: 'note-2.md', annotation: {
			id: 'good', createdAt: '', messages: [],
			source: { kind: 'pdf', path: 'paper.pdf', link: '', quote: '', contextBefore: '', contextAfter: '', page: 1, pdfSelection: [0, 1, 0, 4], scopeLabel: '' },
		} }], open);
		marker.load(); marker.refresh();
		expect(range.setStart).toHaveBeenCalled();
		expect(range.setStart.mock.calls.every(([, offset]) => offset === 1)).toBe(true);
		selection.isCollapsed = false;
		listeners.get('click')!({ clientX: 15, clientY: 25 } as MouseEvent);
		expect(open).not.toHaveBeenCalled();
	});

	it('keeps native annotations clickable without publishing a duplicate overlay',()=>{
		const {plugin,listeners}=fixture(); const open=vi.fn();
		const marker=new PDFSourceHighlights(plugin,()=>[{path:'note.md',annotation:{id:'native',createdAt:'',messages:[],pdfHighlight:{annotationId:'12R0',color:'yellow'},source:{kind:'pdf',path:'paper.pdf',link:'',quote:'ell',contextBefore:'',contextAfter:'',page:1,pdfSelection:[0,1,0,4],scopeLabel:''}}}],open);
		marker.load(); marker.refresh();
		expect((CSS as any).highlights.set).not.toHaveBeenCalled();
		listeners.get('click')!({clientX:15,clientY:25} as MouseEvent);
		expect(open).toHaveBeenCalledWith('native');
	});
});
