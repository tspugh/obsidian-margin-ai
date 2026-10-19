import { describe, expect, it } from 'vitest';
import { chooseLightweightModel, compactConversation, conversationFingerprint, isSummaryFresh } from '../src/margin-ai/summaries';
import type { Annotation, Message } from '../src/margin-ai/types';

const msg = (id: string, content = id): Message => ({ id, content, role: id.startsWith('a') ? 'assistant' : 'user', status: 'complete', createdAt: id });
describe('summaries and compaction', () => {
  it('chooses only a discovered lightweight model', () => {
    expect(chooseLightweightModel([{ slug: 'gpt-pro' }, { slug: 'gpt-mini' }])).toBe('gpt-mini');
    expect(chooseLightweightModel([{ slug: 'gpt-pro' }])).toBeUndefined();
  });
  it('accepts only an exact covered prefix and keeps recent turns verbatim', () => {
    const messages = [msg('u1', 'x'.repeat(50)), msg('a1', 'y'.repeat(50)), msg('u2'), msg('a2')];
    const annotation = { id: 'x', messages, summary: { title: 'T', text: 'Earlier', model: 'mini', updatedAt: 'now', coveredMessageIds: ['u1','a1'], contentFingerprint: conversationFingerprint(messages.slice(0, 2)) } } as Annotation;
    expect(isSummaryFresh(annotation, ['u1','a1'])).toBe(true);
    const compact = compactConversation(annotation, 80, 2);
    expect(compact.map(x => x.content)).toEqual(['Summary of earlier conversation: Earlier', 'u2', 'a2']);
    annotation.summary!.coveredMessageIds = ['u1','u2'];
    expect(() => compactConversation(annotation, 20, 2)).toThrow(/valid summary/i);
  });
  it('invalidates a summary when covered message content was edited', () => {
    const messages = [msg('u1', 'before'), msg('a1', 'reply')];
    const annotation = { id: 'x', messages, summary: { title: 'T', text: 'Earlier', model: 'mini', updatedAt: 'now', coveredMessageIds: ['u1','a1'], contentFingerprint: conversationFingerprint(messages) } } as Annotation;
    expect(isSummaryFresh(annotation, ['u1','a1'])).toBe(true);
    messages[0].content = 'after';
    expect(isSummaryFresh(annotation, ['u1','a1'])).toBe(false);
  });
});
