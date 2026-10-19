import type {
	ContextRetrievalMetadata,
	ContextScope,
	ContextSourceMetadata,
	MarkdownContextReader,
	RequestContextSnapshot,
	ResolvedContextScope,
} from './types';

const MAX_FILES = 100;
const MAX_EXCERPTS = 5;
const MAX_FILE_CHARACTERS = 4_000;
const MAX_TOTAL_CHARACTERS = 16_000;

export interface ContextPathOptions {
	companionFolder: string;
	excludedFolders: readonly string[];
}

export interface RetrieveContextOptions extends ContextPathOptions {
	sourcePath: string;
	scope: ContextScope;
	query: string;
	selectedNotePaths?: readonly string[];
	signal?: AbortSignal;
}

export interface ContextExcerpt {
	path: string;
	text: string;
	matchedTerms: string[];
}

export interface ContextRetrievalResult {
	examinedCount: number;
	matchedCount: number;
	readSources: string[];
	matchedSources: string[];
	excerpts: ContextExcerpt[];
	truncated: boolean;
	noResults: boolean;
	omittedSelectedNotePaths: string[];
}

export interface RequestContextUsage {
	sources?: readonly ContextSourceMetadata[];
	retrieval?: ContextRetrievalMetadata;
	selectedNotePaths?: readonly string[];
}

