import {
	createAnnotationDocument,
	markPendingMessagesInterrupted,
	parseAnnotation,
	replaceMessage,
	updateSourcePath,
} from './codec';
import type { Annotation, Message } from './types';

export interface AnnotationFile {
	path: string;
}

export interface AnnotationVault {
	getMarkdownFiles(): AnnotationFile[];
	getFile(path: string): AnnotationFile | null;
	read(file: AnnotationFile): Promise<string>;
	create(path: string, content: string): Promise<AnnotationFile>;
	createFolder(path: string): Promise<void>;
	process(file: AnnotationFile, transform: (content: string) => string): Promise<string>;
}

export interface SavedAnnotation {
	path: string;
	annotation: Annotation;
}

function cleanFolder(folder: string): string {
	if (!folder || folder.startsWith('/') || folder.includes('\\')) {
		throw new Error('Annotation folder must be a vault-relative folder.');
	}
	const parts = folder.split('/');
	if (parts.some((part) => !part || part === '.' || part === '..') || parts[0].toLowerCase() === '.obsidian') {
		throw new Error('Annotation folder must stay inside the vault and outside .obsidian.');
	}
	return parts.join('/');
}

function sourceName(path: string): string {
	const filename = path.split('/').pop() ?? 'Annotation';
	const stem = filename.replace(/\.[^.]+$/, '');
	return stem.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'Annotation';
}

function timestamp(iso: string): string {
	return iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export class AnnotationRepository {
	readonly folder: string;

	constructor(private readonly vault: AnnotationVault, folder: string) {
		this.folder = cleanFolder(folder);
	}

	private files(): AnnotationFile[] {
		const prefix = `${this.folder}/`;
		return this.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix));
	}

	private async readIfAnnotation(file: AnnotationFile): Promise<SavedAnnotation | null> {
		const content = await this.vault.read(file);
		try {
			return { path: file.path, annotation: parseAnnotation(content) };
		} catch (error) {
			if (/^---\s*$[\s\S]*?^margin-ai\s*:/m.test(content)) {
				throw new Error(`Malformed Margin AI companion note ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return null;
		}
	}

	private async findById(id: string): Promise<SavedAnnotation | null> {
		for (const file of this.files()) {
			const saved = await this.readIfAnnotation(file);
			if (saved?.annotation.id === id) return saved;
		}
		return null;
	}

	async create(annotation: Annotation): Promise<string> {
		await this.vault.createFolder(this.folder);
		const shortId = annotation.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'annotation';
		const path = `${this.folder}/${sourceName(annotation.source.path)}-${timestamp(annotation.createdAt)}-${shortId}.md`;
		await this.vault.create(path, createAnnotationDocument(annotation));
		return path;
	}

	async get(path: string): Promise<SavedAnnotation | null> {
		const file = this.vault.getFile(path);
		return file ? this.readIfAnnotation(file) : null;
	}

	async listForSource(sourcePath: string): Promise<SavedAnnotation[]> {
		const saved = await Promise.all(this.files().map((file) => this.readIfAnnotation(file)));
		return saved
			.filter((entry): entry is SavedAnnotation => entry !== null && entry.annotation.source.path === sourcePath)
			.sort((left, right) => left.annotation.createdAt.localeCompare(right.annotation.createdAt));
	}

	async replaceMessage(path: string, annotationId: string, replacement: Message): Promise<string> {
		let file = this.vault.getFile(path);
		if (file) {
			const current = await this.readIfAnnotation(file);
			if (current?.annotation.id !== annotationId) file = null;
		}
		if (!file) {
			const relocated = await this.findById(annotationId);
			file = relocated ? this.vault.getFile(relocated.path) : null;
		}
		if (!file) throw new Error('The annotation was moved outside the annotations folder or deleted. The AI result was not saved.');
		await this.vault.process(file, (content) => replaceMessage(content, replacement.id, replacement));
		return file.path;
	}

	async mutate(path: string, transform: (content: string) => string): Promise<void> {
		const file = this.vault.getFile(path);
		if (!file) throw new Error(`Annotation not found: ${path}`);
		await this.vault.process(file, transform);
	}

	async recoverInterrupted(): Promise<void> {
		for (const file of this.files()) {
			const saved = await this.readIfAnnotation(file);
			if (saved?.annotation.messages.some((message) => message.status === 'pending')) {
				await this.vault.process(file, markPendingMessagesInterrupted);
			}
		}
	}

	async renameSource(oldPath: string, newPath: string): Promise<void> {
		for (const file of this.files()) {
			const saved = await this.readIfAnnotation(file);
			if (saved?.annotation.source.path === oldPath) {
				await this.vault.process(file, (content) => updateSourcePath(content, oldPath, newPath));
			}
		}
	}
}
