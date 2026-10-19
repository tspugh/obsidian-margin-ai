import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_ENDPOINT,
  DIRECT_SCOPE,
  RESOURCE,
  SCOPES,
  buildAuthorizationUrl,
  buildRefreshBody,
  buildTokenExchangeBody,
  validateAuthorizationCallback,
  validateGrantedScopes,
  type AuthTransaction,
} from '../src/margin-ai/auth-domain';

const transaction: AuthTransaction = {
  state: 'state-value',
  nonce: 'nonce-value',
  verifier: 'verifier-value',
  challenge: 'challenge-value',
  redirectUri: 'http://127.0.0.1:43210/auth/callback',
  requestedClientId: 'dynamic_agent_client',
};

describe('SIWC authorization domain', () => {
  it('builds the documented first-registration authorization URL', () => {
    const url = new URL(buildAuthorizationUrl(transaction, 'urn:uuid:host-id', 'Margin AI'));
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(url.searchParams.get('agent_name_hint')).toBe('Margin AI');
    expect(url.searchParams.get('ext_agent_host_id')).toBe('urn:uuid:host-id');
    expect(url.searchParams.get('redirect_uri')).toBe(transaction.redirectUri);
    expect(url.searchParams.get('scope')).toBe(SCOPES);
    expect(url.searchParams.get('resource')).toBe(RESOURCE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(transaction.state);
    expect(url.searchParams.get('nonce')).toBe(transaction.nonce);
  });

  it('requires an issued client ID and exact state for first registration', () => {
    expect(() => validateAuthorizationCallback(new URL(`${transaction.redirectUri}?code=ok&state=wrong&client_id=oaiapp_1`), transaction)).toThrow(/state/i);
    expect(() => validateAuthorizationCallback(new URL(`${transaction.redirectUri}?code=ok&state=state-value`), transaction)).toThrow(/issued client/i);
    expect(validateAuthorizationCallback(new URL(`${transaction.redirectUri}?code=ok&state=state-value&client_id=oaiapp_1`), transaction)).toEqual({ code: 'ok', clientId: 'oaiapp_1' });
  });

  it('rejects a changed client ID for returning sign-in', () => {
    const returning = { ...transaction, requestedClientId: 'oaiapp_saved' };
    expect(() => validateAuthorizationCallback(new URL(`${transaction.redirectUri}?code=ok&state=state-value&client_id=oaiapp_other`), returning)).toThrow(/client/i);
  });

  it('treats access_denied as cancellation before any token exchange', () => {
    expect(() => validateAuthorizationCallback(new URL(`${transaction.redirectUri}?error=access_denied&state=state-value`), transaction)).toThrow(/cancelled/i);
  });

  it('builds token and refresh bodies without a secret or API key', () => {
    const exchange = buildTokenExchangeBody(transaction, 'oaiapp_issued', 'auth-code');
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('client_id')).toBe('oaiapp_issued');
    expect(exchange.get('code_verifier')).toBe(transaction.verifier);
    expect(exchange.get('resource')).toBe(RESOURCE);
    expect(exchange.has('client_secret')).toBe(false);
    const refresh = buildRefreshBody('oaiapp_issued', 'refresh-token');
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('scope')).toBeNull();
    expect(refresh.get('resource')).toBe(RESOURCE);
  });

  it('requires direct ChatGPT plan permission in the granted scopes', () => {
    expect(() => validateGrantedScopes('openid email')).toThrow(DIRECT_SCOPE);
    expect(() => validateGrantedScopes(`openid ${DIRECT_SCOPE}`)).toThrow('resource.invoke');
    expect(validateGrantedScopes(`openid ${DIRECT_SCOPE} resource.invoke`)).toContain(DIRECT_SCOPE);
  });
});
