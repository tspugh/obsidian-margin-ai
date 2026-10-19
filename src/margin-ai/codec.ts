import type { Annotation, Message, MessageRole, MessageStatus, RequestContextSnapshot, SourceCapture, SourceKind } from './types';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const FRONTMATTER_END = '\n---\n';
const MESSAGE_START = '<!-- margin-ai-message ';
const MESSAGE_START_ESCAPED = '<!-- margin-ai&#45;message ';
const MESSAGE_END = '<!-- margin-ai-end ';
const MESSAGE_END_ESCAPED = '<!-- margin-ai&#45;end ';

interface MessageMeta {
	id: string;
	role: MessageRole;
	createdAt: string;
	status: MessageStatus;
	requestContext?: RequestContextSnapshot;
}

function readField(frontmatter: Record<string, unknown>, name: string): unknown {
	if (!(name in frontmatter)) throw new Error(`Missing Margin AI field: ${name}`);
	return frontmatter[name];
}

function stringField(frontmatter: Record<string, unknown>, name: string): string {
	const value = readField(frontmatter, name);
	if (typeof value !== 'string') throw new Error(`Invalid Margin AI field: ${name}`);
	return value;
}

function optionalNumber(frontmatter: Record<string, unknown>, name: string): number | undefined {
	const value = readField(frontmatter, name);
	if (value === null) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid Margin AI field: ${name}`);
	return value;
}

function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; bodyStart: number } {
	if (!markdown.startsWith('---\n')) throw new Error('Not a Margin AI companion note.');
	const end = markdown.indexOf(FRONTMATTER_END, 4);
	if (end < 0) throw new Error('The Margin AI frontmatter is incomplete.');
	const value = parseYaml(markdown.slice(4, end)) as unknown;
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Margin AI frontmatter.');
	return { frontmatter: value as Record<string, unknown>, bodyStart: end + FRONTMATTER_END.length };
}

function renderFrontmatter(frontmatter: Record<string, unknown>): string {
	return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 })}---\n`;
}

function quoteBlock(quote: string): string {
	if (!quote) return '> _Whole document_';
	return quote.split('\n').map((line) => `> ${line}`).join('\n');
}

function escapeManagedMarkers(content: string): string {
	return content
		.replaceAll(MESSAGE_START, MESSAGE_START_ESCAPED)
		.replaceAll(MESSAGE_END, MESSAGE_END_ESCAPED);
}

function unescapeManagedMarkers(content: string): string {
	return content
		.replaceAll(MESSAGE_START_ESCAPED, MESSAGE_START)
		.replaceAll(MESSAGE_END_ESCAPED, MESSAGE_END);
}

function headingFor(role: MessageRole): string {
	return role === 'user' ? '## You' : '## ChatGPT';
}

function messageBlock(message: Message): string {
	const { content, ...meta } = message;
	return [
		`${MESSAGE_START}${JSON.stringify(meta)} -->`,
		headingFor(message.role),
		'',
		escapeManagedMarkers(content),
		`${MESSAGE_END}${message.id} -->`,
	].join('\n');
}

interface BlockRange {
	start: number;
	end: number;
	message: Message;
}

function messageRanges(markdown: string): BlockRange[] {
	const starts: Array<{ index: number; contentStart: number; meta: MessageMeta }> = [];
	const pattern = /^<!-- margin-ai-message (\{[^\n]+\}) -->\n## (?:You|ChatGPT)\n\n/gm;
	for (const match of markdown.matchAll(pattern)) {
		const meta = JSON.parse(match[1]) as MessageMeta;
		if (!meta.id || !['user', 'assistant'].includes(meta.role) || !meta.createdAt ||
			!['complete', 'pending', 'error', 'cancelled', 'interrupted'].includes(meta.status)) {
			throw new Error('Invalid Margin AI message metadata.');
		}
		starts.push({ index: match.index, contentStart: match.index + match[0].length, meta });
	}

	return starts.map((entry, index) => {
		const limit = index + 1 < starts.length ? starts[index + 1].index : markdown.length;
		const endMarker = `\n${MESSAGE_END}${entry.meta.id} -->`;
		const markerStart = markdown.lastIndexOf(endMarker, limit);
		if (markerStart < entry.contentStart || markerStart >= limit) {
			throw new Error(`Incomplete Margin AI message: ${entry.meta.id}`);
		}
		const blockEnd = markerStart + endMarker.length;
		return {
			start: entry.index,
			end: blockEnd,
			message: {
				...entry.meta,
				content: unescapeManagedMarkers(markdown.slice(entry.contentStart, markerStart)),
			},
		};
	});
}

