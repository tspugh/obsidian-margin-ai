export interface PdfSourceVersion {
	mtime: number;
	size: number;
}

export interface NativePdfHighlightRequest {
	annotationId: string;
	source: {
		path: string;
		page?: number;
		pdfSelection?: [number, number, number, number];
	};
	sourceVersion: PdfSourceVersion;
	colorName?: string;
	existingAnnotationId?: string;
}

export interface NativePdfHighlightResult {
	status: 'created' | 'existing';
	annotationId: string;
	backupPath?: string;
}

interface PdfFile {
	path: string;
	name: string;
	extension: string;
	stat: PdfSourceVersion;
}

interface PdfViewerChildLike {
	file: PdfFile | null;
	pdfViewer: { pagesCount: number };
	getPage(page: number): { textLayer?: unknown; div?: { dataset?: { loaded?: string } } } | null | undefined;
}

type Annotator = (file: PdfFile, page: number, rects: unknown[]) => Promise<string>;

export interface NativePdfPluginLike {
	settings: { author?: string; marginAnnotationFolder?: string };
	app: {
		vault: {
			getAbstractFileByPath(path: string): unknown;
			createFolder(path: string): Promise<unknown>;
			copy(file: PdfFile, path: string): Promise<unknown>;
		};
	};
	lib: {
		getPDFViewerChild(activeOnly?: boolean): PdfViewerChildLike | null | undefined;
		highlight: {
			writeFile: {
				addAnnotationToTextRange(
					annotator: Annotator,
					child: PdfViewerChildLike,
					page: number,
					beginIndex: number,
					beginOffset: number,
					endIndex: number,
					endOffset: number,
				): Promise<{ annotationID?: string } | undefined>;
				pdflib: {
					addHighlightAnnotation(file: PdfFile, page: number, rects: unknown[], colorName?: string, contents?: string, preWriteGuard?: () => void | Promise<void>): Promise<string>;
					findAnnotationByContents?(file: PdfFile, page: number, contents: string): Promise<string | null>;
					getAnnotation(file: PdfFile, page: number, id: string): Promise<unknown | null>;
					setAnnotationColor(file: PdfFile, page: number, id: string, rgb: { r: number; g: number; b: number }, preWriteGuard?: () => void | Promise<void>): Promise<void>;
				};
			};
		};
	};
	domManager: { getRgb(colorName?: string): { r: number; g: number; b: number } };
}

export class NativePdfHighlightWriter {
	private readonly queues = new Map<string, Promise<void>>();
	private readonly inFlight = new Map<string, Promise<NativePdfHighlightResult>>();
	private readonly completed = new Map<string, string>();
	private readonly backedUpVersions = new Map<string, string>();

	constructor(
		private readonly plugin: NativePdfPluginLike,
		private readonly clock: { now(): Date } = { now: () => new Date() },
	) {}

	async write(request: NativePdfHighlightRequest): Promise<NativePdfHighlightResult> {
		if (request.existingAnnotationId) {
			const file = this.getPdfFile(request.source.path);
			if (request.source.page && await this.plugin.lib.highlight.writeFile.pdflib.getAnnotation(file, request.source.page, request.existingAnnotationId)) {
				this.completed.set(this.key(request), request.existingAnnotationId);
				return { status: 'existing', annotationId: request.existingAnnotationId };
			}
			this.completed.delete(this.key(request));
		}

		const key = this.key(request);
		const completed = this.completed.get(key);
		if (completed) return { status: 'existing', annotationId: completed };

		const active = this.inFlight.get(key);
		if (active) {
			const result = await active;
			return { status: 'existing', annotationId: result.annotationId };
		}

		const operation = this.enqueue(request.source.path, () => this.writeOnce(request));
		this.inFlight.set(key, operation);
		try {
			const result = await operation;
			this.completed.set(key, result.annotationId);
			return result;
		} finally {
			if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
		}
	}

	async recolor(request: NativePdfHighlightRequest & { existingAnnotationId: string; colorName: string }): Promise<void> {
		await this.enqueue(request.source.path, async () => {
			const file = this.getPdfFile(request.source.path);
			const page = request.source.page;
			if (!page) throw new Error('The native PDF highlight page is missing.');
			this.assertVersion(file, request.sourceVersion);
			if (!await this.plugin.lib.highlight.writeFile.pdflib.getAnnotation(file, page, request.existingAnnotationId)) {
				throw new Error('The native PDF highlight no longer exists. Write it again before changing its color.');
			}
			await this.backupOnce(file, request.sourceVersion);
			await this.plugin.lib.highlight.writeFile.pdflib.setAnnotationColor(
				file, page, request.existingAnnotationId, this.validRgb(request.colorName),
				() => this.assertVersion(this.getPdfFile(request.source.path), request.sourceVersion),
			);
		});
	}

