/** Adapt AI TeX delimiters for Obsidian without changing persisted content. */
export function normalizeMathDelimiters(content: string): string {
	// Preserve fenced (including unfinished streaming fences) and indented code.
	let fence: string | undefined;
	let prose = '';
	let output = '';
	for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const unquoted = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
		const marker = unquoted.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
		if (fence) {
			output += line;
			if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
		} else if (marker || /^( {4}|\t)/.test(unquoted)) {
			output += normalizeInline(prose) + line; prose = '';
			if (marker) fence = marker[1];
		} else prose += line;
	}
	return output + normalizeInline(prose);
}

function normalizeInline(content: string): string {
	const protectedMarkdown = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
	let result = '';
	let offset = 0;
	for (const match of content.matchAll(protectedMarkdown)) {
		result += normalizeProse(content.slice(offset, match.index)) + match[0];
		offset = match.index! + match[0].length;
	}
	return result + normalizeProse(content.slice(offset));
}

function normalizeProse(content: string): string {
	return content.replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g,
		(_match, inline: string | undefined, display: string | undefined) =>
			inline !== undefined ? `$${inline.trim()}$` : `\n$$\n${display!.trim()}\n$$\n`);
}
