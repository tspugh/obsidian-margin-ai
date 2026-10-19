import { Component, finishRenderMath, ItemView, MarkdownRenderer, Menu, setIcon, WorkspaceLeaf } from 'obsidian';
import type { MarginController } from './controller';
import { resolveContextScope } from './context';
import { orderAnnotations } from './annotation-order';
import { normalizeMathDelimiters } from './message-format';
import { normalizeExcludedFolders } from './request-policy';
import { createDefaultPersonalization } from './personalization';
import { MarkdownNotePickerModal } from './context-note-picker';
import type { ContextScope, Message } from './types';

export const MARGIN_VIEW_TYPE = 'margin-ai-sidebar';
function basename(path: string): string { return path.split('/').pop() || path; }
function cleanExcerpt(value: string): string { return value.replace(/([\p{L}])-[ \t]*\n[ \t]*([\p{Ll}])/gu, '$1$2').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim(); }
function folderScopeOptions(path: string): Array<{ depth: number; label: string; root: string }> {
	const folders = path.split('/').slice(0, -1);
	return Array.from({ length: folders.length + 1 }, (_, depth) => ({
		depth,
		root: folders.slice(0, Math.max(0, folders.length - depth)).join('/'),
		label: depth === 0 ? 'Current folder' : `${depth} folder${depth === 1 ? '' : 's'} up`,
	}));
}
function iconButton(el: HTMLElement, icon: string, label: string, fn: () => void | Promise<void>): HTMLButtonElement {
	const button = el.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
	setIcon(button, icon); button.addEventListener('click', () => void fn()); return button;
}
function shouldOpenCard(event: MouseEvent | KeyboardEvent): boolean {
	if (typeof KeyboardEvent !== 'undefined' && event instanceof KeyboardEvent) return (event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget;
	const selection = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
	if (selection) return false;
	const target = event.target;
	return typeof Element === 'undefined' || !(target instanceof Element) || !target.closest('button, a, input, select, textarea, details, summary, [data-margin-no-open]');
}

export class MarginView extends ItemView {
	private readonly drafts = new Map<string, string>();
	private draftKey: string | null = null;
	private composer: HTMLTextAreaElement | null = null;
	private readonly pendingDrafts = new Set<string>();
	private readonly openContextKeys = new Set<string>();
	private readonly openSourceKeys = new Set<string>();
	private readonly openSummaryKeys = new Set<string>();
	private readonly streamingBodies = new Map<string, HTMLElement>();
	private markdownRoot: Component | null = null;
	private mode: 'highlights' | 'ask' = 'highlights';
	constructor(leaf: WorkspaceLeaf, readonly controller: MarginController) { super(leaf); }
	getViewType(): string { return MARGIN_VIEW_TYPE; }
	getDisplayText(): string { return 'Margin AI'; }
	getIcon(): string { return 'message-square-text'; }
	async onOpen(): Promise<void> { this.controller.attach(this); }
	async onClose(): Promise<void> { this.controller.detach(this); this.markdownRoot?.unload(); }
	focusComposer(expectedDraftKey = this.draftKey): void {
		window.setTimeout(() => {
			if (this.draftKey === expectedDraftKey) this.composer?.focus();
		}, 0);
	}

	render(): void {
		const previousComposer = this.composer;
		const previousDraftKey = this.draftKey;
		const ownerDocument = previousComposer?.ownerDocument ?? (typeof document === 'undefined' ? null : document);
		const restoreFocus = !!previousComposer && ownerDocument?.activeElement === previousComposer;
		const selection = restoreFocus ? [previousComposer.selectionStart, previousComposer.selectionEnd] as const : null;
		if (this.composer && this.draftKey) this.drafts.set(this.draftKey, this.composer.value);
		if (this.markdownRoot) { this.removeChild(this.markdownRoot); this.markdownRoot.unload(); }
		this.markdownRoot = new Component(); this.addChild(this.markdownRoot);
		const root = this.contentEl; root.empty(); root.addClass('margin-ai-view'); this.composer = null; this.streamingBodies.clear();
		this.header(root);
		if (this.controller.active) this.thread(root); else if (this.mode === 'ask') this.compose(root); else this.highlights(root);
		const nextComposer = this.composer as HTMLTextAreaElement | null;
		if (restoreFocus && selection && nextComposer && this.draftKey === previousDraftKey) {
			nextComposer.focus();
			nextComposer.setSelectionRange(selection[0], selection[1]);
		}
	}

	updateStreamingMessage(annotationId: string, messageId: string, content: string): boolean {
		if (this.controller.active?.annotation.id !== annotationId) return false;
		const body = this.streamingBodies.get(messageId);
		if (!body) return false;
		body.setText(content);
		return true;
	}

	private header(root: HTMLElement): void {
		const header = root.createDiv({ cls: 'margin-ai-header' });
		if (this.controller.active) iconButton(header, 'arrow-left', 'Back to highlights', () => { this.controller.active = null; this.mode = 'highlights'; this.controller.render(); });
		header.createEl('strong', { text: 'Margin' });
		if (!this.controller.active) {
			const highlights = header.createEl('button', { text: 'Highlights', cls: this.mode === 'highlights' ? 'is-active' : '' }); highlights.addEventListener('click', () => { this.mode = 'highlights'; this.render(); });
			const ask = header.createEl('button', { text: 'Ask notes', cls: this.mode === 'ask' ? 'is-active' : '' }); ask.addEventListener('click', () => { this.mode = 'ask'; this.controller.startNew(); this.focusComposer(); });
		}
		header.createSpan({ cls: 'margin-ai-spacer' });
		iconButton(header, 'plus', 'New from retained source selection', () => { this.mode = 'ask'; this.controller.startNew(); this.focusComposer(); });
		const details = header.createEl('details', { cls: 'margin-ai-account-menu' });
		const summary = details.createEl('summary', { attr: { 'aria-label': 'Account and model' } }); setIcon(summary, 'circle-user-round');
		const panel = details.createDiv({ cls: 'margin-ai-account-panel' });
		const session = this.controller.chatgpt.getSession(); panel.createEl('strong', { text: session.email ?? session.name ?? 'ChatGPT' });
		if (session.stage) panel.createDiv({ text: `Stage: ${session.stage}`, cls: 'margin-ai-muted' });
		if (session.error) panel.createDiv({ text: `${session.error.summary}${session.error.code ? ` · ${session.error.code}` : ''}${session.error.requestId ? ` · request ${session.error.requestId}` : ''}`, cls: 'margin-ai-auth-error' });
		if (session.status === 'connected') panel.createEl('button', { text: 'Sign out' }).addEventListener('click', () => void this.controller.signOut());
		if (session.status === 'connected') panel.createEl('button', { text: 'Refresh models' }).addEventListener('click', () => void this.controller.retryModelDiscovery());
		else panel.createEl('button', { text: session.status === 'connecting' ? 'Cancel sign-in' : 'Continue with ChatGPT' }).addEventListener('click', () => session.status === 'connecting' ? this.controller.chatgpt.cancelSignIn() : void this.controller.signIn());
		if (session.status === 'connected') {
			const auto = panel.createEl('input', { type: 'checkbox', attr: { 'aria-label': 'Automatic conversation summaries' } }); auto.checked = this.controller.plugin.settings.marginAutoSummary; auto.addEventListener('change', () => void this.controller.setAutoSummary(auto.checked)); panel.createSpan({ text: ' Automatic summaries' });
			const summaryModel = panel.createEl('select', { attr: { 'aria-label': 'Summary model' } }); summaryModel.createEl('option', { text: 'Auto lightweight', value: '' }); for (const item of this.controller.models) { const option = summaryModel.createEl('option', { text: item.displayName, value: item.slug }); option.selected = item.slug === this.controller.plugin.settings.marginSummaryModel; } summaryModel.addEventListener('change', () => void this.controller.chooseSummaryModel(summaryModel.value));
			if (this.controller.summaryStatus) panel.createDiv({ text: this.controller.summaryStatus, cls: 'margin-ai-muted' });
		}
		const author = panel.createEl('input', { type: 'text', value: this.controller.plugin.settings.author ?? '', attr: { placeholder: 'PDF annotation author', 'aria-label': 'PDF annotation author' } });
		author.addEventListener('change', () => { this.controller.plugin.settings.author = author.value.trim(); void this.controller.plugin.saveSettings(); });
	}

	private highlights(root: HTMLElement): void {
		const capture = this.controller.capture; const source = root.createDiv({ cls: 'margin-ai-source-summary' });
		source.createEl('strong', { text: capture ? `${basename(capture.path)}${capture.page ? ` · p. ${capture.page}` : ''}` : 'No source document', attr: capture ? { title: capture.path } : undefined });
		source.createDiv({ text: capture?.scopeLabel ?? 'Select text in a Markdown note or PDF.', cls: 'margin-ai-muted' });
		const list = root.createDiv({ cls: 'margin-ai-highlight-list' });
		list.createDiv({ text: 'In document order', cls: 'margin-ai-list-heading' });
		const ordered = orderAnnotations(this.controller.annotations.map((item) => item.annotation), { markdownText: this.controller.markdownText });
		if (!ordered.length) list.createDiv({ text: 'No highlights yet.', cls: 'margin-ai-empty' });
		let wholeDocumentHeading = false;
		for (const item of ordered) {
			if (item.group === 'whole-document' && !wholeDocumentHeading) { list.createDiv({ text: 'Document conversations', cls: 'margin-ai-list-heading' }); wholeDocumentHeading = true; }
			const saved = this.controller.annotations.find((entry) => entry.annotation.id === item.annotation.id)!;
			const card = list.createDiv({ cls: 'margin-ai-highlight-card', attr: { role: 'button', tabindex: '0', 'aria-label': `Open conversation: ${saved.annotation.summary?.title ?? cleanExcerpt(saved.annotation.source.quote) ?? 'Whole document'}` } });
			card.addEventListener('click', event => { if (shouldOpenCard(event)) this.controller.selectAnnotation(saved); });
			card.addEventListener('keydown', event => { if (shouldOpenCard(event)) { event.preventDefault(); this.controller.selectAnnotation(saved); } });
			if (saved.annotation.summary) card.createEl('strong', { text: saved.annotation.summary.title });
			card.createDiv({ text: saved.annotation.summary?.text || cleanExcerpt(saved.annotation.source.quote) || 'Whole document conversation', cls: 'margin-ai-card-summary' });
			const excerpt = card.createEl('details', { cls: 'margin-ai-card-details' }); excerpt.createEl('summary', { text: 'Passage and transcript' }); excerpt.createEl('blockquote', { text: cleanExcerpt(saved.annotation.source.quote) || 'Whole document conversation' }); const transcript = excerpt.createDiv({ cls: 'margin-ai-card-transcript' }); for (const message of saved.annotation.messages) this.message(transcript, message, false);
			const location = saved.annotation.source.page ? `Page ${saved.annotation.source.page}` : item.anchorStatus === 'missing' ? 'Passage no longer found' : item.anchorStatus === 'ambiguous' ? 'Multiple matching passages' : item.group === 'whole-document' ? 'Whole document' : 'Saved passage';
			const exchanges = saved.annotation.messages.filter(message => message.role === 'user').length;
			card.createDiv({ text: `${location} · ${exchanges} exchange${exchanges === 1 ? '' : 's'}`, cls: 'margin-ai-muted' });
		}
		const annotate = root.createEl('button', { text: 'Annotate selection', cls: 'margin-ai-annotate-selection' });
		const retained = this.controller.retainedCapture?.current();
		if (retained?.kind === 'pdf' && retained.quote) root.createDiv({ text: 'Annotating this PDF selection edits the PDF file after creating a backup.', cls: 'margin-ai-muted' });
		annotate.addEventListener('click', () => void this.controller.annotateRetainedSelection());
	}

	private contextLabel(): string {
		const capture = this.controller.capture;
		if (!capture) return 'Context';
		const scope = this.controller.contextScope;
		if (scope.kind === 'passage') return capture.quote ? 'Passage' : 'Captured note';
		if (scope.kind === 'document') return 'Document';
		if (scope.kind === 'vault') return 'Entire vault';
		const choice = folderScopeOptions(capture.path).find(item => item.depth === scope.ancestorDepth);
		return choice?.label ?? 'Folder';
	}
	private contextDisclosureKey(): string {
		const capture = this.controller.capture;
		return this.controller.active?.annotation.id ?? `${capture?.path ?? ''}:${capture?.startOffset ?? capture?.page ?? ''}:${capture?.endOffset ?? ''}`;
	}

	private renderScope(el: HTMLElement): HTMLDetailsElement | null {
		const capture = this.controller.capture; if (!capture) return null;
		const details = el.createEl('details', { cls: 'margin-ai-disclosure', attr: { 'aria-label': 'Context and sharing' } });
		const disclosureKey = this.contextDisclosureKey();
		details.open = this.openContextKeys.has(disclosureKey);
		details.addEventListener('toggle', () => details.open ? this.openContextKeys.add(disclosureKey) : this.openContextKeys.delete(disclosureKey));
		details.createEl('summary', { text: `Context · ${this.contextLabel()}${this.controller.selectedNotePaths?.length ? ` · ${this.controller.selectedNotePaths.length} note${this.controller.selectedNotePaths.length === 1 ? '' : 's'}` : ''}` });
		const content = details.createDiv({ cls: 'margin-ai-disclosure-content' });
		const select = content.createEl('select', { attr: { 'aria-label': 'Context scope' } });
		const scopes: Array<[string, ContextScope]> = [[capture.quote ? 'Passage' : 'Captured note', { kind: 'passage' }], ['Document', { kind: 'document' }], ['Folder', { kind: 'folder', ancestorDepth: this.controller.contextScope.kind === 'folder' ? this.controller.contextScope.ancestorDepth : 0 }], ['Entire vault', { kind: 'vault' }]];
		for (const [label, scope] of scopes) try {
			resolveContextScope(capture.path, scope);
			const option = select.createEl('option', { text: label, value: JSON.stringify(scope) });
			option.selected = scope.kind === this.controller.contextScope.kind;
			} catch { /* unavailable parent */ }
			select.addEventListener('change', () => this.controller.setContextScope(JSON.parse(select.value) as ContextScope));
			select.title = 'Document is the default. Folder and vault search bounded Markdown note excerpts only when you click Send.';
		const resolved = resolveContextScope(capture.path, this.controller.contextScope);
			content.createDiv({ text: resolved.kind === 'passage' ? `Captured text only · ${capture.scopeLabel ?? capture.path}` : `Allowed path: ${resolved.root || 'vault root'}`, cls: 'margin-ai-muted' });
			content.createDiv({ text: resolved.kind === 'document' ? 'The current document is extracted locally.' : resolved.kind === 'passage' ? 'Uses the captured passage.' : 'Searches at most 100 eligible Markdown notes and includes at most 5 bounded relevant excerpts.', cls: 'margin-ai-context-pending' });
		const status = this.controller.documentStatus ?? { state: 'idle' as const }; if (status.state === 'ready' || status.state === 'extracting') content.createDiv({ text: status.state === 'ready' ? `Document ready · ${status.pageCount ?? 1} page${status.pageCount === 1 ? '' : 's'}${status.detail ? ` · ${status.detail}` : ''}` : 'Extracting document locally…', cls: 'margin-ai-muted' });
			if (this.controller.requestCoverage) { const diagnostic = content.createEl('details', { cls: 'margin-ai-disclosure' }); diagnostic.createEl('summary', { text: 'Last request diagnostics' }); diagnostic.createDiv({ text: this.controller.requestCoverage, cls: 'margin-ai-muted' }); }
			if (this.controller.contextScope.kind === 'folder') {
				const boundary = content.createEl('select', { attr: { 'aria-label': 'Folder boundary' } });
				for (const choice of folderScopeOptions(capture.path)) { const option = boundary.createEl('option', { text: `${choice.label} · ${choice.root || 'Vault root'}`, value: String(choice.depth) }); option.selected = choice.depth === this.controller.contextScope.ancestorDepth; }
				boundary.addEventListener('change', () => this.controller.setContextScope({ kind: 'folder', ancestorDepth: Number(boundary.value) }));
			}
			content.createDiv({ text: 'On Send, the current source, selected notes, and any bounded relevant excerpts are shared with OpenAI. Nothing is uploaded in the background.', cls: 'margin-ai-sharing-note', attr: { 'data-tone': 'neutral' } });
			this.renderAttachedNotes(el);
			return details;
		}

	private attachNote(): void {
		const capture = this.controller.capture; if (!capture) return;
		new MarkdownNotePickerModal(this.app, capture.path, this.controller.plugin.settings.marginAnnotationFolder, normalizeExcludedFolders(this.controller.plugin.settings.marginExcludedFolders ?? ''), path => this.controller.attachNote(path)).open();
	}

	private renderAttachedNotes(el: HTMLElement): void {
		if (!this.controller.selectedNotePaths?.length) return;
		const attached = el.createDiv({ cls: 'margin-ai-attached-notes', attr: { 'aria-label': 'Selected notes' } });
		for (const path of this.controller.selectedNotePaths) { const chip = attached.createSpan({ cls: 'margin-ai-note-chip' }); chip.createSpan({ text: path }); iconButton(chip, 'x', `Remove ${path}`, () => this.controller.detachNote(path)); }
	}

	private thread(root: HTMLElement): void {
		const active = this.controller.active!; const captured = active.annotation.source;
		const source = root.createEl('details', { cls: 'margin-ai-pinned-source', attr: { 'aria-label': 'Source excerpt', title: captured.path } });
		source.open = this.openSourceKeys.has(active.annotation.id);
		source.addEventListener('toggle', () => source.open ? this.openSourceKeys.add(active.annotation.id) : this.openSourceKeys.delete(active.annotation.id));
		const summary = source.createEl('summary', { cls: 'margin-ai-source-heading' });
		summary.createSpan({ text: `${basename(captured.path)}${captured.page ? ` · p. ${captured.page}` : ''}`, cls: 'margin-ai-source-name' });
		iconButton(summary, 'external-link', 'Open source', () => this.controller.navigate(active));
		iconButton(summary, 'file-output', 'Export as new Markdown note', () => this.controller.exportActive());
		if (captured.kind === 'pdf' && captured.quote && captured.page && captured.pdfSelection) {
			if (active.annotation.pdfHighlight) {
				const color = summary.createEl('select', { attr: { 'aria-label': 'PDF highlight color', title: 'Edits the PDF file' } });
				for (const name of Object.keys(this.controller.plugin.settings.colors)) { const option = color.createEl('option', { text: name, value: name }); option.selected = active.annotation.pdfHighlight.color === name; }
				color.addEventListener('click', event => event.stopPropagation());
				color.addEventListener('change', event => { event.stopPropagation(); void this.controller.recolorNativeHighlight(color.value); });
				const repair = summary.createEl('button', { text: 'Verify/repair PDF highlight', attr: { title: 'Edits the PDF file only if the native highlight is missing' } });
				repair.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void this.controller.writeNativeHighlight(active); });
			} else {
				const write = summary.createEl('button', { text: 'Write highlight to PDF', attr: { title: 'Edits the PDF file' } });
				write.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void this.controller.writeNativeHighlight(active); });
			}
			}
		source.createEl('blockquote', { text: captured.quote || 'Whole document', attr: { tabindex: '0' } });
		if (this.controller.nativeHighlightError) root.createDiv({ text: this.controller.nativeHighlightError, cls: 'margin-ai-auth-error' });
		if (captured.kind === 'pdf' && captured.quote) source.createDiv({ text: 'Native highlight actions edit the PDF file. A backup is created in the annotation folder before the first write.', cls: 'margin-ai-muted' });
		if (active.annotation.summary) { const summary = root.createEl('details', { cls: 'margin-ai-thread-summary', attr: { 'aria-label': 'Conversation summary' } }); summary.open = this.openSummaryKeys.has(active.annotation.id); summary.addEventListener('toggle', () => summary.open ? this.openSummaryKeys.add(active.annotation.id) : this.openSummaryKeys.delete(active.annotation.id)); summary.createEl('summary', { text: 'Summary' }); summary.createDiv({ text: active.annotation.summary.text }); }
		const messages = root.createDiv({ cls: 'margin-ai-messages' });
		if (!active.annotation.messages.length) messages.createDiv({ text: 'Passage saved. Add a local comment or ask a question.', cls: 'margin-ai-empty' });
		for (const message of active.annotation.messages) this.message(messages, message);
		this.compose(root);
	}

	private compose(root: HTMLElement): void {
		const capture = this.controller.capture; if (!capture) return;
		this.draftKey = this.controller.active?.annotation.id ?? `new:${capture.path}:${capture.startOffset ?? capture.page ?? ''}:${capture.endOffset ?? capture.pdfSelection?.join(',') ?? ''}`;
		const shell = root.createDiv({ cls: 'margin-ai-composer-shell' }); const card = shell.createDiv({ cls: 'margin-ai-composer-card' });
		const context = this.renderScope(card);
		if (this.controller.documentStatus?.state === 'error') card.createDiv({ text: `Document extraction error: ${this.controller.documentStatus.detail ?? 'Unknown error'}`, cls: 'margin-ai-auth-error' });
		if (this.controller.contextNotice) card.createDiv({ text: this.controller.contextNotice, cls: 'margin-ai-context-notice' });
		if (!this.controller.active && capture.kind === 'pdf' && capture.quote) card.createDiv({ text: 'Comment or Send saves this passage as a native PDF highlight and edits the PDF file after creating a backup.', cls: 'margin-ai-muted' });
		const session = this.controller.chatgpt.getSession();
		if (!session.sharing) {
			const connection = card.createDiv({ cls: 'margin-ai-connection-prompt' });
			connection.createDiv({ text: 'ChatGPT is not connected. Local comments still work.', cls: 'margin-ai-muted' });
			const connect = connection.createEl('button', { text: session.status === 'connecting' ? 'Connecting…' : 'Connect ChatGPT to send' });
			connect.disabled = session.status === 'connecting';
			connect.addEventListener('click', () => void this.controller.signIn());
		} else if (!this.controller.models.length) {
			card.createEl('button', { text: 'Load ChatGPT models' }).addEventListener('click', () => void this.controller.retryModelDiscovery());
		}
		const suggestions = card.createEl('details', { cls: 'margin-ai-disclosure margin-ai-suggestions', attr: { 'aria-label': 'Suggested prompts' } });
		suggestions.createEl('summary', { text: 'Suggestions' });
		const suggestionList = suggestions.createDiv({ cls: 'margin-ai-suggestion-list' });
		for (const text of ['Explain this', 'What connects to this?', 'Challenge this claim']) suggestionList.createEl('button', { text, cls: 'margin-ai-suggestion' }).addEventListener('click', () => { this.composer!.value = text; this.drafts.set(this.draftKey!, text); this.composer!.focus(); });
		this.composer = card.createEl('textarea', { cls: 'margin-ai-composer', attr: { rows: '3', placeholder: 'Write a comment or question…', title: 'Enter to send · Shift+Enter for a new line' } }); this.composer.value = this.drafts.get(this.draftKey) ?? '';
		this.composer.addEventListener('input', () => this.drafts.set(this.draftKey!, this.composer!.value));
		this.composer.addEventListener('keydown', event => {
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
			event.preventDefault();
			if (event.repeat || !this.composer?.value.trim() || !this.controller.chatgpt.getSession().sharing) return;
			return this.submitDraft(true);
		});
		const actions = card.createDiv({ cls: 'margin-ai-composer-actions' });
		const localActions = actions.createDiv({ cls: 'margin-ai-local-actions' });
		const options = iconButton(localActions, 'plus', 'Composer options', () => undefined);
		options.addEventListener('click', event => {
			const menu = new Menu();
			menu.addItem(item => item.setTitle('Attach note…').setIcon('paperclip').onClick(() => this.attachNote()));
			menu.addItem(item => item.setTitle('Context & sharing').setIcon('scan-text').onClick(() => { if (context) { context.open = true; this.openContextKeys.add(this.contextDisclosureKey()); context.querySelector<HTMLElement>('summary')?.focus(); } }));
			menu.addItem(item => item.setTitle('Suggestions').setIcon('sparkles').onClick(() => { suggestions.open = true; suggestions.querySelector<HTMLElement>('summary')?.focus(); }));
			if (event.detail === 0) { const rect = options.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom }); }
			else menu.showAtMouseEvent(event);
		});
		const personalization = this.controller.personalizationProfile ?? createDefaultPersonalization();
		const selectedStyle = personalization.styles.find(style => style.id === personalization.selectedStyleId);
		const styleButton = iconButton(localActions, 'pilcrow', this.controller.personalizationError ? 'Output profile unavailable · open settings for details' : `Output style: ${selectedStyle?.name ?? 'None'} · ${personalization.memoryEnabled ? personalization.memories.filter(memory => memory.enabled).length : 0} approved memories active`, () => undefined);
		styleButton.addEventListener('click', event => {
			const menu = new Menu();
			if (this.controller.personalizationError) menu.addItem(item => item.setTitle('Profile unavailable').setIcon('alert-triangle'));
			else { for (const style of personalization.styles) menu.addItem(item => item.setTitle(style.name).setChecked(style.id === personalization.selectedStyleId).onClick(() => void this.controller.chooseOutputStyle(style.id))); menu.addSeparator(); }
			menu.addItem(item => item.setTitle('Add new style…').setIcon('plus').onClick(() => { const tab = this.controller.plugin.openSettingTab(); tab.scrollToHeading('margin-memory-styles'); }));
			if (event.detail === 0) { const rect = styleButton.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom }); } else menu.showAtMouseEvent(event);
		});
		localActions.createEl('button', { text: 'Comment', cls: 'margin-ai-comment-action' }).addEventListener('click', () => void this.submitDraft(false));
		const aiActions = actions.createDiv({ cls: 'margin-ai-ai-actions' });
		const model = aiActions.createEl('select', { attr: { 'aria-label': 'ChatGPT model' } });
		for (const item of this.controller.models) { const option = model.createEl('option', { text: item.displayName, value: item.slug }); option.selected = item.slug === this.controller.plugin.settings.marginSelectedModel; }
		model.addEventListener('change', () => void this.controller.chooseModel(model.value));
		const send = iconButton(aiActions, 'send', 'Send to ChatGPT', () => this.submitDraft(true)); send.disabled = !this.controller.chatgpt.getSession().sharing;
	}

	private async submitDraft(ai: boolean): Promise<void> {
		const key = this.draftKey; const composer = this.composer;
		if (!key || !composer) return;
		const text = composer.value;
		if (!text.trim() || (ai && !this.controller.chatgpt.getSession().sharing)) return;
		const pendingKey = `${key}\u0000${text}`;
		if (this.pendingDrafts.has(pendingKey)) return;
		this.drafts.set(key, text);
		this.pendingDrafts.add(pendingKey);
		try {
			const saved = await (ai ? this.controller.ask(text) : this.controller.saveComment(text));
			if (!saved) return;
			if (this.drafts.get(key) === text) this.drafts.delete(key);
			if (this.draftKey === key && this.composer?.value === text) this.composer.value = '';
		} finally { this.pendingDrafts.delete(pendingKey); }
	}

	private message(el: HTMLElement, message: Message, interactive = true): void {
		const card = el.createDiv({ cls: `margin-ai-message margin-ai-message-${message.role}` }); const meta = card.createDiv({ cls: 'margin-ai-message-meta' });
		meta.createSpan({ text: message.role === 'user' ? 'You' : `ChatGPT${message.status === 'complete' ? '' : ` · ${message.status}`}` });
		if (message.role === 'assistant' && message.status === 'complete') {
			const status = meta.createSpan({ cls: 'margin-ai-copy-status', attr: { 'aria-live': 'polite' } });
			iconButton(meta, 'copy', 'Copy response', async () => {
			try { await navigator.clipboard.writeText(message.content); status.setText('Copied'); }
			catch { status.setText('Could not copy response.'); }
			});
		}
		const body = card.createDiv({ cls: `margin-ai-message-body${message.status === 'pending' ? ' margin-ai-message-streaming' : ' markdown-rendered'}`, attr: { 'data-margin-message-body': message.id } });
		if (message.status === 'pending') { body.setText(this.controller.streamingContent?.(this.controller.active?.annotation.id ?? '', message.id) ?? message.content); this.streamingBodies.set(message.id, body); card.createSpan({ cls: 'margin-ai-generation-indicator', attr: { 'aria-label': 'Generating response' } }); }
		else void MarkdownRenderer.render(this.app, normalizeMathDelimiters(message.content), body, this.controller.active?.path ?? '', this.markdownRoot!).then(() => finishRenderMath()).catch(() => body.setText(message.content));
		if (interactive && message.status === 'pending') {
			const stop = iconButton(card, 'octagon', 'Stop response', () => this.controller.cancel(message.id));
			stop.title = 'Stop response';
		}
		if (interactive && ['error', 'cancelled', 'interrupted'].includes(message.status)) iconButton(card, 'refresh-cw', 'Retry', () => this.controller.retry(message.id));
	}
}
