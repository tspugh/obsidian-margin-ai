import { TFile, Vault, normalizePath } from 'obsidian';
import type { PersonalizationVault } from './personalization-store';

export class ObsidianPersonalizationVault implements PersonalizationVault {
	constructor(private readonly vault: Vault) {}

	async read(path: string): Promise<string | null> {
		const file = this.vault.getAbstractFileByPath(normalizePath(path));
		return file instanceof TFile ? this.vault.read(file) : null;
	}

	async createFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!this.vault.getAbstractFileByPath(normalized)) await this.vault.createFolder(normalized);
	}

	async create(path: string, content: string): Promise<void> { await this.vault.create(normalizePath(path), content); }

	async process(path: string, transform: (content: string) => string): Promise<string> {
		const file = this.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) throw new Error('Margin AI profile disappeared during update.');
		return this.vault.process(file, transform);
	}
}
