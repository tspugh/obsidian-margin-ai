export const AUTHORIZATION_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
export const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
export const JWKS_ENDPOINT = 'https://auth.openai.com/.well-known/jwks.json';
export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
export const INVOKE_SCOPE = 'resource.invoke';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export interface AuthTransaction {
	state: string;
	nonce: string;
	verifier: string;
	challenge: string;
	redirectUri: string;
	requestedClientId: string;
}

export interface AuthorizationResult {
	code: string;
	clientId: string;
}

export class AuthorizationError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'AuthorizationError';
	}
}

export function buildAuthorizationUrl(transaction: AuthTransaction, hostId: string, agentName: string): string {
	const url = new URL(AUTHORIZATION_ENDPOINT);
	const parameters: Record<string, string> = {
		client_id: transaction.requestedClientId,
		ext_agent_host_id: hostId,
		response_type: 'code',
		redirect_uri: transaction.redirectUri,
		scope: SCOPES,
		resource: RESOURCE,
		state: transaction.state,
		nonce: transaction.nonce,
		code_challenge_method: 'S256',
		code_challenge: transaction.challenge,
	};
	if (transaction.requestedClientId === 'dynamic_agent_client') parameters.agent_name_hint = agentName;
	url.search = new URLSearchParams(parameters).toString();
	return url.toString();
}

export function validateAuthorizationCallback(url: URL, transaction: AuthTransaction): AuthorizationResult {
	const state = url.searchParams.get('state');
	if (!state || state !== transaction.state) throw new AuthorizationError('state_mismatch', 'The sign-in state did not match. No session was changed.');
	const error = url.searchParams.get('error');
	if (error) {
		if (error === 'access_denied') throw new AuthorizationError('cancelled', 'Sign in was cancelled.');
		throw new AuthorizationError(error, 'OpenAI did not complete sign in.');
	}
	const code = url.searchParams.get('code');
	if (!code) throw new AuthorizationError('missing_code', 'The sign-in callback did not contain an authorization code.');
	const returnedClientId = url.searchParams.get('client_id');
	if (transaction.requestedClientId === 'dynamic_agent_client') {
		if (!returnedClientId || returnedClientId === 'dynamic_agent_client') {
			throw new AuthorizationError('missing_client_id', 'The sign-in callback did not contain an issued client ID.');
		}
		return { code, clientId: returnedClientId };
	}
	if (returnedClientId && returnedClientId !== transaction.requestedClientId) {
		throw new AuthorizationError('client_mismatch', 'The sign-in callback returned a different client registration.');
	}
	return { code, clientId: transaction.requestedClientId };
}

export function buildTokenExchangeBody(transaction: AuthTransaction, issuedClientId: string, code: string): URLSearchParams {
	return new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: issuedClientId,
		code,
		code_verifier: transaction.verifier,
		redirect_uri: transaction.redirectUri,
		resource: RESOURCE,
	});
}

export function buildRefreshBody(issuedClientId: string, refreshToken: string): URLSearchParams {
	return new URLSearchParams({
		grant_type: 'refresh_token',
		client_id: issuedClientId,
		refresh_token: refreshToken,
		resource: RESOURCE,
	});
}

export function validateGrantedScopes(scope: string | string[]): string[] {
	const scopes = Array.isArray(scope) ? scope : scope.split(/\s+/).filter(Boolean);
	if (!scopes.includes(DIRECT_SCOPE)) {
		throw new AuthorizationError('sharing_not_granted', `The ${DIRECT_SCOPE} permission was not granted.`);
	}
	if (!scopes.includes(INVOKE_SCOPE)) {
		throw new AuthorizationError('sharing_not_granted', `The ${INVOKE_SCOPE} permission was not granted.`);
	}
	return scopes;
}
