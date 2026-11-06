import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleHttpEvent } from './runtime.mjs';

const issuer = 'https://example.cloudfront.net';
const metadata = {
  issuer,
  authorization_endpoint: 'https://example.auth.eu-west-1.amazoncognito.com/oauth2/authorize',
  token_endpoint: 'https://example.auth.eu-west-1.amazoncognito.com/oauth2/token',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: false,
  scopes_supported: ['openid', 'email', `${issuer}/mcp/read`],
};
const cfg = {
  resourceUrl: `${issuer}/mcp`,
  authorizationServer: issuer,
  authorizationServerMetadata: metadata,
  requiredScope: `${issuer}/mcp/read`,
  clientId: 'mcp-client',
  allowedOrigins: ['https://mcptest.io'],
  tools: [],
  invokeTool: () => assert.fail('Discovery must not invoke tools'),
};
const event = (path, headers = {}) => ({
  routeKey: `GET ${path}`,
  requestContext: { http: { method: 'GET' } },
  headers,
});

test('public discovery leads to the metadata issuer and public Cognito endpoints without login', async () => {
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await handleHttpEvent(event(path), cfg);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body).authorization_servers, [issuer]);
  }
  const response = await handleHttpEvent(event('/.well-known/oauth-authorization-server', { origin: cfg.allowedOrigins[0] }), cfg);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), metadata);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], cfg.allowedOrigins[0]);
});

test('proxy discovery is absent when disabled and respects the browser origin policy', async () => {
  const path = '/.well-known/oauth-authorization-server';
  const disabled = await handleHttpEvent(event(path), { ...cfg, authorizationServerMetadata: null });
  assert.equal(disabled.statusCode, 404);
  const denied = await handleHttpEvent(event(path, { origin: 'https://untrusted.example' }), cfg);
  assert.equal(denied.statusCode, 403);
});

test('strict clients discover S256 with public Cognito endpoints under a matching metadata issuer', async () => {
  const publicMetadata = {
    ...metadata,
    authorization_endpoint: 'https://configured.auth.eu-west-1.amazoncognito.com/oauth2/authorize',
    token_endpoint: 'https://configured.auth.eu-west-1.amazoncognito.com/oauth2/token',
  };
  const publicConfig = { ...cfg, authorizationServerMetadata: publicMetadata };
  const resourceResponse = await handleHttpEvent(event('/.well-known/oauth-protected-resource/mcp'), publicConfig);
  const authorizationServer = JSON.parse(resourceResponse.body).authorization_servers[0];
  const discoveryUrl = new URL('/.well-known/oauth-authorization-server', authorizationServer);
  const response = await handleHttpEvent(event(discoveryUrl.pathname), publicConfig);
  assert.equal(response.statusCode, 200);
  const discovered = JSON.parse(response.body);
  assert.equal(discovered.issuer, authorizationServer);
  assert.ok(discovered.code_challenge_methods_supported.includes('S256'),
    'Incompatible authorization server: validated metadata does not advertise PKCE S256 support.');
  assert.equal(discovered.authorization_endpoint, publicMetadata.authorization_endpoint);
  assert.equal(discovered.token_endpoint, publicMetadata.token_endpoint);
  assert.deepEqual(discovered.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(discovered.client_id_metadata_document_supported, false);
  assert.equal(Object.hasOwn(discovered, 'registration_endpoint'), false);
});

test('proxy discovery does not make MCP calls or other paths public', async () => {
  for (const path of ['/mcp', '/authorize', '/token', '/.well-known/openid-configuration']) {
    const response = await handleHttpEvent(event(path), cfg);
    assert.equal(response.statusCode, 401);
  }
});