export function createAnnotationDocument(annotation: Annotation): string {
	const { source } = annotation;
	if (annotation.pdfHighlight && (source.kind !== 'pdf' || !source.page || !source.pdfSelection)) throw new Error('Native PDF highlight metadata requires a located PDF passage.');
	const frontmatter: Record<string, unknown> = {
		'margin-ai': 1,
		id: annotation.id,
		created: annotation.createdAt,
		source: source.link,
		source_path: source.path,
		source_kind: source.kind,
		quote: source.quote,
		context_before: source.contextBefore,
		context_after: source.contextAfter,
		start_offset: source.startOffset ?? null,
		end_offset: source.endOffset ?? null,
		page: source.page ?? null,
		pdf_selection: source.pdfSelection ?? null,
		...(annotation.pdfHighlight ? { pdf_highlight: annotation.pdfHighlight } : {}),
		scope: source.scopeLabel,
		...(annotation.summary ? { summary: annotation.summary } : {}),
	};
	const lines = [
		'# Annotation',
		'',
		'## Source',
		'',
		source.link,
		'',
		quoteBlock(source.quote),
		'',
		'# Conversation',
	];
	let markdown = `${renderFrontmatter(frontmatter)}${lines.join('\n')}\n`;
	for (const message of annotation.messages) markdown = appendMessage(markdown, message);
	return markdown;
}

export function parseAnnotation(markdown: string): Annotation {
	const { frontmatter } = parseFrontmatter(markdown);
	if (readField(frontmatter, 'margin-ai') !== 1) throw new Error('Unsupported Margin AI companion version.');
	const kind = stringField(frontmatter, 'source_kind') as SourceKind;
	if (kind !== 'markdown' && kind !== 'pdf') throw new Error('Invalid Margin AI source kind.');
	const selectionValue = readField(frontmatter, 'pdf_selection');
	const source: SourceCapture = {
		kind,
		path: stringField(frontmatter, 'source_path'),
		link: stringField(frontmatter, 'source'),
		quote: stringField(frontmatter, 'quote'),
		contextBefore: stringField(frontmatter, 'context_before'),
		contextAfter: stringField(frontmatter, 'context_after'),
		startOffset: optionalNumber(frontmatter, 'start_offset'),
		endOffset: optionalNumber(frontmatter, 'end_offset'),
		page: optionalNumber(frontmatter, 'page'),
		pdfSelection: selectionValue === null ? undefined : selectionValue as [number, number, number, number],
		scopeLabel: stringField(frontmatter, 'scope'),
	};
	const summaryValue = frontmatter.summary;
	const pdfHighlightValue = frontmatter.pdf_highlight;
	let pdfHighlight: Annotation['pdfHighlight'];
	if ('pdf_highlight' in frontmatter) {
		if (!pdfHighlightValue || typeof pdfHighlightValue !== 'object' || Array.isArray(pdfHighlightValue)) throw new Error('Invalid Margin AI PDF highlight.');
		pdfHighlight = pdfHighlightValue as NonNullable<Annotation['pdfHighlight']>;
		if (kind !== 'pdf' || !source.page || !source.pdfSelection || typeof pdfHighlight.annotationId !== 'string' || !pdfHighlight.annotationId || typeof pdfHighlight.color !== 'string' || !pdfHighlight.color) throw new Error('Invalid Margin AI PDF highlight.');
	}
	const summary = summaryValue && typeof summaryValue === 'object' && !Array.isArray(summaryValue)
		? summaryValue as Annotation['summary'] : undefined;
	if (summary && (typeof summary.title !== 'string' || typeof summary.text !== 'string' || typeof summary.model !== 'string' || typeof summary.updatedAt !== 'string' || !Array.isArray(summary.coveredMessageIds) || summary.coveredMessageIds.some(id => typeof id !== 'string') || (summary.contentFingerprint !== undefined && typeof summary.contentFingerprint !== 'string'))) throw new Error('Invalid Margin AI summary.');
	return {
		id: stringField(frontmatter, 'id'),
		createdAt: stringField(frontmatter, 'created'),
		source,
		messages: messageRanges(markdown).map((range) => range.message),
		...(pdfHighlight ? { pdfHighlight } : {}),
		...(summary ? { summary } : {}),
	};
}

