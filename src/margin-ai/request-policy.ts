function normalizeOne(path: string): string {
	const value = path.trim().replace(/^\.\//, '').replace(/\/$/, '');
	const parts = value.split('/');
	if (!value || value.startsWith('/') || value.includes('\\') || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
		throw new Error(`Excluded folders must be vault-relative: ${path}`);
	}
	return parts.join('/');
}

export function normalizeExcludedFolders(input: string | readonly string[]): string[] {
	const raw = typeof input === 'string' ? input.split(/[\n,]/) : [...input];
	return [...new Set(raw.map((value) => value.trim()).filter(Boolean).map(normalizeOne))];
}

export function mergeRetryExclusions(original: readonly string[], current: readonly string[]): string[] {
	return [...new Set([...original, ...current])];
}
