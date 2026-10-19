import { FileSystemAdapter, TFile, type Vault } from 'obsidian';
import { lstat, realpath } from 'fs/promises';
import { isAbsolute, relative, resolve, sep } from 'path';
import type { MarkdownContextReader } from './types';

export class ObsidianMarkdownContextReader implements MarkdownContextReader {
	constructor(private readonly vault: Vault) {}

	async listMarkdownPaths(): Promise<readonly string[]> {
		return this.vault.getMarkdownFiles().map((file) => file.path);
	}

	async isSafeMarkdownPath(path: string): Promise<boolean> {
		try {
			const file = this.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== 'md') return false;
			const adapter = this.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter)) return false;
			const root = await realpath(adapter.getBasePath());
			const candidate = resolve(root, path);
			const rel = relative(root, candidate);
			if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === '') return false;
			let cursor = root;
			for (const segment of path.split('/')) {
				cursor = resolve(cursor, segment);
				const stat = await lstat(cursor);
				if (stat.isSymbolicLink()) return false;
			}
			const resolvedRelative = relative(root, await realpath(candidate));
			return resolvedRelative !== '..' && !resolvedRelative.startsWith(`..${sep}`) && !isAbsolute(resolvedRelative);
		} catch {
			return false;
		}
	}

	async readMarkdown(path: string): Promise<string> {
		if (!await this.isSafeMarkdownPath(path)) throw new Error(`Unsafe Markdown path: ${path}`);
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`Markdown note not found: ${path}`);
		return this.vault.read(file);
	}
}
