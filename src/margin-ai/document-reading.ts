export interface ExtractedDocument { pages: string[]; pageCount: number }

export class DocumentTextCache {
	private readonly entries = new Map<string, ExtractedDocument>();
	private readonly inFlight = new Map<string, { promise: Promise<ExtractedDocument>; generation: number }>();
	private readonly currentVersion = new Map<string, string>();
	private generation = 0;
	private cachedCharacters = 0;
	constructor(private readonly limit = 4, private readonly maxCharacters = 500_000) {}
	private key(path: string, mtime: number, size: number): string { return `${path}\0${mtime}\0${size}`; }
	has(path: string, mtime: number, size: number): boolean { return this.entries.has(this.key(path, mtime, size)); }
	async get(path: string, mtime: number, size: number, load: () => Promise<ExtractedDocument>): Promise<ExtractedDocument> {
		const key = this.key(path, mtime, size); const cached = this.entries.get(key);
		if (cached) { this.entries.delete(key); this.entries.set(key, cached); return cached; }
		const pending = this.inFlight.get(key); if (pending) return pending.promise;
		const generation = ++this.generation;
		this.currentVersion.set(path, key);
		for (const existing of [...this.entries.keys()]) if (existing.startsWith(`${path}\0`)) this.remove(existing);
		const promise = load().then(value => {
			if (this.currentVersion.get(path) === key && this.inFlight.get(key)?.generation === generation) { this.entries.set(key, value); this.cachedCharacters += this.characters(value); this.evict(); }
			return value;
		}).finally(() => { if (this.inFlight.get(key)?.generation === generation) this.inFlight.delete(key); });
		this.inFlight.set(key, { promise, generation }); return promise;
	}
	private characters(value: ExtractedDocument): number { return value.pages.reduce((sum, page) => sum + page.length, 0); }
	private remove(key: string): void { const value = this.entries.get(key); if (value) this.cachedCharacters -= this.characters(value); this.entries.delete(key); }
	private evict(): void { while (this.entries.size > this.limit || this.cachedCharacters > this.maxCharacters) this.remove(this.entries.keys().next().value!); }
	clear(): void { this.generation++; this.entries.clear(); this.inFlight.clear(); this.currentVersion.clear(); this.cachedCharacters = 0; }
}

function terms(query: string): string[] { return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])]; }
function relevantExcerpt(text: string, queryTerms: readonly string[], maximum: number): string {
	if (text.length <= maximum) return text;
	const lower = text.toLowerCase(); const positions = queryTerms.map(term => lower.indexOf(term)).filter(index => index >= 0);
	const center = positions.length ? Math.min(...positions) : 0; const start = Math.max(0, Math.min(text.length - maximum, center - Math.floor(maximum / 3)));
	return `${start > 0 ? '…' : ''}${text.slice(start, start + maximum - (start > 0 ? 1 : 0) - (start + maximum < text.length ? 1 : 0))}${start + maximum < text.length ? '…' : ''}`;
}
export function buildDocumentContext(pages: readonly string[], query: string, anchorPage?: number, maxCharacters = 120_000) {
	const needle = terms(query);
	const figures = [...query.matchAll(/\b(?:fig(?:ure)?\.?)[\s-]*(\d+)\b/gi)].map(match => match[1]);
	const ranked = pages.map((text, index) => ({ page: index + 1, text, score: needle.reduce((n, term) => n + (text.toLowerCase().split(term).length - 1), 0) + figures.reduce((n, number) => n + (new RegExp(`\\bfig(?:ure)?\\.?\\s*${number}\\b`, 'gi').test(text) ? 1000 : 0), 0) + (index + 1 === anchorPage ? 1e6 : 0) }))
		.sort((a, b) => b.score - a.score || a.page - b.page);
	const full = pages.map((text, index) => `[Page ${index + 1}]\n${text.trim()}`).join('\n\n');
	if (full.length <= maxCharacters) return { text: full, pageNumbers: pages.map((_, index) => index + 1), relevancePageNumbers: ranked.map(item => item.page), partial: false, disclosure: `Full document coverage: all ${pages.length} pages.` };
	const chosen: typeof ranked = []; let used = 0;
	const minimumPages = Math.min(2, ranked.length); const perMinimum = Math.max(20, Math.floor(maxCharacters / minimumPages));
	for (const item of ranked) {
		const available = chosen.length < minimumPages ? Math.min(perMinimum, maxCharacters - used) : maxCharacters - used;
		const prefix = `[Page ${item.page}]\n`; if (available <= prefix.length) continue;
		const text = relevantExcerpt(item.text.trim(), needle, available - prefix.length - 2); if (!text) continue;
		chosen.push({ ...item, text }); used += prefix.length + text.length + 2;
	}
	chosen.sort((a, b) => a.page - b.page);
	let text = chosen.map(item => `[Page ${item.page}]\n${item.text.trim()}`).join('\n\n');
	if (!text && pages.length) text = `[Page ${anchorPage ?? 1}]\n${pages[(anchorPage ?? 1) - 1].slice(0, Math.max(0, maxCharacters - 10))}`.slice(0, maxCharacters);
	const pageNumbers = chosen.map(x => x.page); const partial = pageNumbers.length < pages.length || chosen.some(item => item.text.length < pages[item.page - 1].trim().length);
	return { text, pageNumbers, relevancePageNumbers: ranked.map(item => item.page), partial, disclosure: partial ? `Partial document coverage: ${pageNumbers.length} of ${pages.length} pages selected by query relevance; long pages may be excerpted.` : `Full document coverage: all ${pages.length} pages.` };
}

export function parsePageOverride(value: string, pageCount: number, maximum = 3): number[] {
	if (!value.trim()) return [];
	const raw = value.split(',').map(x => x.trim());
	if (raw.some(x => !/^\d+$/.test(x))) throw new Error('Image pages must be comma-separated whole page numbers.');
	const pages = [...new Set(raw.map(Number))];
	if (pages.some(x => x < 1 || x > pageCount)) throw new Error(`Image pages must be in the range 1–${pageCount}.`);
	if (pages.length > maximum) throw new Error(`A maximum ${maximum} image pages can be sent.`);
	return pages;
}

export function selectImagePages(currentPage: number | undefined, relevant: readonly number[], pageCount: number, maximum = 3): number[] {
	return [...new Set([currentPage, ...relevant].filter((x): x is number => !!x && x >= 1 && x <= pageCount))].slice(0, maximum);
}

export function pagesMentionedInQuery(query: string, pageCount: number): number[] {
	const found: number[] = []; const pattern = /\b(?:p(?:age)?\.?\s*)(\d+)\b/gi;
	for (const match of query.matchAll(pattern)) { const page = Number(match[1]); if (page >= 1 && page <= pageCount && !found.includes(page)) found.push(page); }
	return found;
}