export function appendMessage(markdown: string, message: Message): string {
	const separator = markdown.endsWith('\n') ? '\n' : '\n\n';
	return `${markdown}${separator}${messageBlock(message)}\n`;
}

export function replaceMessage(markdown: string, messageId: string, replacement: Message): string {
	if (replacement.id !== messageId) throw new Error('Replacement message ID must match the target.');
	const range = messageRanges(markdown).find((entry) => entry.message.id === messageId);
	if (!range) throw new Error(`Message not found: ${messageId}`);
	return `${markdown.slice(0, range.start)}${messageBlock(replacement)}${markdown.slice(range.end)}`;
}

function replaceFrontmatterField(markdown: string, name: string, value: unknown): string {
	const { frontmatter, bodyStart } = parseFrontmatter(markdown);
	if (!(name in frontmatter)) throw new Error(`Missing Margin AI field: ${name}`);
	frontmatter[name] = value;
	return `${renderFrontmatter(frontmatter)}${markdown.slice(bodyStart)}`;
}

export function updateSourcePath(markdown: string, oldPath: string, newPath: string): string {
	const parsed = parseAnnotation(markdown);
	if (parsed.source.path !== oldPath) return markdown;
	const subpath = parsed.source.link.match(/^\[\[[^#|\]]+([^\]]*)\]\]$/)?.[1] ?? '';
	let updated = replaceFrontmatterField(markdown, 'source_path', newPath);
	updated = replaceFrontmatterField(updated, 'source', `[[${newPath}${subpath}]]`);
	const sourceSection = `${parsed.source.link}\n\n${quoteBlock(parsed.source.quote)}`;
	return updated.replace(sourceSection, `[[${newPath}${subpath}]]\n\n${quoteBlock(parsed.source.quote)}`);
}

export function updateSummary(markdown: string, summary: NonNullable<Annotation['summary']>): string {
	const { frontmatter, bodyStart } = parseFrontmatter(markdown); frontmatter.summary = summary;
	return `${renderFrontmatter(frontmatter)}${markdown.slice(bodyStart)}`;
}

export function updatePdfHighlight(markdown: string, pdfHighlight: NonNullable<Annotation['pdfHighlight']>): string {
	const annotation = parseAnnotation(markdown);
	if (annotation.source.kind !== 'pdf' || !annotation.source.page || !annotation.source.pdfSelection) {
		throw new Error('Native PDF highlight metadata requires a located PDF passage.');
	}
	const { frontmatter, bodyStart } = parseFrontmatter(markdown);
	frontmatter.pdf_highlight = pdfHighlight;
	return `${renderFrontmatter(frontmatter)}${markdown.slice(bodyStart)}`;
}

export function markPendingMessagesInterrupted(markdown: string): string {
	let updated = markdown;
	for (const pending of messageRanges(markdown).filter((entry) => entry.message.status === 'pending')) {
		updated = replaceMessage(updated, pending.message.id, {
			...pending.message,
			status: 'interrupted',
			content: 'The request was interrupted when Obsidian closed. Retry to continue.',
		});
	}
	return updated;
}
