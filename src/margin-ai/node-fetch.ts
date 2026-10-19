import { request as httpsRequest } from 'https';
import { Buffer } from 'buffer';
import type { Readable } from 'stream';

const ALLOWED_ORIGINS = new Set(['https://auth.openai.com', 'https://api.openai.com']);
const RESPONSE_HEADER_TIMEOUT_MS = 30_000;

/**
 * Node's Readable.toWeb() creates a stream in Node's realm. Chromium Response
 * treats that foreign stream as "[object ReadableStream]", so copy each chunk
 * into a ReadableStream constructed in the renderer realm instead.
 */
export function nodeReadableToWebBody(source: Readable): ReadableStream<Uint8Array> {
	let cleanup = () => undefined;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const onData = (chunk: Buffer | Uint8Array | string) => {
				if (typeof chunk === 'string') controller.enqueue(new TextEncoder().encode(chunk));
				else controller.enqueue(Uint8Array.from(chunk));
			};
			const onEnd = () => {
				cleanup();
				controller.close();
			};
			const onError = (error: Error) => {
				cleanup();
				controller.error(error);
			};
			cleanup = () => {
				source.removeListener('data', onData);
				source.removeListener('end', onEnd);
				source.removeListener('error', onError);
			};
			source.on('data', onData);
			source.once('end', onEnd);
			source.once('error', onError);
		},
		cancel() {
			cleanup();
			source.destroy();
		},
	});
}

/** Node-side transport avoids renderer CORS and refuses to send credentials to any other origin. */
export async function openAiNodeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
	const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
	if (url.protocol !== 'https:' || !ALLOWED_ORIGINS.has(url.origin)) {
		throw new Error(`Refusing OpenAI credential request to untrusted origin: ${url.origin}`);
	}
	const sourceHeaders = init.headers ?? (input instanceof Request ? input.headers : undefined);
	const headers = new Headers(sourceHeaders);
	let body: string | Uint8Array | undefined;
	if (init.body instanceof URLSearchParams) body = init.body.toString();
	else if (typeof init.body === 'string') body = init.body;
	else if (init.body instanceof Uint8Array) body = init.body;
	else if (init.body !== undefined && init.body !== null) throw new Error('Unsupported request body for OpenAI transport.');
	if (body !== undefined && !headers.has('content-length')) {
		headers.set('content-length', String(Buffer.byteLength(body)));
	}

	return new Promise<Response>((resolve, reject) => {
		let settled = false;
		const request = httpsRequest(url, {
			method: init.method ?? (input instanceof Request ? input.method : 'GET'),
			headers: Object.fromEntries(headers.entries()),
		}, (incoming) => {
			request.setTimeout(0);
			const responseHeaders = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
				else if (value !== undefined) responseHeaders.set(name, value);
			}
			try {
				const response = new Response(nodeReadableToWebBody(incoming), {
					status: incoming.statusCode ?? 500,
					statusText: incoming.statusMessage,
					headers: responseHeaders,
				});
				settled = true;
				resolve(response);
			} catch (error) {
				incoming.destroy();
				reject(error);
			}
		});
		request.setTimeout(RESPONSE_HEADER_TIMEOUT_MS, () => {
			request.destroy(new Error('OpenAI request timed out before response headers were received.'));
		});
		request.once('error', (error) => {
			if (!settled) reject(error);
		});
		if (init.signal) {
			if (init.signal.aborted) request.destroy(new DOMException('The operation was aborted.', 'AbortError'));
			else init.signal.addEventListener('abort', () => request.destroy(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
		}
		if (body !== undefined) request.write(body);
		request.end();
	});
}
