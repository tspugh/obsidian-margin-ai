import type { Annotation, Message } from './types';

export function chooseLightweightModel(models: readonly { slug: string }[]): string | undefined {
	return models.find(model => /(?:mini|nano|luna|terra)/i.test(model.slug))?.slug;
}
export function conversationFingerprint(messages: readonly Pick<Message, 'id'|'role'|'content'|'status'>[]): string {
	let hash = 2166136261;
	const value = messages.map(message => `${message.id}\0${message.role}\0${message.status}\0${message.content}`).join('\u0001');
	for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
	return (hash >>> 0).toString(16).padStart(8, '0');
}
export function isSummaryFresh(annotation: Annotation, prefixIds: readonly string[]): boolean {
	if (!annotation.summary || !annotation.summary.contentFingerprint || annotation.summary.coveredMessageIds.length !== prefixIds.length || !prefixIds.every((id, i) => annotation.summary!.coveredMessageIds[i] === id)) return false;
	const byId = new Map(annotation.messages.map(message => [message.id, message])); const covered = prefixIds.map(id => byId.get(id));
	return covered.every((message): message is Message => !!message) && conversationFingerprint(covered) === annotation.summary.contentFingerprint;
}
export function compactConversation(annotation: Annotation, maxCharacters = 80_000, keepRecent = 6): Array<Pick<Message, 'role'|'content'>> {
	const complete = annotation.messages.filter(message => message.status === 'complete' && message.content);
	const total = complete.reduce((n, message) => n + message.content.length, 0);
	if (total <= maxCharacters) return complete.map(({ role, content }) => ({ role, content }));
	const split = annotation.summary?.coveredMessageIds.length ?? Math.max(0, complete.length - keepRecent); const prefix = complete.slice(0, split);
	if (!prefix.length || !isSummaryFresh(annotation, prefix.map(x => x.id))) throw new Error('Conversation is too long to send. Refresh a valid summary or start a new conversation.');
	const replayFrom = Math.min(split, Math.max(0, complete.length - keepRecent));
	const result: Array<Pick<Message, 'role'|'content'>> = [{ role: 'user', content: `Summary of earlier conversation: ${annotation.summary!.text}` }, ...complete.slice(replayFrom).map(({ role, content }) => ({ role, content }))];
	if (result.reduce((n, item) => n + item.content.length, 0) > maxCharacters) throw new Error('Conversation still exceeds the character limit after compaction. Keep fewer recent messages or start a new conversation.');
	return result;
}
