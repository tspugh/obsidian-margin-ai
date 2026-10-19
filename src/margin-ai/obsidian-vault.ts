import { TFile, Vault, normalizePath } from 'obsidian';
import type { AnnotationFile, AnnotationVault } from './repository';

export class ObsidianAnnotationVault implements AnnotationVault {
	constructor(private readonly vault: Vault) {}

	getMarkdownFiles(): AnnotationFile[] {
		return this.vault.getMarkdownFiles();
	}

	getFile(path: string): TFile | null {
		const file = this.vault.getAbstractFileByPath(normalizePath(path));
		return file instanceof TFile ? file : null;
	}

	async read(file: AnnotationFile): Promise<string> {
		const actual = this.getFile(file.path);
		if (!actual) throw new Error(`Annotation not found: ${file.path}`);
		return this.vault.read(actual);
	}

	async create(path: string, content: string): Promise<TFile> {
		return this.vault.create(normalizePath(path), content);
	}

	async createFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (this.vault.getAbstractFileByPath(normalized)) return;
		await this.vault.createFolder(normalized);
	}

	async process(file: AnnotationFile, transform: (content: string) => string): Promise<string> {
		const actual = this.getFile(file.path);
		if (!actual) throw new Error(`Annotation not found: ${file.path}`);
		return this.vault.process(actual, transform);
	}
}