	private async writeOnce(request: NativePdfHighlightRequest): Promise<NativePdfHighlightResult> {
		const { page, pdfSelection } = request.source;
		if (!Number.isInteger(page) || page! < 1 || !pdfSelection || pdfSelection.length !== 4
			|| pdfSelection.some((value) => !Number.isInteger(value) || value < 0)
			|| pdfSelection[0] > pdfSelection[2]
			|| (pdfSelection[0] === pdfSelection[2] && pdfSelection[1] >= pdfSelection[3])) {
			throw new Error('The retained PDF page and text selection are invalid. Select PDF text again.');
		}
		const retainedPage = page as number;
		this.validRgb(request.colorName);

		const file = this.getPdfFile(request.source.path);
		const child = this.plugin.lib.getPDFViewerChild(false);
		if (!child || child.file?.path !== file.path) {
			throw new Error(`Open ${file.name} in a PDF viewer before writing its native highlight.`);
		}
		const pageView = child.getPage(retainedPage);
		if (retainedPage > child.pdfViewer.pagesCount || !pageView?.textLayer || !pageView.div?.dataset?.loaded) {
			throw new Error(`PDF page ${retainedPage} is not rendered. Scroll to that page and try again.`);
		}

		let backupPath: string | undefined;
		let writeError: unknown;
		const marker = `margin-ai:${request.annotationId}`;
		const recovered = await this.plugin.lib.highlight.writeFile.pdflib.findAnnotationByContents?.(file, retainedPage, marker);
		if (recovered) return { status: 'existing', annotationId: recovered };

		const annotator: Annotator = async (_retainedFile, retainedPage, rects) => {
			if (!rects.length) throw new Error('The retained PDF selection produced no highlight rectangles. Render the page and select the passage again.');
			const currentFile = this.getPdfFile(request.source.path);
			this.assertVersion(currentFile, request.sourceVersion);
			backupPath = await this.backupOnce(currentFile, request.sourceVersion);
			try {
				return await this.plugin.lib.highlight.writeFile.pdflib.addHighlightAnnotation(
					currentFile, retainedPage, rects, request.colorName, marker,
					() => this.assertVersion(this.getPdfFile(request.source.path), request.sourceVersion),
				);
			} catch (error) {
				writeError = error;
				throw error;
			}
		};

		const [beginIndex, beginOffset, endIndex, endOffset] = pdfSelection;
		let result: { annotationID?: string } | undefined;
		try {
			result = await this.plugin.lib.highlight.writeFile.addAnnotationToTextRange(
				annotator, child, retainedPage, beginIndex, beginOffset, endIndex, endOffset,
			);
		} catch (error) {
			writeError ??= error;
		}
		if (writeError) throw this.actionableWriteError(writeError);
		if (!result?.annotationID) throw new Error('Could not write the native PDF highlight. Reopen the PDF and try again.');
		return { status: 'created', annotationId: result.annotationID, backupPath };
	}

	private validRgb(colorName?: string): { r: number; g: number; b: number } {
		const rgb = this.plugin.domManager.getRgb(colorName);
		if ([rgb.r, rgb.g, rgb.b].some(value => !Number.isFinite(value) || value < 0 || value > 255)) throw new Error(`PDF highlight color "${colorName ?? ''}" is invalid. Choose a configured PDF++ color.`);
		return rgb;
	}

	private getPdfFile(path: string): PdfFile {
		const file = this.plugin.app.vault.getAbstractFileByPath(path) as Partial<PdfFile> | null;
		if (!file || file.path !== path || file.extension !== 'pdf' || !file.stat) {
			throw new Error(`PDF file not found at "${path}". Restore or reopen the file and try again.`);
		}
		return file as PdfFile;
	}

	private assertVersion(file: PdfFile, expected: PdfSourceVersion): void {
		if (file.stat.mtime !== expected.mtime || file.stat.size !== expected.size) {
			throw new Error('The PDF changed after this selection was captured. Reopen it, select the passage again, and retry.');
		}
	}

	private async backupOnce(file: PdfFile, version: PdfSourceVersion): Promise<string> {
		const versionKey = `${file.path}:${version.mtime}:${version.size}`;
		const prior = this.backedUpVersions.get(file.path);
		const annotationFolder = this.plugin.settings.marginAnnotationFolder?.replace(/\/+$/, '') || 'Annotations';
		const backupFolder = `${annotationFolder}/PDF backups`;
		const backupPath = `${backupFolder}/${this.baseName(file.name)}-${this.pathHash(file.path)}.before-margin-ai-${version.mtime}-${version.size}.pdf`;
		if (prior === versionKey || this.plugin.app.vault.getAbstractFileByPath(backupPath)) {
			this.backedUpVersions.set(file.path, versionKey);
			return backupPath;
		}
		await this.ensureFolder(annotationFolder);
		await this.ensureFolder(backupFolder);
		try {
			await this.plugin.app.vault.copy(file, backupPath);
		} catch (error) {
			throw new Error(`Could not create the PDF backup at "${backupPath}". No highlight was written. ${this.message(error)}`);
		}
		this.backedUpVersions.set(file.path, versionKey);
		return backupPath;
	}

	private async ensureFolder(path: string): Promise<void> {
		if (this.plugin.app.vault.getAbstractFileByPath(path)) return;
		try {
			await this.plugin.app.vault.createFolder(path);
		} catch (error) {
			if (!this.plugin.app.vault.getAbstractFileByPath(path)) throw error;
		}
	}

	private actionableWriteError(error: unknown): Error {
		const message = this.message(error);
		if (/encrypt|password/i.test(message)) {
			return new Error('This PDF is encrypted or password-protected. Unlock a copy before writing a native highlight.');
		}
		return new Error(`Could not write the native PDF highlight. The backup was preserved. ${message}`);
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private baseName(name: string): string {
		return name.replace(/\.pdf$/i, '').replace(/[^a-z0-9._-]+/gi, '-');
	}

	private pathHash(path: string): string {
		let hash = 2166136261;
		for (let index = 0; index < path.length; index += 1) {
			hash ^= path.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(16).padStart(8, '0');
	}

	private key(request: NativePdfHighlightRequest): string {
		return `${request.source.path}:${request.annotationId}`;
	}

	private async enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(path) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		this.queues.set(path, current);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			if (this.queues.get(path) === current) this.queues.delete(path);
		}
	}
}
