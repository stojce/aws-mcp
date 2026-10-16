const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { handler } = require('./index.js');

const SECRET = 'test-signing-secret';
process.env.MCP_CLAIMS_SIGNING_SECRET = SECRET;

const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

const makeEvent = (claims, extra = {}) => ({
  mcp: {
    gatewayRequest: {
      path: '/mcp',
      httpMethod: 'POST',
      headers: claims === null ? {} : { Authorization: `Bearer x.${b64url(claims)}.y` },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    },
  },
  ...extra,
});

const fullClaims = {
  sub: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'custom:user_id': '421',
  'custom:role': 'customer',
  'custom:provider_id': '17',
  email: 'user@example.com',
  email_verified: 'true',
};

test('injects signed x-mcp-claims header + unchanged body on success', async () => {
  const out = await handler(makeEvent(fullClaims));
  assert.strictEqual(out.interceptorOutputVersion, '1.0');
  const transformed = out.mcp.transformedGatewayRequest;

  const claims = JSON.parse(transformed.headers['x-mcp-claims']);
  assert.strictEqual(claims.userId, '421');
  assert.strictEqual(claims.userRole, 'customer');
  assert.strictEqual(claims.providerId, '17');
  assert.strictEqual(claims.isAnonymous, false);
  assert.strictEqual(claims.sub, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  // exact selected-field set: userId, userRole, providerId, isAnonymous, sub, email
  assert.deepStrictEqual(Object.keys(claims).sort(), ['email', 'isAnonymous', 'providerId', 'sub', 'userId', 'userRole']);

  // signature verifies with the shared secret
  const expected = crypto.createHmac('sha256', SECRET).update(JSON.stringify(claims)).digest('base64url');
  assert.strictEqual(transformed.headers['x-mcp-claims-sig'], expected);

  // body passes through untouched
  assert.deepStrictEqual(transformed.body, { jsonrpc: '2.0', id: 1, method: 'tools/call' });
});

test('isAnonymous string-true normalizes to boolean true', async () => {
  const out = await handler(makeEvent({ ...fullClaims, 'custom:is_anonymous': 'true' }));
  const claims = JSON.parse(out.mcp.transformedGatewayRequest.headers['x-mcp-claims']);
  assert.strictEqual(claims.isAnonymous, true);
});

test('standard claim names (userId, userRole, providerId) also resolve', async () => {
  const out = await handler(makeEvent({ sub: 's1', userId: 99, userRole: 'customer', providerId: 3 }));
  const claims = JSON.parse(out.mcp.transformedGatewayRequest.headers['x-mcp-claims']);
  assert.strictEqual(claims.userId, 99);
  assert.strictEqual(claims.providerId, 3);
});

test('denies (short-circuit 401) when no bearer token', async () => {
  const out = await handler(makeEvent(null));
  const resp = out.mcp.transformedGatewayResponse;
  assert.strictEqual(resp.statusCode, 401);
  assert.strictEqual(resp.body.error.message.includes('no bearer token'), true);
});

test('denies when token payload lacks sub', async () => {
  const out = await handler(makeEvent({ 'custom:user_id': '421' }));
  assert.strictEqual(out.mcp.transformedGatewayResponse.statusCode, 401);
  assert.strictEqual(out.mcp.transformedGatewayResponse.body.error.message.includes('sub absent'), true);
});

test('denies when userId not resolvable', async () => {
  const out = await handler(makeEvent({ sub: 's2', email: 'x@y.z' }));
  assert.strictEqual(out.mcp.transformedGatewayResponse.statusCode, 401);
  assert.strictEqual(out.mcp.transformedGatewayResponse.body.error.message.includes('userId not resolvable'), true);
});

test('no full JWT content forwarded beyond selected fields', async () => {
  const out = await handler(makeEvent({ ...fullClaims, token_use: 'access', aud: 'xx', "custom:junk": 'j' }));
  const raw = out.mcp.transformedGatewayRequest.headers['x-mcp-claims'];
  assert.strictEqual(raw.includes('aud'), false);
  assert.strictEqual(raw.includes('token_use'), false);
});
