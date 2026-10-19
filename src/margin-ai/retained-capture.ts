import type { SourceCapture } from './types';

export class RetainedSourceCapture {
	private capture: SourceCapture | null = null;
	private copy(capture: SourceCapture): SourceCapture {
		return { ...capture, ...(capture.pdfSelection ? { pdfSelection: [...capture.pdfSelection] as [number, number, number, number] } : {}) };
	}
	remember(capture: SourceCapture): void { this.capture = this.copy(capture); }
	current(): SourceCapture | null { return this.capture ? this.copy(this.capture) : null; }
	resetForSource(path: string): void { if (this.capture?.path !== path) this.capture = null; }
	clear(): void { this.capture = null; }
}
