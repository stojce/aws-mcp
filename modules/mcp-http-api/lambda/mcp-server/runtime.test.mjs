import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, handleMessage, handleHttpEvent } from './runtime.mjs';

const CLIENT_ID = 'mcp-client-123';
const RESOURCE_URL = 'https://example.cloudfront.net/mcp';
const METADATA_URL = 'https://api.example.com/.well-known/oauth-protected-resource/mcp';
const cfg = {
  clientId: CLIENT_ID,
  requiredScope: 'mcp/read',
  resourceUrl: RESOURCE_URL,
  resourceMetadataUrl: METADATA_URL,
  authorizationServer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example',
  serverInfo: { name: 't', version: '0' },
  tools: [
    {
      name: 'get_my_bookings',
      description: 'bookings',
      inputSchema: { type: 'object', properties: { since: { type: 'string' } }, required: ['since'] },
    },
  ],
};

const goodClaims = {
  sub: 'user-a',
  token_use: 'access',
  client_id: CLIENT_ID,
  aud: RESOURCE_URL,
  scope: 'openid mcp/read',
};

const httpEvent = (claims, body, extra = {}) => ({
  requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims } } },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...extra,
});

test('authorize accepts an MCP-client access token with mcp/read', () => {
  const r = authorize(goodClaims, cfg);
  assert.equal(r.ok, true);
  assert.deepEqual(r.identity, { sub: 'user-a', clientId: CLIENT_ID });
});

test('authorize rejects a token issued to another client (web app)', () => {
  const r = authorize({ ...goodClaims, client_id: 'web-app' }, cfg);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('authorize rejects a token bound to another resource even from the MCP client', () => {
  const r = authorize({ ...goodClaims, aud: 'https://other.example.com/mcp' }, cfg);
  assert.equal(r.status, 401);
});

test('authorize rejects unbound tokens unless legacy compatibility is explicitly enabled', () => {
  const { aud, ...unboundClaims } = goodClaims;
  assert.equal(authorize(unboundClaims, cfg).status, 401);
  assert.equal(authorize(unboundClaims, { ...cfg, allowUnboundAccessTokens: true }).ok, true);
  assert.equal(authorize({ ...goodClaims, aud: 'https://other.example.com' }, {
    ...cfg, allowUnboundAccessTokens: true,
  }).status, 401);
});

test('authorize denies tokens when the canonical resource is not configured', () => {
  assert.equal(authorize(goodClaims, { ...cfg, resourceUrl: undefined }).status, 401);
});

test('authorize rejects an ID token even from the right client', () => {
  const r = authorize({ ...goodClaims, token_use: 'id' }, cfg);
  assert.equal(r.status, 401);
});

test('authorize returns 403 insufficient_scope when mcp/read is missing', () => {
  const r = authorize({ ...goodClaims, scope: 'openid email' }, cfg);
  assert.equal(r.status, 403);
  assert.equal(r.error, 'insufficient_scope');
});

test('authorize does not match a scope that merely contains mcp/read as substring', () => {
  const r = authorize({ ...goodClaims, scope: 'mcp/read-write' }, cfg);
  assert.equal(r.status, 403);
});

test('authorize rejects missing sub', () => {
  const r = authorize({ ...goodClaims, sub: '' }, cfg);
  assert.equal(r.status, 401);
});

test('initialize echoes a supported protocol version and falls back to latest', async () => {
  const ok = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    cfg
  );
  assert.equal(ok.result.protocolVersion, '2025-03-26');
  assert.ok(ok.result.capabilities.tools);

  const fallback = await handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    cfg
  );
  assert.equal(fallback.result.protocolVersion, '2025-06-18');
});

test('notifications get no response body', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, cfg);
  assert.equal(r, null);
});

test('tools/list exposes name, description, inputSchema only', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, cfg);
  assert.deepEqual(Object.keys(r.result.tools[0]).sort(), ['description', 'inputSchema', 'name']);
});

test('unknown method returns -32601', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, cfg);
  assert.equal(r.error.code, -32601);
});

