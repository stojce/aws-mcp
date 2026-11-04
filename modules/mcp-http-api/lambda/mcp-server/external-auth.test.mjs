import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, handleHttpEvent } from './runtime.mjs';

const issuer = 'https://identity.example.com/realms/app';
const cfg = {
  authorizationMode: 'external',
  authorizationServer: issuer,
  clientId: 'mcp-client',
  clientIdClaim: 'azp',
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScope: 'bookings:read',
  resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource/mcp',
  serverInfo: { name: 'test', version: '1' },
  tools: [{ name: 'get_bookings', inputSchema: { type: 'object' } }],
};
const claims = {
  iss: issuer, sub: 'external-user', azp: cfg.clientId, aud: cfg.resourceUrl, scope: cfg.requiredScope,
};
const msg = {
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: {
    name: 'get_bookings', arguments: { identity: { sub: 'spoofed' } },
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  },
};
const event = (tokenClaims, scopes) => ({
  headers: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_bookings' },
  body: JSON.stringify(msg),
  requestContext: { http: { method: 'POST' }, authorizer: { jwt: {
    claims: tokenClaims, ...(scopes === undefined ? {} : { scopes }),
  } } },
});

test('external auth: accepts resource-bound JWTs from the configured client without Cognito-only claims', () => {
  assert.deepEqual(authorize(claims, cfg), {
    ok: true, identity: { sub: 'external-user', clientId: 'mcp-client' },
  });
  assert.equal(authorize({ ...claims, client_id: cfg.clientId, azp: 'other-client' }, cfg).status, 401);
  assert.equal(authorize({ ...claims, client_id: cfg.clientId }, { ...cfg, clientIdClaim: 'client_id' }).ok, true);
});

test('external auth: issuer, resource, client, and subject must all match before dispatch', async () => {
  let calls = 0;
  for (const tokenClaims of [
    undefined, { ...claims, iss: undefined }, { ...claims, iss: 'https://other.example.com' },
    { ...claims, azp: undefined }, { ...claims, azp: 'other-client' }, { ...claims, sub: '' },
    { ...claims, sub: ['external-user'] }, { ...claims, aud: undefined },
    { ...claims, aud: cfg.clientId }, { ...claims, aud: 'https://other.example.com/mcp' },
    { ...claims, token_use: 'id' },
  ]) {
    const response = await handleHttpEvent(event(tokenClaims), {
      ...cfg, invokeTool: async () => { calls++; return {}; },
    });
    assert.equal(response.statusCode, 401);
    assert.match(response.headers['www-authenticate'], /error="invalid_token"/);
  }
  assert.equal(calls, 0);
});

test('external auth: legacy unbound-token compatibility cannot weaken audience validation', () => {
  const { aud, ...unbound } = claims;
  assert.equal(authorize(unbound, { ...cfg, allowUnboundAccessTokens: true }).status, 401);
  assert.equal(authorize({ ...claims, aud: ['https://other.example.com', cfg.resourceUrl] }, cfg).ok, true);
  assert.equal(authorize({ ...claims, aud: JSON.stringify([cfg.resourceUrl]) }, cfg).status, 401);
});

test('external auth: optional access-token markers are required and validated when configured', () => {
  const context = { ...cfg, accessTokenClaim: { name: 'kind', value: 'access' } };
  assert.equal(authorize(claims, context).status, 401);
  assert.equal(authorize({ ...claims, kind: 'id' }, context).status, 401);
  assert.equal(authorize({ ...claims, kind: 'access' }, context).ok, true);
  assert.equal(authorize({ ...claims, kind: 'access', token_use: 'id' }, context).status, 401);
  for (const accessTokenClaim of [{}, [], { name: '', value: 'access' }, { name: 'kind', value: '' }]) {
    assert.equal(authorize({ ...claims, kind: 'access' }, { ...cfg, accessTokenClaim }).status, 401);
  }
});

test('external auth: scope/scp checks reject absent, malformed, and substring permissions', () => {
  const { scope, ...withoutScope } = claims;
  for (const value of [undefined, '', 'bookings:reader', 123, [123], { permission: cfg.requiredScope }]) {
    assert.equal(authorize({ ...claims, scope: value }, cfg).status, 403);
  }
  assert.equal(authorize({ ...withoutScope, scp: 'openid ' + cfg.requiredScope }, cfg).ok, true);
  assert.equal(authorize({ ...withoutScope, scp: ['openid', cfg.requiredScope] }, cfg).ok, true);
});

test('external auth: HTTP scope checks use the native authorizer normalized scopes array', async () => {
  let seen;
  const response = await handleHttpEvent(event({ ...claims, scope: undefined, scp: '[bookings:read]' },
    [cfg.requiredScope]), { ...cfg, invokeTool: async input => { seen = input; return { owner: input.identity.sub }; } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, {
    tool: 'get_bookings', arguments: msg.params.arguments, identity: { sub: claims.sub, clientId: claims.azp },
  });
  assert.deepEqual(JSON.parse(response.body).result.structuredContent, { owner: claims.sub });
  for (const scopes of [[], ['bookings:reader'], [123], null]) {
    const response = await handleHttpEvent(event(claims, scopes), {
      ...cfg, invokeTool: async () => { throw new Error('must not invoke'); },
    });
    assert.equal(response.statusCode, 403);
  }
});

test('external auth: protected-resource metadata advertises the configured issuer and scope publicly', async () => {
  const response = await handleHttpEvent({
    routeKey: 'GET /.well-known/oauth-protected-resource/mcp',
    requestContext: { http: { method: 'GET' } },
  }, cfg);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    resource: cfg.resourceUrl, authorization_servers: [issuer],
    scopes_supported: [cfg.requiredScope], bearer_methods_supported: ['header'],
  });
});

test('authorization configuration fails closed and Cognito token/client checks remain mandatory', () => {
  for (const invalid of [
    { clientId: '' }, { requiredScope: '' }, { authorizationMode: 'unknown' },
    { clientIdClaim: '' }, { authorizationServer: undefined },
  ]) assert.equal(authorize(claims, { ...cfg, ...invalid }).status, 401);
  const cognitoClaims = { ...claims, client_id: cfg.clientId, token_use: 'id' };
  assert.equal(authorize(cognitoClaims, {
    ...cfg, authorizationMode: 'cognito', accessTokenClaim: { name: 'scope', value: cfg.requiredScope },
  }).status, 401);
});
