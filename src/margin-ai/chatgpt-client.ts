import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import {
	ISSUER,
	JWKS_ENDPOINT,
	RESOURCE,
	TOKEN_ENDPOINT,
	buildAuthorizationUrl,
	buildRefreshBody,
	buildTokenExchangeBody,
	validateAuthorizationCallback,
	validateGrantedScopes,
	AuthorizationError,
	type AuthTransaction,
} from './auth-domain';
import { consumeResponseEvents, parseSse } from './response-stream';
import { openAiNodeFetch } from './node-fetch';

const RESPONSES_ENDPOINT = `${RESOURCE}/responses`;
const MODELS_ENDPOINT = `${RESOURCE}/models`;
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/auth/callback';

export interface ChatGptModel {
	slug: string;
	displayName: string;
}

export type AuthStage =
	| 'callback-server'
	| 'browser-consent'
	| 'callback-validation'
	| 'code-exchange'
	| 'identity-verification'
	| 'scope-validation'
	| 'model-list';

export interface SafeAuthDiagnostic {
	stage: AuthStage;
	summary: string;
	code?: string;
	requestId?: string;
}

export interface SafeChatGptSession {
	status: 'disconnected' | 'connecting' | 'connected';
	sharing: boolean;
	email?: string;
	name?: string;
	storage: 'memory-only';
	stage?: AuthStage;
	error?: SafeAuthDiagnostic;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	id_token: string;
	token_type?: string;
	expires_in: number;
	scope: string;
}

interface SessionCredentials {
	clientId: string;
	subject: string;
	email?: string;
	name?: string;
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	scopes: string[];
}

export interface ConversationInput {
	role: 'user' | 'assistant';
	content: string | Array<
		| { type: 'input_text'; text: string }
		| { type: 'input_image'; image_url: string; detail: 'auto' }
	>;
}

type SignInServerFactory = (handler: (request: IncomingMessage, response: ServerResponse) => void) => Server;

class OpenAiHttpError extends Error {
	constructor(readonly status: number, readonly requestId?: string, readonly providerCode?: string) {
		super(`OpenAI request failed (${status}).`);
		this.name = 'OpenAiHttpError';
	}
}

function randomValue(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

function safeIdentifier(value: unknown): string | undefined {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined;
}

async function responseError(response: Response): Promise<OpenAiHttpError> {
	const requestId = safeIdentifier(response.headers.get('openai-request-id') ?? response.headers.get('x-request-id'));
	let providerCode: string | undefined;
	try {
		const body = await response.json() as unknown;
		if (body && typeof body === 'object') {
			const outer = body as Record<string, unknown>;
			providerCode = safeIdentifier(typeof outer.error === 'string'
				? outer.error
				: outer.error && typeof outer.error === 'object'
					? (outer.error as Record<string, unknown>).code
					: outer.code);
		}
	} catch {
		// Response bodies are never exposed; a missing/invalid body falls back to HTTP status.
	}
	return new OpenAiHttpError(response.status, requestId, providerCode);
}

function safeDiagnostic(stage: AuthStage, error: unknown): SafeAuthDiagnostic {
	const code = safeIdentifier(error instanceof Error && 'code' in error ? error.code : undefined);
	if (error instanceof OpenAiHttpError) {
		const knownSummary: Record<string, string> = {
			invalid_client: 'OpenAI rejected this app registration. Start sign-in again.',
			invalid_grant: 'OpenAI did not accept the authorization grant. Start sign-in again.',
			access_denied: 'OpenAI did not grant subscription sharing for this sign-in.',
		};
		return {
			stage,
			summary: (error.providerCode && knownSummary[error.providerCode]) ?? (stage === 'model-list'
				? `OpenAI rejected model discovery (HTTP ${error.status}).`
				: `OpenAI rejected the authorization exchange (HTTP ${error.status}).`),
			code: error.providerCode ?? `http_${error.status}`,
			requestId: error.requestId,
		};
	}
	if (error instanceof AuthorizationError) {
		return { stage, summary: error.message, code: safeIdentifier(error.code) };
	}
	const summaries: Record<AuthStage, string> = {
		'callback-server': 'Could not start the private local sign-in callback.',
		'browser-consent': 'Could not open or finish browser consent.',
		'callback-validation': 'The browser callback could not be validated.',
		'code-exchange': 'Could not exchange the authorization code with OpenAI.',
		'identity-verification': 'OpenAI identity verification failed.',
		'scope-validation': 'Required ChatGPT subscription-sharing permission was not granted.',
		'model-list': 'Could not load the available ChatGPT models.',
	};
	return { stage, summary: summaries[stage], code };
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			yield decoder.decode(value, { stream: true });
		}
		const final = decoder.decode();
		if (final) yield final;
	} finally {
		reader.releaseLock();
	}
}

