import { FuzzySuggestModal, type App, type TFile } from 'obsidian';
import { isPathAllowed } from './context';

export class MarkdownNotePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly sourcePath: string,
		private readonly companionFolder: string,
		private readonly excludedFolders: readonly string[],
		private readonly choose: (path: string) => void,
	) { super(app); this.setPlaceholder('Choose a Markdown note…'); }

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter(file => file.path !== this.sourcePath && isPathAllowed(file.path, { kind: 'vault', root: '' }, { companionFolder: this.companionFolder, excludedFolders: this.excludedFolders }));
	}

	getItemText(file: TFile): string { return file.path; }
	onChooseItem(file: TFile): void { this.choose(file.path); }
}
