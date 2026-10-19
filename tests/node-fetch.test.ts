import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import * as transport from '../src/margin-ai/node-fetch';

describe('OpenAI Node transport response bridge', () => {
  it('copies Node chunks into a native web ReadableStream that Response can parse', async () => {
    const bridge = (transport as unknown as {
      nodeReadableToWebBody(source: Readable): ReadableStream<Uint8Array>;
    }).nodeReadableToWebBody;
    const source = Readable.from([
      Buffer.from('{"models":'),
      Buffer.from('[{"slug":"test"}]}'),
    ]);

    const body = bridge(source);
    expect(body).toBeInstanceOf(ReadableStream);
    await expect(new Response(body).json()).resolves.toEqual({ models: [{ slug: 'test' }] });
  });

  it('destroys the Node response when the native stream is cancelled', async () => {
    const bridge = (transport as unknown as {
      nodeReadableToWebBody(source: Readable): ReadableStream<Uint8Array>;
    }).nodeReadableToWebBody;
    const source = new Readable({ read() {} });
    const body = bridge(source);
    await body.cancel();
    expect(source.destroyed).toBe(true);
  });
});