export class ChatGptClient {
	private credentials: SessionCredentials | null = null;
	private state: SafeChatGptSession = { status: 'disconnected', sharing: false, storage: 'memory-only' };
	private signInServer: Server | null = null;
	private pendingSignInReject: ((error: Error) => void) | null = null;
	private refreshPromise: Promise<void> | null = null;
	private sessionGeneration = 0;
	private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
	private readonly subscribers = new Set<(session: SafeChatGptSession) => void>();

	constructor(
		private readonly hostId: string,
		private readonly openExternal: (url: string) => Promise<void>,
		private readonly fetcher: typeof fetch = openAiNodeFetch as typeof fetch,
		private readonly serverFactory: SignInServerFactory = createServer,
	) {
		this.jwks = createRemoteJWKSet(new URL(JWKS_ENDPOINT), { [customFetch]: this.fetcher });
	}

	getSession(): SafeChatGptSession {
		return { ...this.state };
	}

	subscribe(listener: (session: SafeChatGptSession) => void): () => void {
		this.subscribers.add(listener);
		listener(this.getSession());
		return () => this.subscribers.delete(listener);
	}

	private publish(session: SafeChatGptSession): void {
		this.state = session;
		for (const listener of this.subscribers) listener(this.getSession());
	}

	private publishStage(stage: AuthStage): void {
		this.publish({ ...this.state, status: 'connecting', stage, error: undefined });
	}

