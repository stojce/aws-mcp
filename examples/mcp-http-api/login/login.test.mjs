import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createLoginServer, inspectorConfiguration } from './server.mjs';
import { beginLogin, consumeCallback, checkNonce } from './oauth.mjs';

const config = {
  baseUrl: 'http://localhost:8080',
  mcpUrl: 'https://example.cloudfront.net/mcp',
  clientId: 'example-client',
  scope: 'https://example.cloudfront.net/mcp/read',
  issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/example-pool',
  authorizationEndpoint: 'https://example.auth.eu-west-1.amazoncognito.com/oauth2/authorize',
  tokenEndpoint: 'https://example.auth.eu-west-1.amazoncognito.com/oauth2/token',
  callbackUrls: ['http://localhost:8080/callback', 'http://localhost:6274/oauth/callback'],
};

function authorization(overrides = {}) {
  return new URLSearchParams({
    client_id: config.clientId, response_type: 'code',
    redirect_uri: config.callbackUrls[1], scope: `openid email ${config.scope}`,
    state: 'inspector-state', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256',
    ...overrides,
  });
}

async function startServer(t) {
  const calls = [];
  const server = createLoginServer(config, {
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ access_token: 'access-token', refresh_token: `rotated-${calls.length}`, token_type: 'Bearer' });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${server.address().port}${path}`, {
      method: options.method ?? 'GET', headers: { Host: 'localhost:8080', ...options.headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, {
        status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined)),
      })));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
  return { request, calls };
}

test('Inspector login preserves its callback, state, and PKCE and binds the Cognito resource', async (t) => {
  const { request, calls } = await startServer(t);
  const params = authorization();
  const page = await request(`/authorize?${params}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Continue to Cognito/);
  const response = await request(`/cognito/authorize?${params}`);
  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get('location'));
  assert.equal(destination.origin + destination.pathname, config.authorizationEndpoint);
  for (const [name, value] of params) assert.equal(destination.searchParams.get(name), value);
  assert.equal(destination.searchParams.get('resource'), config.mcpUrl);
  assert.equal(calls.length, 0);
});

test('login rejects unregistered callbacks, other clients, missing PKCE, and resource or scope substitutions', async (t) => {
  const { request, calls } = await startServer(t);
  for (const overrides of [
    { redirect_uri: 'https://attacker.example/callback' }, { client_id: 'other-client' },
    { code_challenge_method: 'plain' }, { code_challenge: '' }, { state: '' },
    { response_type: 'token' }, { resource: 'https://other.example/mcp' }, { scope: 'openid email' },
  ]) {
    const response = await request(`/cognito/authorize?${authorization(overrides)}`);
    assert.equal(response.status, 400, JSON.stringify(overrides));
    assert.equal(response.headers.get('location'), null);
  }
  const duplicate = authorization();
  duplicate.append('redirect_uri', 'https://attacker.example/callback');
  assert.equal((await request(`/cognito/authorize?${duplicate}`)).status, 400);
  assert.equal(calls.length, 0);
});

test('token exchange forwards PKCE and resource, and returns the rotated refresh token', async (t) => {
  const { request, calls } = await startServer(t);
  const params = new URLSearchParams({
    grant_type: 'authorization_code', client_id: config.clientId,
    redirect_uri: config.callbackUrls[1], code: 'one-time-code', code_verifier: 'v'.repeat(43),
  });
  const response = await request('/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost:6274' }, body: params.toString(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:6274');
  assert.equal((await response.json()).refresh_token, 'rotated-1');
  assert.equal(calls[0].url, config.tokenEndpoint);
  const forwarded = new URLSearchParams(calls[0].options.body);
  for (const [name, value] of params) assert.equal(forwarded.get(name), value);
  assert.equal(forwarded.get('resource'), config.mcpUrl);
  assert.equal(calls[0].options.redirect, 'error');

  const refreshed = await request('/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: 'rotated-1' }).toString(),
  });
  assert.equal((await refreshed.json()).refresh_token, 'rotated-2');
  assert.equal(new URLSearchParams(calls[1].options.body).get('resource'), config.mcpUrl);
});