function abortError(): Error {
	const error = new Error('The context request was cancelled.');
	error.name = 'AbortError';
	return error;
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function segments(path: string): string[] {
	if (!path || path.startsWith('/') || path.includes('\\')) throw new Error(`Invalid vault path: ${path}`);
	const values = path.split('/');
	if (values.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
		throw new Error(`Invalid vault path: ${path}`);
	}
	return values;
}

function isWithin(path: string, root: string): boolean {
	return root === '' || path === root || path.startsWith(`${root}/`);
}

export function resolveContextScope(sourcePath: string, scope: ContextScope): ResolvedContextScope {
	const sourceSegments = segments(sourcePath);
	if (scope.kind === 'passage') return { kind: 'passage', root: null };
	if (scope.kind === 'document') return { kind: 'document', root: sourcePath };
	if (scope.kind === 'vault') return { kind: 'vault', root: '' };
	if (!Number.isInteger(scope.ancestorDepth) || scope.ancestorDepth < 0) throw new Error('Folder ancestor depth must be a non-negative integer.');
	const folders = sourceSegments.slice(0, -1);
	if (scope.ancestorDepth > folders.length) throw new Error('Folder ancestor depth exceeds the vault root.');
	return { kind: 'folder', root: folders.slice(0, folders.length - scope.ancestorDepth).join('/') };
}

export function isPathAllowed(path: string, scope: ResolvedContextScope, options: ContextPathOptions): boolean {
	let pathParts: string[];
	try {
		pathParts = segments(path);
	} catch {
		return false;
	}
	if (!path.toLowerCase().endsWith('.md') || pathParts.some((part) => part.startsWith('.'))) return false;
	const excluded = [options.companionFolder, ...options.excludedFolders];
	if (excluded.some((folder) => {
		try {
			segments(folder);
			return isWithin(path, folder);
		} catch {
			return true;
		}
	})) return false;
	if (scope.kind === 'passage') return false;
	if (scope.kind === 'document') return path === scope.root;
	return isWithin(path, scope.root);
}

export function createRequestContextSnapshot(
	sourcePath: string,
	scope: ContextScope,
	model: string,
	paths: ContextPathOptions,
	usage: RequestContextUsage = {},
): RequestContextSnapshot {
	resolveContextScope(sourcePath, scope);
	const scopeCopy = Object.freeze({ ...scope }) as Readonly<ContextScope>;
	const excludedFolders = Object.freeze([...paths.excludedFolders]);
	const sources = usage.sources?.map((source) => Object.freeze({
		...source,
		matchedTerms: Object.freeze([...source.matchedTerms]),
	}));
	if (sources) Object.freeze(sources);
	const retrieval = usage.retrieval ? Object.freeze({ ...usage.retrieval }) : undefined;
	const selectedNotePaths = usage.selectedNotePaths ? Object.freeze([...usage.selectedNotePaths]) : undefined;
	return Object.freeze({
		sourcePath,
		scope: scopeCopy,
		model,
		companionFolder: paths.companionFolder,
		excludedFolders,
		...(sources ? { sources } : {}),
		...(retrieval ? { retrieval } : {}),
		...(selectedNotePaths ? { selectedNotePaths } : {}),
	});
}

function queryTerms(query: string): string[] {
	return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

function excerptNearMatch(content: string, firstMatch: number): string {
	if (content.length <= MAX_FILE_CHARACTERS) return content;
	const start = Math.max(0, Math.min(firstMatch - Math.floor(MAX_FILE_CHARACTERS / 3), content.length - MAX_FILE_CHARACTERS));
	return content.slice(start, start + MAX_FILE_CHARACTERS);
}

export async function retrieveLocalContext(reader: MarkdownContextReader, options: RetrieveContextOptions): Promise<ContextRetrievalResult> {
	checkAborted(options.signal);
	if (options.sourcePath.toLowerCase().endsWith('.pdf') && options.scope.kind === 'document') {
		throw new Error('PDF context is limited to the captured passage until document extraction is available.');
	}
	const resolved = resolveContextScope(options.sourcePath, options.scope);
	const empty = (): ContextRetrievalResult => ({
		examinedCount: 0, matchedCount: 0, readSources: [], matchedSources: [], excerpts: [], truncated: false, noResults: true, omittedSelectedNotePaths: [],
	});
	if (resolved.kind === 'passage' && !options.selectedNotePaths?.length) return empty();

	checkAborted(options.signal);
	const listed = await reader.listMarkdownPaths();
	checkAborted(options.signal);
	const permitted = listed
		.filter((path) => isPathAllowed(path, resolved, options))
		.sort((left, right) => left.localeCompare(right));
	const explicit = [...new Set(options.selectedNotePaths ?? [])].sort((left, right) => left.localeCompare(right));
	const explicitAllowed = explicit.filter(path => listed.includes(path) && isPathAllowed(path, { kind: 'vault', root: '' }, options));
	const omittedSelectedNotePaths = explicit.filter(path => !explicitAllowed.includes(path));
	const selectedPaths = [...explicitAllowed, ...permitted.filter(path => !explicitAllowed.includes(path))].slice(0, MAX_FILES);
	const terms = queryTerms(options.query);
	const readSources: string[] = [];
	const matches: Array<ContextExcerpt & { score: number; sourceTruncated: boolean }> = [];

	for (const path of selectedPaths) {
		checkAborted(options.signal);
		const safe = await reader.isSafeMarkdownPath(path);
		checkAborted(options.signal);
		if (!safe) { if (explicitAllowed.includes(path)) omittedSelectedNotePaths.push(path); continue; }
		let content: string;
		try { content = await reader.readMarkdown(path); }
		catch (error) { if (explicitAllowed.includes(path)) { omittedSelectedNotePaths.push(path); continue; } throw error; }
		checkAborted(options.signal);
		readSources.push(path);
		const lower = content.toLocaleLowerCase();
		const matchedTerms = terms.filter((term) => lower.includes(term));
		const wholeMarkdownDocument = resolved.kind === 'document';
		const explicitlySelected = explicitAllowed.includes(path);
		if (matchedTerms.length === 0 && !wholeMarkdownDocument && !explicitlySelected) continue;
		const firstMatch = matchedTerms.length > 0 ? Math.min(...matchedTerms.map((term) => lower.indexOf(term))) : 0;
		matches.push({
			path,
			text: excerptNearMatch(content, firstMatch),
			matchedTerms,
			score: explicitlySelected ? Number.MAX_SAFE_INTEGER : wholeMarkdownDocument ? Number.MAX_SAFE_INTEGER - 1 : matchedTerms.length,
			sourceTruncated: content.length > MAX_FILE_CHARACTERS,
		});
	}

	matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
	const excerpts: ContextExcerpt[] = [];
	let totalCharacters = 0;
	for (const match of matches) {
		if (excerpts.length >= MAX_EXCERPTS || totalCharacters + match.text.length > MAX_TOTAL_CHARACTERS) break;
		excerpts.push({ path: match.path, text: match.text, matchedTerms: match.matchedTerms });
		totalCharacters += match.text.length;
	}
	for (const path of explicitAllowed) if (!excerpts.some(excerpt => excerpt.path === path) && !omittedSelectedNotePaths.includes(path)) omittedSelectedNotePaths.push(path);
	return {
		examinedCount: readSources.length,
		matchedCount: matches.length,
		readSources,
		matchedSources: matches.map((match) => match.path),
		excerpts,
		truncated: selectedPaths.length < explicitAllowed.length + permitted.filter(path => !explicitAllowed.includes(path)).length || matches.length > excerpts.length || matches.some((match) => match.sourceTruncated),
		noResults: excerpts.length === 0,
		omittedSelectedNotePaths: omittedSelectedNotePaths.sort((left, right) => left.localeCompare(right)),
	};
}
