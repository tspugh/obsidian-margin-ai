import { normalizeMathDelimiters } from './message-format';

export function validateExportPath(input: string): string {
	const path = input.trim().replaceAll('\\', '/').replace(/^\.\//, '');
	const parts = path.split('/');
	if (!path || path.startsWith('/') || /^[a-z]:\//i.test(path) || /[\u0000-\u001f\u007f]/.test(path) || parts.some(part => !part || part === '..' || part.startsWith('.')) || !path.toLowerCase().endsWith('.md')) throw new Error('Choose a safe vault-relative .md path outside hidden configuration folders.');
	return path;
}
export function assertExportDestinationAvailable(path: string, exists: (path: string) => boolean): string {
	const safe = validateExportPath(path); if (exists(safe)) throw new Error('A file already exists at that destination. Choose a new path.'); return safe;
}
export function buildExportMarkdown(input: { title?: string; sourceLink: string; quote: string; summary?: string; messages: readonly { role: string; content: string; status?: string }[] }): string {
	const quote = input.quote ? input.quote.split('\n').map(line => `> ${line}`).join('\n') : '> _Whole document_';
	const transcript = input.messages.map(message => [`> #### ${message.role === 'user' ? 'You' : 'ChatGPT'}${message.status && message.status !== 'complete' ? ` · ${message.status}` : ''}`, ...normalizeMathDelimiters(message.content).split('\n').map(line => `> ${line || ' '}`)].join('\n')).join('\n>\n');
	return [`# ${input.title || 'Margin note'}`, '', `Source: ${input.sourceLink}`, '', quote, ...(input.summary ? ['', '## Summary', '', input.summary] : []), '', '> [!note]- Conversation', transcript || '> _No messages._', ''].join('\n');
}
