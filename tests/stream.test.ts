import { describe, expect, it } from 'vitest';
import { consumeResponseEvents, parseSse } from '../src/margin-ai/response-stream';

describe('Responses SSE stream', () => {
  it('collects deltas only after a response.completed event', async () => {
    const chunks = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"lo"}\n\ndata: {"type":"response.completed"}\n\n',
    ];
    expect(await consumeResponseEvents(parseSse(chunks))).toBe('Hello');
  });

  it('rejects a stream that ends without response.completed', async () => {
    await expect(consumeResponseEvents(parseSse(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n']))).rejects.toThrow(/completed/i);
  });

  it('surfaces structured response.failed errors', async () => {
    const event = 'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Limit reached"}}}\n\n';
    await expect(consumeResponseEvents(parseSse([event]))).rejects.toMatchObject({ code: 'subscription_sharing_usage_limit_exceeded' });
  });

  it('parses an event split across arbitrary network chunks', async () => {
    const chunks = ['data: {"type":"response.output_', 'text.delta","delta":"ok"}\n\ndata: {"type":"response.completed"}\n', '\n'];
    expect(await consumeResponseEvents(parseSse(chunks))).toBe('ok');
  });

  it('parses CRLF delimiters split between network chunks', async () => {
    const chunks = [
      'data: {"type":"response.output_text.delta","delta":"ok"}\r',
      '\n\r',
      '\ndata: {"type":"response.completed"}\r',
      '\n\r',
      '\n',
    ];
    expect(await consumeResponseEvents(parseSse(chunks))).toBe('ok');
  });

  it('surfaces top-level streaming error events', async () => {
    const event = 'data: {"type":"error","error":{"code":"bad_request","message":"Rejected input"}}\n\n';
    await expect(consumeResponseEvents(parseSse([event]))).rejects.toMatchObject({ code: 'bad_request', message: 'Rejected input' });
  });
});