	private async exchange(transaction: AuthTransaction, clientId: string, code: string): Promise<TokenResponse> {
		const response = await this.fetcher(TOKEN_ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: buildTokenExchangeBody(transaction, clientId, code),
		});
		if (!response.ok) throw await responseError(response);
		const value = await response.json() as Partial<TokenResponse>;
		if (!value.access_token || !value.id_token || typeof value.expires_in !== 'number' || !value.scope) {
			throw new Error('OpenAI returned an incomplete token response.');
		}
		return value as TokenResponse;
	}

	private async verifyIdentity(idToken: string, clientId: string, nonce?: string): Promise<JWTPayload> {
		const { payload } = await jwtVerify(idToken, this.jwks, {
			issuer: ISSUER,
			audience: clientId,
			requiredClaims: ['sub', 'exp', 'iat'],
			clockTolerance: 5,
		});
		if (nonce !== undefined && payload.nonce !== nonce) throw new Error('The OpenAI identity nonce did not match.');
		if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('The OpenAI identity did not contain a subject.');
		return payload;
	}

	async signIn(): Promise<SafeChatGptSession> {
		if (this.signInServer) throw new Error('A ChatGPT sign-in is already in progress.');
		const previous = this.credentials;
		const generation = ++this.sessionGeneration;
		let stage: AuthStage = 'callback-server';
		const moveTo = (next: AuthStage) => {
			stage = next;
			this.publishStage(next);
		};
		moveTo(stage);
		const requestedClientId = previous?.clientId ?? 'dynamic_agent_client';
		const verifier = randomValue(64);
		const transactionBase = {
			state: randomValue(),
			nonce: randomValue(),
			verifier,
			challenge: createHash('sha256').update(verifier).digest('base64url'),
			requestedClientId,
		};
		let callbackPage: { complete(success: boolean): void } | null = null;

		try {
			const callback = await new Promise<{
				result: ReturnType<typeof validateAuthorizationCallback>;
				transaction: AuthTransaction;
				complete(success: boolean): void;
			}>((resolve, reject) => {
				let transaction!: AuthTransaction;
				let settled = false;
				const closePage = (response: ServerResponse, success: boolean) => {
					if (!response.writableEnded) {
						response.writeHead(success ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
						response.end(success
							? '<!doctype html><title>Margin AI</title><p>Sign in complete. You can return to Obsidian.</p>'
							: '<!doctype html><title>Margin AI</title><p>Sign in was not completed. Return to Obsidian for details.</p>');
					}
					server.close();
				};
				const failBeforeCallback = (error: unknown, response?: ServerResponse) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					this.pendingSignInReject = null;
					if (response) closePage(response, false);
					else server.close();
					reject(error);
				};
				const server = this.serverFactory((request, response) => {
					try {
						const url = new URL(request.url ?? '/', transaction.redirectUri);
						if (url.pathname !== CALLBACK_PATH) {
							response.writeHead(404).end();
							return;
						}
						moveTo('callback-validation');
						const result = validateAuthorizationCallback(url, transaction);
						if (settled) return;
						settled = true;
						clearTimeout(timeout);
						let pageCompleted = false;
						const complete = (success: boolean) => {
							if (pageCompleted) return;
							pageCompleted = true;
							this.pendingSignInReject = null;
							closePage(response, success);
						};
						this.pendingSignInReject = () => complete(false);
						resolve({ result, transaction, complete });
					} catch (error) {
						failBeforeCallback(error, response);
					}
				});
				const timeout = setTimeout(() => failBeforeCallback(new Error('ChatGPT sign-in timed out.')), 10 * 60 * 1000);
				this.pendingSignInReject = (error) => failBeforeCallback(error);
				this.signInServer = server;
				server.once('error', (error) => failBeforeCallback(error));
				server.listen(0, CALLBACK_HOST, async () => {
					const address = server.address();
					if (!address || typeof address === 'string') {
						failBeforeCallback(new Error('Could not start the local sign-in callback.'));
						return;
					}
					transaction = {
						...transactionBase,
						redirectUri: `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`,
					};
					try {
						moveTo('browser-consent');
						await this.openExternal(buildAuthorizationUrl(transaction, this.hostId, 'Margin AI'));
					} catch (error) {
						failBeforeCallback(error);
					}
				});
			});
			callbackPage = callback;

			moveTo('code-exchange');
			const tokens = await this.exchange(callback.transaction, callback.result.clientId, callback.result.code);
			moveTo('identity-verification');
			const identity = await this.verifyIdentity(tokens.id_token, callback.result.clientId, callback.transaction.nonce);
			moveTo('scope-validation');
			const scopes = validateGrantedScopes(tokens.scope);
			if (previous && previous.subject !== identity.sub) throw new Error('The selected ChatGPT account did not match the active connection.');
			if (generation !== this.sessionGeneration) throw new Error('ChatGPT sign-in was cancelled.');
			this.credentials = {
				clientId: callback.result.clientId,
				subject: identity.sub!,
				email: typeof identity.email === 'string' ? identity.email : undefined,
				name: typeof identity.name === 'string' ? identity.name : undefined,
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				expiresAt: Date.now() + tokens.expires_in * 1000,
				scopes,
			};
			const session: SafeChatGptSession = {
				status: 'connected', sharing: true, storage: 'memory-only',
				email: this.credentials.email, name: this.credentials.name,
			};
			this.publish(session);
			callback.complete(true);
			return session;
		} catch (error) {
			callbackPage?.complete(false);
			if (generation === this.sessionGeneration) {
				this.credentials = previous;
				const diagnostic = safeDiagnostic(stage, error);
				this.publish(previous ? {
					status: 'connected', sharing: true, storage: 'memory-only', email: previous.email, name: previous.name,
					error: diagnostic,
				} : { status: 'disconnected', sharing: false, storage: 'memory-only', error: diagnostic });
				throw new Error(diagnostic.summary);
			}
			throw new Error('ChatGPT sign-in was cancelled.');
		} finally {
			this.signInServer = null;
		}
	}

	cancelSignIn(): void {
		this.sessionGeneration++;
		this.pendingSignInReject?.(new Error('ChatGPT sign-in was cancelled.'));
		this.pendingSignInReject = null;
		this.signInServer?.close();
		this.signInServer = null;
		this.publish(this.credentials ? {
			status: 'connected', sharing: true, storage: 'memory-only', email: this.credentials.email, name: this.credentials.name,
		} : { status: 'disconnected', sharing: false, storage: 'memory-only' });
	}

	private async refreshIfNeeded(): Promise<void> {
		if (!this.credentials) throw new Error('Connect ChatGPT before using AI.');
		if (this.credentials.expiresAt > Date.now() + 60_000) return;
		if (!this.credentials.refreshToken) throw new Error('The ChatGPT session expired. Sign in again.');
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = (async () => {
			const current = this.credentials!;
			const generation = this.sessionGeneration;
			const response = await this.fetcher(TOKEN_ENDPOINT, {
				method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: buildRefreshBody(current.clientId, current.refreshToken!),
			});
			if (!response.ok) throw await responseError(response);
			const tokens = await response.json() as Partial<TokenResponse>;
			if (!tokens.access_token || typeof tokens.expires_in !== 'number') throw new Error('OpenAI returned an incomplete refresh response.');
			if (tokens.id_token) {
				const identity = await this.verifyIdentity(tokens.id_token, current.clientId);
				if (identity.sub !== current.subject) throw new Error('The refreshed ChatGPT identity did not match the active connection.');
			}
			if (generation !== this.sessionGeneration || this.credentials !== current) return;
			this.credentials = {
				...current,
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token ?? current.refreshToken,
				expiresAt: Date.now() + tokens.expires_in * 1000,
				scopes: tokens.scope ? validateGrantedScopes(tokens.scope) : current.scopes,
			};
		})().finally(() => { this.refreshPromise = null; });
		return this.refreshPromise;
	}

	private async bearer(): Promise<string> {
		await this.refreshIfNeeded();
		return this.credentials!.accessToken;
	}

	async listModels(signal?: AbortSignal): Promise<ChatGptModel[]> {
		const response = await this.fetcher(MODELS_ENDPOINT, {
			headers: { authorization: `Bearer ${await this.bearer()}` }, signal,
		});
		if (!response.ok) throw await responseError(response);
		const value = await response.json() as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
		return (value.models ?? [])
			.filter((model) => model.visibility === 'list' && model.slug && model.display_name)
			.map((model) => ({ slug: model.slug!, displayName: model.display_name! }));
	}

	async discoverModels(signal?: AbortSignal): Promise<ChatGptModel[]> {
		this.publish({ ...this.state, status: 'connected', sharing: true, stage: 'model-list', error: undefined });
		try {
			const models = await this.listModels(signal);
			this.publish({ ...this.state, status: 'connected', sharing: true, stage: undefined, error: undefined });
			return models;
		} catch (error) {
			const diagnostic = safeDiagnostic('model-list', error);
			this.publish({ ...this.state, status: 'connected', sharing: true, stage: undefined, error: diagnostic });
			throw new Error(diagnostic.summary);
		}
	}

	async respond(model: string, input: ConversationInput[], instructions: string, signal?: AbortSignal, onDelta?: (delta: string) => void): Promise<string> {
		const response = await this.fetcher(RESPONSES_ENDPOINT, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await this.bearer()}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model, input, instructions, store: false, stream: true }),
			signal,
		});
		if (!response.ok) throw await responseError(response);
		if (!response.body) throw new Error('OpenAI returned an empty response stream.');
		return consumeResponseEvents(parseSse(responseChunks(response.body)), onDelta);
	}

	async disconnect(): Promise<{ revocationConfirmed: boolean }> {
		this.sessionGeneration++;
		this.pendingSignInReject?.(new Error('ChatGPT sign-in was cancelled by sign out.'));
		this.pendingSignInReject = null;
		this.signInServer?.close();
		this.signInServer = null;
		const credentials = this.credentials;
		this.credentials = null;
		this.publish({ status: 'disconnected', sharing: false, storage: 'memory-only' });
		if (!credentials?.refreshToken) return { revocationConfirmed: false };
		try {
			const discovery = await this.fetcher(`${ISSUER}/.well-known/openid-configuration`);
			if (!discovery.ok) return { revocationConfirmed: false };
			const { revocation_endpoint: endpoint } = await discovery.json() as { revocation_endpoint?: string };
			if (!endpoint || new URL(endpoint).origin !== ISSUER || new URL(endpoint).protocol !== 'https:') return { revocationConfirmed: false };
			const response = await this.fetcher(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					token: credentials.refreshToken,
					token_type_hint: 'refresh_token',
					client_id: credentials.clientId,
				}),
			});
			return { revocationConfirmed: response.status === 200 };
		} catch {
			return { revocationConfirmed: false };
		}
	}
}