test('token endpoint blocks password grants, callback or client changes, and requests from other origins', async (t) => {
  const { request, calls } = await startServer(t);
  const original = {
    grant_type: 'authorization_code', client_id: config.clientId,
    redirect_uri: config.callbackUrls[1], code: 'code', code_verifier: 'v'.repeat(43),
  };
  for (const overrides of [
    { grant_type: 'password' }, { client_id: 'other-client' }, { code_verifier: '' },
    { redirect_uri: 'https://attacker.example/callback' }, { resource: 'https://other.example' },
    { client_secret: 'not-a-public-client' },
  ]) {
    const response = await request('/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...original, ...overrides }).toString(),
    });
    assert.equal(response.status, 400, JSON.stringify(overrides));
  }
  assert.equal((await request('/config.json', { headers: { Origin: 'https://attacker.example' } })).status, 400);
  assert.equal((await request('/config.json', { headers: { Host: 'attacker.example' } })).status, 400);
  assert.equal(calls.length, 0);
});

test('Inspector token preflight is allowed only for the configured origin and headers', async (t) => {
  const { request } = await startServer(t);
  const headers = { Origin: 'http://localhost:6274', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' };
  const response = await request('/token', { method: 'OPTIONS', headers });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), headers.Origin);
  assert.equal((await request('/token', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Headers': 'authorization' } })).status, 400);
});

test('generated Inspector settings use the real MCP URL and local OAuth endpoints without a client secret', () => {
  const server = inspectorConfiguration(config, config.baseUrl).mcpServers['bookings-mcp'];
  assert.equal(server.url, config.mcpUrl);
  assert.equal(server.oauth.authorizationUrl, 'http://localhost:8080/authorize');
  assert.equal(server.oauth.tokenUrl, 'http://localhost:8080/token');
  assert.equal(server.oauth.clientId, config.clientId);
  assert.equal(server.oauth.clientSecret, undefined);
  assert.equal(server.oauth.requestRefreshToken, false);
});

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('standalone login uses a fresh random state and a matching S256 PKCE verifier', async () => {
  const saved = storage();
  const request = new URL(await beginLogin(config, saved));
  const result = consumeCallback(new URLSearchParams({ code: 'code', state: request.searchParams.get('state'), iss: config.issuer }), saved);
  assert.equal(createHash('sha256').update(result.verifier).digest('base64url'), request.searchParams.get('code_challenge'));
  assert.equal(request.searchParams.get('resource'), config.mcpUrl);
  assert.equal(result.redirectUri, config.callbackUrls[0]);
  assert.equal(result.nonce, request.searchParams.get('nonce'));
  const next = new URL(await beginLogin(config, storage()));
  assert.notEqual(next.searchParams.get('state'), request.searchParams.get('state'));
});

test('standalone OIDC login requires the nonce returned by the trusted Cognito token endpoint', () => {
  const token = `header.${Buffer.from(JSON.stringify({ nonce: 'expected-nonce' })).toString('base64url')}.signature`;
  assert.doesNotThrow(() => checkNonce(token, 'expected-nonce'));
  assert.throws(() => checkNonce(token, 'other-nonce'), /nonce/);
  assert.throws(() => checkNonce(undefined, 'expected-nonce'), /nonce/);
  assert.throws(() => checkNonce('malformed', 'expected-nonce'), /nonce/);
});

test('callbacks reject missing, mismatched, duplicated, expired, or replayed state and an unexpected issuer', async () => {
  for (const overrides of [{ state: 'other' }, { iss: 'https://attacker.example' }, { code: '' }, { error: 'access_denied' }]) {
    const saved = storage();
    const request = new URL(await beginLogin(config, saved));
    const params = new URLSearchParams({ code: 'code', state: request.searchParams.get('state'), ...overrides });
    assert.throws(() => consumeCallback(params, saved));
    assert.throws(() => consumeCallback(params, saved));
  }
  const saved = storage();
  const request = new URL(await beginLogin(config, saved));
  const params = new URLSearchParams({ code: 'code', state: request.searchParams.get('state') });
  assert.throws(() => consumeCallback(params, saved, Date.now() + 11 * 60 * 1000), /expired/);
  const duplicateStorage = storage();
  const duplicateRequest = new URL(await beginLogin(config, duplicateStorage));
  const duplicates = new URLSearchParams({ code: 'code', state: duplicateRequest.searchParams.get('state') });
  duplicates.append('state', duplicateRequest.searchParams.get('state'));
  assert.throws(() => consumeCallback(duplicates, duplicateStorage));
  assert.throws(() => consumeCallback(new URLSearchParams({ code: 'code', state: 'unknown' }), storage()));
});
