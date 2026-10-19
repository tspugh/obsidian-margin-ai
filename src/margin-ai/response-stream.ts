export interface ResponseEvent {
	type: string;
	delta?: string;
	response?: {
		error?: { code?: string; message?: string };
	};
	error?: { code?: string; message?: string };
}

export class ResponseStreamError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'ResponseStreamError';
	}
}

async function* asAsync(chunks: Iterable<string> | AsyncIterable<string>): AsyncGenerator<string> {
	if (Symbol.asyncIterator in chunks) {
		for await (const chunk of chunks as AsyncIterable<string>) yield chunk;
	} else {
		for (const chunk of chunks as Iterable<string>) yield chunk;
	}
}

export async function* parseSse(chunks: Iterable<string> | AsyncIterable<string>): AsyncGenerator<ResponseEvent> {
	let buffer = '';
	for await (const chunk of asAsync(chunks)) {
		buffer += chunk;
		buffer = buffer.replaceAll('\r\n', '\n').replace(/\r(?!$)/g, '\n');
		for (;;) {
			const boundary = buffer.indexOf('\n\n');
			if (boundary < 0) break;
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const data = block.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trimStart())
				.join('\n');
			if (!data || data === '[DONE]') continue;
			yield JSON.parse(data) as ResponseEvent;
		}
	}
	if (buffer.trim()) throw new ResponseStreamError('interrupted', 'The response stream ended in the middle of an event.');
}

export async function consumeResponseEvents(events: AsyncIterable<ResponseEvent>, onDelta?: (delta: string) => void): Promise<string> {
	let text = '';
	for await (const event of events) {
		if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
			text += event.delta;
			onDelta?.(event.delta);
		}
		if (event.type === 'response.failed') {
			const error = event.response?.error;
			throw new ResponseStreamError(error?.code ?? 'response_failed', error?.message ?? 'The response failed.');
		}
		if (event.type === 'error') {
			throw new ResponseStreamError(event.error?.code ?? 'stream_error', event.error?.message ?? 'The response stream failed.');
		}
		if (event.type === 'response.incomplete') throw new ResponseStreamError('response_incomplete', 'The response was incomplete.');
		if (event.type === 'response.completed') return text;
	}
	throw new ResponseStreamError('missing_completed', 'The response stream ended without response.completed.');
}
