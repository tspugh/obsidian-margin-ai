import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class TFolder { constructor(public path = '') {} }
	class TFile {}
	class FuzzySuggestModal<T> { constructor(public app:any) {} setPlaceholder(){ return this; } open(){} }
	return { FuzzySuggestModal, Modal: class {}, Notice: class {}, Setting: class {}, TFile, TFolder };
});

import { TFolder } from 'obsidian';
import { ExportFolderPickerModal, suggestedExportPath } from '../src/margin-ai/export-modal';

describe('export destination picker', () => {
	it('defaults root-level sources to the existing vault root instead of inventing a folder', () => {
		expect(suggestedExportPath({ source: { path: 'note.md', quote: 'A title' } } as any)).toBe('A title.md');
	});

	it('offers the vault root and existing folders and returns the chosen path', () => {
		const root = Object.assign(new TFolder(), { path: '' }); const notes = Object.assign(new TFolder(), { path: 'Notes' }); const chosen = vi.fn();
		const picker = new ExportFolderPickerModal({ vault: { getRoot: () => root, getAllLoadedFiles: () => [notes] } } as any, chosen);
		expect(picker.getItems()).toEqual([root, notes]);
		expect(picker.getItemText(root)).toBe('Vault root');
		picker.onChooseItem(notes);
		expect(chosen).toHaveBeenCalledWith('Notes');
	});
});
