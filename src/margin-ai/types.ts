export type SourceKind = 'markdown' | 'pdf';
export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'pending' | 'error' | 'cancelled' | 'interrupted';

export type ContextScope =
	| { kind: 'passage' }
	| { kind: 'document' }
	| { kind: 'folder'; ancestorDepth: number }
	| { kind: 'vault' };

export type ResolvedContextScope =
	| { kind: 'passage'; root: null }
	| { kind: 'document'; root: string }
	| { kind: 'folder' | 'vault'; root: string };

export interface ContextSourceMetadata {
	readonly path: string;
	readonly excerptCharacters: number;
	readonly matchedTerms: readonly string[];
}

export interface ContextRetrievalMetadata {
	readonly examinedCount: number;
	readonly matchedCount: number;
	readonly truncated: boolean;
	readonly noResults: boolean;
}

export interface RequestContextSnapshot {
	readonly sourcePath: string;
	readonly scope: Readonly<ContextScope>;
	readonly model: string;
	readonly companionFolder: string;
	readonly excludedFolders: readonly string[];
	readonly selectedNotePaths?: readonly string[];
	readonly sources?: readonly ContextSourceMetadata[];
	readonly retrieval?: ContextRetrievalMetadata;
	readonly includePdfImages?: boolean;
	readonly imagePageOverride?: string;
	readonly actualTextPages?: readonly number[];
	readonly actualImagePages?: readonly number[];
	readonly partialDocumentCoverage?: boolean;
	readonly omittedSelectedNotePaths?: readonly string[];
}

export interface MarkdownContextReader {
	listMarkdownPaths(): Promise<readonly string[]>;
	/** The adapter must return false for symlinks and paths outside the vault. */
	isSafeMarkdownPath(path: string): Promise<boolean>;
	readMarkdown(path: string): Promise<string>;
}

export interface SourceCapture {
	kind: SourceKind;
	path: string;
	link: string;
	quote: string;
	contextBefore: string;
	contextAfter: string;
	startOffset?: number;
	endOffset?: number;
	page?: number;
	pdfSelection?: [number, number, number, number];
	scopeLabel: string;
}

export interface Message {
	id: string;
	role: MessageRole;
	createdAt: string;
	status: MessageStatus;
	content: string;
	requestContext?: RequestContextSnapshot;
}

export interface Annotation {
	id: string;
	createdAt: string;
	source: SourceCapture;
	messages: Message[];
	pdfHighlight?: { annotationId: string; color: string };
	summary?: { title: string; text: string; model: string; updatedAt: string; coveredMessageIds: string[]; contentFingerprint?: string };
}

export type MarkdownAnchor = Pick<SourceCapture,
	'quote' | 'contextBefore' | 'contextAfter'> & {
	startOffset: number;
	endOffset: number;
};

export type AnchorResolution =
	| { status: 'resolved'; startOffset: number; endOffset: number }
	| { status: 'missing' }
	| { status: 'ambiguous'; matches: number };