test('tools/call passes verified identity, never client-supplied identity', async () => {
  let seen;
  const r = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_my_bookings', arguments: { since: '2026-01-01', identity: { sub: 'victim' } } },
    },
    {
      ...cfg,
      identity: { sub: 'user-a', clientId: CLIENT_ID },
      invokeTool: async input => {
        seen = input;
        return { bookings: [] };
      },
    }
  );
  assert.equal(seen.identity.sub, 'user-a');
  assert.equal(r.result.isError, false);
  assert.deepEqual(JSON.parse(r.result.content[0].text), { bookings: [] });
});

test('tools/call with missing required argument is a tool error, not a backend call', async () => {
  let called = false;
  const r = await handleMessage(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_my_bookings', arguments: {} } },
    { ...cfg, identity: { sub: 'u' }, invokeTool: async () => ((called = true), {}) }
  );
  assert.equal(called, false);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /missing required argument: since/);
});

test('backend failure returns a generic tool error without leaking internals', async () => {
  const r = await handleMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_my_bookings', arguments: { since: 'x' } } },
    {
      ...cfg,
      identity: { sub: 'u' },
      invokeTool: async () => {
        throw new Error('SQL password=hunter2 at db.internal');
      },
    }
  );
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, 'Tool execution failed');
});

test('tools/call for an unknown tool is an invalid-params error', async () => {
  const r = await handleMessage(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delete_everything' } },
    { ...cfg, identity: { sub: 'u' }, invokeTool: async () => ({}) }
  );
  assert.equal(r.error.code, -32602);
});

test('HTTP: missing authorizer claims yields 401 with WWW-Authenticate', async () => {
  const res = await handleHttpEvent({ requestContext: { http: { method: 'POST' } }, body: '{}' }, cfg);
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'], /invalid_token/);
  assert.ok(res.headers['www-authenticate'].includes(`resource_metadata="${METADATA_URL}"`));
  assert.match(res.headers['www-authenticate'], /scope="mcp\/read"/);
});

test('HTTP: public metadata identifies the canonical resource and Cognito issuer without a token', async () => {
  for (const routeKey of [
    'GET /.well-known/oauth-protected-resource/mcp',
    'GET /.well-known/oauth-protected-resource',
  ]) {
    let called = false;
    const res = await handleHttpEvent({
      routeKey,
      requestContext: { http: { method: 'GET' } },
    }, { ...cfg, invokeTool: async () => { called = true; } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      resource: RESOURCE_URL,
      authorization_servers: [cfg.authorizationServer],
      scopes_supported: ['mcp/read'],
      bearer_methods_supported: ['header'],
    });
    assert.equal(called, false);
  }
});

test('HTTP: public metadata does not make MCP methods public', async () => {
  const res = await handleHttpEvent({
    routeKey: 'ANY /mcp',
    rawPath: '/.well-known/oauth-protected-resource/mcp',
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }, cfg);
  assert.equal(res.statusCode, 401);
});

test('HTTP: insufficient scope yields 403 with scope challenge', async () => {
  const res = await handleHttpEvent(httpEvent({ ...goodClaims, scope: 'openid' }, {}), cfg);
  assert.equal(res.statusCode, 403);
  assert.match(res.headers['www-authenticate'], /scope="mcp\/read"/);
});

test('HTTP: GET is rejected with 405', async () => {
  const res = await handleHttpEvent(
    { requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: goodClaims } } } },
    cfg
  );
  assert.equal(res.statusCode, 405);
});

test('HTTP: malformed JSON yields parse error 400', async () => {
  const res = await handleHttpEvent(httpEvent(goodClaims, '{not json'), cfg);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, -32700);
});

test('HTTP: JSON-RPC batch is rejected', async () => {
  const res = await handleHttpEvent(httpEvent(goodClaims, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]), cfg);
  assert.equal(res.statusCode, 400);
});

test('HTTP: notification returns 202 with empty body', async () => {
  const res = await handleHttpEvent(httpEvent(goodClaims, { jsonrpc: '2.0', method: 'notifications/initialized' }), cfg);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, '');
});

test('HTTP: base64-encoded body is decoded', async () => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })).toString('base64');
  const res = await handleHttpEvent(httpEvent(goodClaims, body, { isBase64Encoded: true }), cfg);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { jsonrpc: '2.0', id: 9, result: {} });
});
