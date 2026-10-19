import { describe, expect, it, vi } from 'vitest';
import { ChatGptClient } from '../src/margin-ai/chatgpt-client';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

function openedUrl() {
  let resolve!: (url: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}

function callbackServer() {
  let handler!: (request: IncomingMessage, response: ServerResponse) => void;
  const server = {
    once: () => server,
    listen: (_port: number, _host: string, ready: () => void) => { queueMicrotask(ready); return server; },
    address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 43123 }),
    close: () => server,
  } as unknown as Server;
  return {
    factory: ((next: typeof handler) => { handler = next; return server; }),
    request(url: string): { status?: number; body: string; ended: boolean } {
      const record: { status?: number; body: string; ended: boolean } = { body: '', ended: false };
      const response = {
        writeHead: (next: number) => { record.status = next; return response; },
        end: (body?: string) => { record.body += body ?? ''; record.ended = true; return response; },
      } as unknown as ServerResponse;
      handler({ url } as IncomingMessage, response);
      return record;
    },
  };
}

describe('ChatGptClient sign-in lifecycle', () => {
	it('reports real response deltas before returning the completed text', async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream({ start(controller) {
			controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"Hel"}\n\n'));
			controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"lo"}\n\ndata: {"type":"response.completed"}\n\n'));
			controller.close();
		} });
		const client = new ChatGptClient('urn:uuid:test', async () => {}, vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch);
		(client as any).credentials = { clientId: 'saved', subject: 'subject', accessToken: 'token', expiresAt: Date.now() + 60 * 60_000, scopes: [] };
		const deltas: string[] = [];
		await expect(client.respond('gpt-test', [], 'help', undefined, delta => deltas.push(delta))).resolves.toBe('Hello');
		expect(deltas).toEqual(['Hel', 'lo']);
	});
  it('settles promptly when an in-progress sign-in is cancelled', async () => {
    const opened = openedUrl();
    const loopback = callbackServer();
    const client = new ChatGptClient('urn:uuid:test', async (url) => opened.resolve(url), undefined, loopback.factory);
    const signIn = client.signIn();
    await opened.promise;
    client.cancelSignIn();
    await expect(signIn).rejects.toThrow(/cancelled/i);
    expect(client.getSession()).toMatchObject({ status: 'disconnected', sharing: false });
  });

  it('ignores unrelated loopback paths without abandoning the pending callback', async () => {
    const opened = openedUrl();
    const loopback = callbackServer();
    const client = new ChatGptClient('urn:uuid:test', async (url) => opened.resolve(url), undefined, loopback.factory);
    const signIn = client.signIn();
    const authorization = new URL(await opened.promise);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
		expect(loopback.request(new URL('/unrelated', callback).pathname).status).toBe(404);
    const result = await Promise.race([
      signIn.then(() => 'settled', () => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ]);
    expect(result).toBe('pending');
    client.cancelSignIn();
    await expect(signIn).rejects.toThrow(/cancelled/i);
  });

  it('does not replace an existing session after a malformed callback', async () => {
    const opened = openedUrl();
    const loopback = callbackServer();
    const client = new ChatGptClient('urn:uuid:test', async (url) => opened.resolve(url), undefined, loopback.factory);
    const internal = client as unknown as {
      credentials: object;
      state: object;
    };
    internal.credentials = {
      clientId: 'oaiapp_saved', subject: 'subject-1', accessToken: 'secret', refreshToken: 'refresh',
      expiresAt: Date.now() + 60_000, scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
    };
    internal.state = { status: 'connected', sharing: true, storage: 'memory-only' };

    const signIn = client.signIn();
    const authorization = new URL(await opened.promise);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ code: 'attacker', state: 'wrong-state' }).toString();
		const rejected = expect(signIn).rejects.toThrow(/state/i);
		expect(loopback.request(`${callback.pathname}${callback.search}`).status).toBe(400);
		await rejected;
    expect(client.getSession()).toMatchObject({ status: 'connected', sharing: true });
  });

  it('keeps the callback page pending until exchange and identity verification succeed', async () => {
    let finishToken!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => { finishToken = resolve; });
    let identityStarted!: () => void;
    const identityWasStarted = new Promise<void>((resolve) => { identityStarted = resolve; });
    let finishIdentity!: (identity: { sub: string; email: string }) => void;
    const verifiedIdentity = new Promise<{ sub: string; email: string }>((resolve) => { finishIdentity = resolve; });
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/oauth/token')) return tokenResponse;
      throw new Error('Unexpected request.');
    };
    const opened = openedUrl();
    const loopback = callbackServer();
    const client = new ChatGptClient('urn:uuid:test', async (url) => opened.resolve(url), fetcher as typeof fetch, loopback.factory);
    (client as unknown as { verifyIdentity: () => Promise<{ sub: string; email: string }> }).verifyIdentity = async () => {
      identityStarted();
      return verifiedIdentity;
    };
    const stages: Array<string | undefined> = [];
    client.subscribe((session) => stages.push((session as unknown as { stage?: string }).stage));

    const signIn = client.signIn();
    const authorization = new URL(await opened.promise);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      code: 'sensitive-auth-code',
      state: authorization.searchParams.get('state')!,
      client_id: 'oaiapp_issued',
    }).toString();
    const page = loopback.request(`${callback.pathname}${callback.search}`);
    await Promise.resolve();
    expect(page.ended).toBe(false);

    finishToken(new Response(JSON.stringify({
      access_token: 'sensitive-access-token', refresh_token: 'sensitive-refresh-token', id_token: 'sensitive-id-token',
      expires_in: 3600, scope: 'openid resource.invoke chatgpt.tokens.use.direct',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await identityWasStarted;
    expect(page.ended).toBe(false);
    finishIdentity({ sub: 'subject-1', email: 'reader@example.com' });
    await signIn;

    expect(page).toMatchObject({ status: 200, ended: true });
    expect(page.body).toContain('Sign in complete');
    expect(stages).toEqual(expect.arrayContaining([
      'callback-server', 'browser-consent', 'callback-validation', 'code-exchange', 'identity-verification', 'scope-validation',
    ]));
  });

  it('persists a safe stage diagnostic when code exchange fails', async () => {
		const fetcher = async (): Promise<Response> => new Response(JSON.stringify({
			error: 'invalid_grant',
			error_description: 'Never echo sensitive-auth-code or https://auth.openai.com/private',
		}), {
		status: 400,
		headers: { 'content-type': 'application/json', 'openai-request-id': 'req_safe_123' },
    });
    const opened = openedUrl();
    const loopback = callbackServer();
    const client = new ChatGptClient('urn:uuid:test', async (url) => opened.resolve(url), fetcher as typeof fetch, loopback.factory);
    const signIn = client.signIn();
    const authorizationUrl = await opened.promise;
    const authorization = new URL(authorizationUrl);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      code: 'sensitive-auth-code',
      state: authorization.searchParams.get('state')!,
      client_id: 'oaiapp_issued',
    }).toString();
    const rejected = expect(signIn).rejects.toThrow();
    const page = loopback.request(`${callback.pathname}${callback.search}`);
    await rejected;

    const session = client.getSession() as unknown as {
      error?: { stage: string; summary: string; code?: string; requestId?: string };
    };
    expect(session.error).toMatchObject({ stage: 'code-exchange', code: 'invalid_grant', requestId: 'req_safe_123' });
    expect(page).toMatchObject({ status: 400, ended: true });
    expect(page.body).not.toContain('Sign in complete');
    const diagnostic = JSON.stringify(session);
    expect(diagnostic).not.toContain('sensitive-auth-code');
    expect(diagnostic).not.toContain(authorizationUrl);
    expect(diagnostic).not.toContain('127.0.0.1');
		expect(diagnostic).not.toContain('private');
  });

  it('keeps disconnect final when an in-flight refresh finishes late', async () => {
    let finishRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/oauth/token')) return refresh;
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('', { status: 500 });
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = new ChatGptClient('urn:uuid:test', async () => undefined, fetcher as typeof fetch);
    const internal = client as unknown as { credentials: object | null; state: object };
    internal.credentials = {
      clientId: 'oaiapp_saved', subject: 'subject-1', accessToken: 'old', refreshToken: 'refresh',
      expiresAt: 0, scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
    };
    internal.state = { status: 'connected', sharing: true, storage: 'memory-only' };

    const models = client.listModels();
    const disconnected = client.disconnect();
    finishRefresh(new Response(JSON.stringify({
      access_token: 'late-secret', refresh_token: 'late-refresh', expires_in: 3600,
      scope: 'openid resource.invoke chatgpt.tokens.use.direct',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(models).rejects.toThrow();
    await disconnected;
    expect(internal.credentials).toBeNull();
    expect(client.getSession()).toMatchObject({ status: 'disconnected', sharing: false });
  });

  it('retains a rotated refresh token after a successful refresh', async () => {
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({
        access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600,
        scope: 'openid resource.invoke chatgpt.tokens.use.direct',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/models')) return new Response(JSON.stringify({ models: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = new ChatGptClient('urn:uuid:test', async () => undefined, fetcher as typeof fetch);
    const internal = client as unknown as { credentials: { refreshToken?: string }; state: object };
    internal.credentials = {
      clientId: 'oaiapp_saved', subject: 'subject-1', accessToken: 'old', refreshToken: 'refresh',
      expiresAt: 0, scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
    } as typeof internal.credentials;
    internal.state = { status: 'connected', sharing: true, storage: 'memory-only' };

    await client.listModels();
    expect(internal.credentials.refreshToken).toBe('rotated-refresh');
  });

  it('retains a connected session with a safe model-list diagnostic when discovery fails', async () => {
    const fetcher = async (): Promise<Response> => new Response('', {
      status: 403,
      headers: { 'openai-request-id': 'req_models_123' },
    });
    const client = new ChatGptClient('urn:uuid:test', async () => undefined, fetcher as typeof fetch);
    const internal = client as unknown as { credentials: object; state: object };
    internal.credentials = {
      clientId: 'oaiapp_saved', subject: 'subject-1', accessToken: 'sensitive-access-token', refreshToken: 'sensitive-refresh-token',
      expiresAt: Date.now() + 60_000, scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
    };
    internal.state = { status: 'connected', sharing: true, storage: 'memory-only' };

    const discover = (client as unknown as { discoverModels(): Promise<unknown> }).discoverModels;
    await expect(discover.call(client)).rejects.toThrow();
    const session = client.getSession() as unknown as { status: string; sharing: boolean; error?: { stage: string; requestId?: string } };
    expect(session).toMatchObject({
      status: 'connected', sharing: true,
      error: { stage: 'model-list', requestId: 'req_models_123' },
    });
    expect(JSON.stringify(session)).not.toContain('sensitive-access-token');
  });
});
