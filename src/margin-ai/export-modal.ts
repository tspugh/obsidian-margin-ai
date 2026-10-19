import { FuzzySuggestModal, Modal, Notice, Setting, TFile, TFolder, type App } from 'obsidian';
import { assertExportDestinationAvailable, buildExportMarkdown } from './export-note';
import type { Annotation } from './types';

function safeName(value: string): string { return value.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Margin note'; }
export function suggestedExportPath(annotation: Annotation): string {
	const folder = annotation.source.path.includes('/') ? annotation.source.path.slice(0, annotation.source.path.lastIndexOf('/')) : '';
	return [folder, `${safeName(annotation.summary?.title || annotation.source.quote.slice(0, 60))}.md`].filter(Boolean).join('/');
}

export class ExportFolderPickerModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private readonly choose: (path: string) => void) { super(app); this.setPlaceholder('Choose an export folder…'); }
	getItems(): TFolder[] { return [this.app.vault.getRoot(), ...this.app.vault.getAllLoadedFiles().filter((item): item is TFolder => item instanceof TFolder && !!item.path)]; }
	getItemText(folder: TFolder): string { return folder.path || 'Vault root'; }
	onChooseItem(folder: TFolder): void { this.choose(folder.path); }
}

export class ExportMarginNoteModal extends Modal {
	private folder: string;
	private filename: string;
	private creating = false;
	constructor(app: App, private readonly annotation: Annotation, private readonly onCreated: (file: TFile) => Promise<void>) { super(app); const path = suggestedExportPath(annotation); const slash = path.lastIndexOf('/'); this.folder = slash < 0 ? '' : path.slice(0, slash); this.filename = slash < 0 ? path : path.slice(slash + 1); }
	onOpen(): void {
		this.titleEl.setText('Export margin note'); this.contentEl.createDiv({ text: 'Creates a new Markdown note. Existing files are never overwritten.', cls: 'margin-ai-muted' });
		let folderInput!: HTMLInputElement;
		const folderSetting = new Setting(this.contentEl).setName('Folder').setDesc('Choose an existing vault folder, or choose Vault root from the picker.').addText(text => { folderInput = text.inputEl; text.setValue(this.folder || 'Vault root').setDisabled(true); }).addButton(button => button.setButtonText('Choose folder…').onClick(() => new ExportFolderPickerModal(this.app, path => { this.folder = path; folderInput.value = path || 'Vault root'; }).open()));
		folderSetting.settingEl.addClass('margin-ai-export-field');
		const nameSetting = new Setting(this.contentEl).setName('Note filename').setDesc('Editable filename for the new note.').addText(text => text.setValue(this.filename).onChange(value => { this.filename = value; }));
		nameSetting.settingEl.addClass('margin-ai-export-field');
		new Setting(this.contentEl).addButton(button => button.setButtonText('Export').setCta().onClick(() => void this.create()));
	}
	private async create(): Promise<void> {
		if (this.creating) return; this.creating = true;
		try {
			if (this.folder && !(this.app.vault.getAbstractFileByPath(this.folder) instanceof TFolder)) throw new Error('Choose an existing vault folder.');
			const path = assertExportDestinationAvailable([this.folder, this.filename].filter(Boolean).join('/'), candidate => !!this.app.vault.getAbstractFileByPath(candidate));
			const file = await this.app.vault.create(path, buildExportMarkdown({ title: this.annotation.summary?.title, sourceLink: this.annotation.source.link, quote: this.annotation.source.quote, summary: this.annotation.summary?.text, messages: this.annotation.messages }));
			this.close(); new Notice(`Exported ${path}`); try { await this.onCreated(file); } catch { new Notice('The note was created, but could not be opened.'); }
		} catch (error) { this.creating = false; new Notice(error instanceof Error ? error.message : String(error)); }
	}
}
