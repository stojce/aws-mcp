import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, handleMessage, handleHttpEvent, initializeTools } from './runtime.mjs';

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
  headers: { 'mcp-protocol-version': '2025-06-18' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...extra,
});

const initializeRequest = protocolVersion => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '0' } },
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
  const ok = await handleMessage(initializeRequest('2025-06-18'), cfg);
  assert.equal(ok.result.protocolVersion, '2025-06-18');
  assert.ok(ok.result.capabilities.tools);

  for (const requested of ['2025-03-26', '1999-01-01']) {
    const fallback = await handleMessage(initializeRequest(requested), cfg);
    assert.equal(fallback.result.protocolVersion, '2025-06-18');
  }
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

test('HTTP: tools/call validates the advertised schema before invoking the backend', async () => {
  const inputSchema = {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 10 },
      status: { enum: ['active', 'paused'] },
    },
    required: ['count', 'status'],
    additionalProperties: false,
  };
  for (const args of [
    { count: 'many', status: 'invalid', extra: true },
    { count: '2', status: 'active' },
    { count: 1.5, status: 'active' },
    { count: 0, status: 'active' },
    { count: 11, status: 'active' },
    { count: 2, status: 'invalid' },
    { count: 2, status: 'active', extra: true },
  ]) {
    let calls = 0;
    const res = await handleHttpEvent(httpEvent(goodClaims, {
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'checked', arguments: args },
    }), {
      ...cfg,
      tools: [{ name: 'checked', description: 'checked', inputSchema }],
      invokeTool: async () => { calls++; return {}; },
    });
    assert.equal(calls, 0, `Invalid arguments reached the backend: ${JSON.stringify(args)}`);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).result.isError, true);
  }
});

const schemaCases = [
  {
    name: 'nested objects, arrays, strings, formats, and local references',
    inputSchema: {
      type: 'object',
      $defs: {
        contact: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            code: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[A-Z]+$' },
          },
          required: ['email', 'code'],
          additionalProperties: false,
        },
      },
      properties: {
        contacts: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { $ref: '#/$defs/contact' } },
        price: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 2, multipleOf: 0.25 },
      },
      required: ['contacts', 'price'],
      additionalProperties: false,
    },
    valid: { contacts: [{ email: 'user@example.com', code: 'AB' }], price: 0.5 },
    invalid: [
      { contacts: [], price: 0.5 },
      { contacts: [{ email: 'invalid', code: 'AB' }], price: 0.5 },
      { contacts: [{ email: 'user@example.com', code: 'a' }], price: 0.5 },
      { contacts: [{ email: 'user@example.com', code: 'ABCDE' }], price: 0.5 },
      { contacts: [{ email: 'user@example.com' }], price: 0.5 },
      { contacts: [{ email: 'user@example.com', code: 'AB', extra: true }], price: 0.5 },
      { contacts: [{ email: 'user@example.com', code: 'AB' }, { email: 'user@example.com', code: 'AB' }], price: 0.5 },
      { contacts: [{ email: 'user@example.com', code: 'AB' }], price: 0 },
      { contacts: [{ email: 'user@example.com', code: 'AB' }], price: 2 },
      { contacts: [{ email: 'user@example.com', code: 'AB' }], price: 0.3 },
    ],
  },
  {
    name: 'composition, conditional schemas, dependencies, and unevaluated properties',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        kind: { enum: ['number', 'string'] },
        value: { anyOf: [{ type: 'integer' }, { type: 'string', minLength: 2 }] },
        confirm: { const: true },
      },
      required: ['kind', 'value'],
      allOf: [{ not: { properties: { value: { const: 'forbidden' } }, required: ['value'] } }],
      oneOf: [
        { properties: { kind: { const: 'number' } } },
        { properties: { kind: { const: 'string' } } },
      ],
      if: { properties: { kind: { const: 'number' } } },
      then: { properties: { value: { type: 'integer' } } },
      else: { properties: { value: { type: 'string' } } },
      dependentRequired: { confirm: ['reason'] },
      dependentSchemas: { confirm: { properties: { reason: { type: 'string', minLength: 1 } } } },
      unevaluatedProperties: false,
    },
    valid: { kind: 'number', value: 2, confirm: true, reason: 'ok' },
    invalid: [
      { kind: 'number', value: 'wrong' },
      { kind: 'string', value: 2 },
      { kind: 'string', value: 'x' },
      { kind: 'string', value: 'forbidden' },
      { kind: 'number', value: 2, confirm: true },
      { kind: 'number', value: 2, confirm: true, reason: 0 },
      { kind: 'number', value: 2, extra: true },
    ],
  },
  {
    name: '2020-12 tuple and contains constraints',
    inputSchema: {
      type: 'object',
      properties: {
        tuple: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false, minItems: 2 },
        flags: { type: 'array', contains: { const: true }, minContains: 1, maxContains: 1 },
      },
      required: ['tuple', 'flags'],
    },
    valid: { tuple: ['a', 2], flags: [false, true] },
    invalid: [
      { tuple: [2, 'a'], flags: [true] },
      { tuple: ['a'], flags: [true] },
      { tuple: ['a', 2, 3], flags: [true] },
      { tuple: ['a', 2], flags: [false] },
      { tuple: ['a', 2], flags: [true, true] },
    ],
  },
  {
    name: 'draft-07 schemas',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      definitions: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }], additionalItems: false } },
      properties: { pair: { $ref: '#/definitions/pair' } },
      required: ['pair'],
      additionalProperties: false,
    },
    valid: { pair: ['a', 2] },
    invalid: [{ pair: [2, 'a'] }, { pair: ['a', 2, 3] }, { pair: ['a', 2], extra: true }],
  },
];

for (const { name, inputSchema, valid, invalid } of schemaCases) {
  test(`HTTP: validates ${name} and preserves verified identity`, async () => {
    const seen = [];
    const toolConfig = {
      ...cfg,
      identity: { sub: 'untrusted-config' },
      tools: [{ name: 'checked', description: 'checked', inputSchema }],
      invokeTool: async input => { seen.push(input); return { ok: true }; },
    };
    for (const args of invalid) {
      const res = await handleHttpEvent(httpEvent(goodClaims, {
        jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'checked', arguments: args },
      }), toolConfig);
      assert.equal(JSON.parse(res.body).result.isError, true, JSON.stringify(args));
      assert.equal(seen.length, 0, 'Invalid arguments must never invoke the backend');
    }
    const res = await handleHttpEvent(httpEvent(goodClaims, {
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'checked', arguments: valid },
    }), toolConfig);
    assert.equal(JSON.parse(res.body).result.isError, false);
    assert.deepEqual(seen, [{ tool: 'checked', arguments: valid, identity: { sub: 'user-a', clientId: CLIENT_ID } }]);
    const listed = await handleMessage({ jsonrpc: '2.0', id: 13, method: 'tools/list' }, toolConfig);
    assert.deepEqual(listed.result.tools[0].inputSchema, inputSchema);
  });
}

test('tool schemas fail initialization rather than advertising malformed or unsupported definitions', async () => {
  for (const inputSchema of [
    undefined, true, {}, { type: 'array' },
    { type: 'object', required: 'count' },
    { type: 'object', required: ['count', 'count'] },
    { type: 'object', properties: { count: { type: 'nonsense' } } },
    { type: 'object', properties: { count: { minimum: '1' } } },
    { type: 'object', properties: { value: { enum: [] } } },
    { type: 'object', properties: { value: { pattern: '[' } } },
    { type: 'object', properties: { value: { format: 'unknown-format' } } },
    { type: 'object', properties: { count: { minimun: 1 } } },
    { type: 'object', $ref: '#/$defs/missing' },
    { type: 'object', $ref: 'https://untrusted.invalid/schema' },
    { type: 'object', $schema: 'https://untrusted.invalid/dialect' },
    { type: 'object', $async: true },
  ]) {
    const tools = [{ name: 'broken', inputSchema }];
    assert.throws(() => initializeTools(tools), /Invalid input schema for tool broken/);
    let calls = 0;
    const toolConfig = { ...cfg, tools, invokeTool: async () => { calls++; } };
    await assert.rejects(handleMessage({ jsonrpc: '2.0', id: 14, method: 'initialize' }, toolConfig), /Invalid input schema/);
    await assert.rejects(handleMessage({ jsonrpc: '2.0', id: 15, method: 'tools/list' }, toolConfig), /Invalid input schema/);
    assert.equal(calls, 0);
  }
});

test('validation keeps arguments intact and tool schema identifiers isolated', async () => {
  const inputSchema = {
    $id: 'https://example.com/tool-schema',
    type: 'object',
    properties: { count: { type: 'integer', default: 2 } },
  };
  const tools = [
    { name: 'first', inputSchema },
    { name: 'second', inputSchema: { ...inputSchema, properties: { count: { type: 'string' } } } },
  ];
  initializeTools(tools);
  const args = { identity: { sub: 'victim' }, extra: true };
  let seen;
  const res = await handleHttpEvent(httpEvent(goodClaims, {
    jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'first', arguments: args },
  }), { ...cfg, tools, invokeTool: async input => { seen = input; return {}; } });
  assert.equal(JSON.parse(res.body).result.isError, false);
  assert.deepEqual(seen.arguments, args);
  assert.equal(Object.hasOwn(seen.arguments, 'count'), false, 'Schema defaults must not modify arguments');
  assert.deepEqual(seen.identity, { sub: 'user-a', clientId: CLIENT_ID });
  const invalid = await handleHttpEvent(httpEvent(goodClaims, {
    jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'second', arguments: { count: 2 } },
  }), { ...cfg, tools, invokeTool: async () => assert.fail('Wrong schema used for second tool') });
  assert.equal(JSON.parse(invalid.body).result.isError, true);
});

test('tool arguments must be objects; omitted arguments are validated as an empty object', async () => {
  const seen = [];
  const toolConfig = {
    ...cfg,
    tools: [{ name: 'empty', inputSchema: { type: 'object', additionalProperties: false } }],
    invokeTool: async input => { seen.push(input.arguments); return {}; },
  };
  for (const args of [null, [], 'text', 2, true]) {
    const res = await handleHttpEvent(httpEvent(goodClaims, {
      jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'empty', arguments: args },
    }), toolConfig);
    assert.equal(JSON.parse(res.body).result.isError, true);
    assert.equal(seen.length, 0);
  }
  const res = await handleHttpEvent(httpEvent(goodClaims, {
    jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'empty' },
  }), toolConfig);
  assert.equal(JSON.parse(res.body).result.isError, false);
  assert.deepEqual(seen, [{}]);
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
    {
      headers: { 'mcp-protocol-version': '2025-06-18' },
      requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: goodClaims } } },
    },
    cfg
  );
  assert.equal(res.statusCode, 405);
});

test('HTTP: unsupported protocol version is rejected before dispatch', async () => {
  let calls = 0;
  for (const headers of [
    { 'MCP-Protocol-Version': '1900-01-01' },
    { 'mcp-protocol-version': '2025-03-26' },
    { 'McP-pRoToCoL-vErSiOn': 'not-a-version' },
    { 'mcp-protocol-version': '' },
    { 'mcp-protocol-version': null },
    { 'mcp-protocol-version': 20250618 },
    { 'mcp-protocol-version': ['2025-06-18'] },
    { 'mcp-protocol-version': '2025-06-18, 2025-06-18' },
    { 'mcp-protocol-version': '2025-06-18', 'MCP-Protocol-Version': '1900-01-01' },
  ]) {
    for (const body of [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      initializeRequest('2025-06-18'),
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'get_my_bookings', arguments: { since: '2026-01-01' } },
      },
    ]) {
      const res = await handleHttpEvent(httpEvent(goodClaims, body, { headers }), {
        ...cfg, invokeTool: async () => { calls++; return {}; },
      });
      assert.equal(res.statusCode, 400, JSON.stringify(headers));
      assert.equal(JSON.parse(res.body).error, 'unsupported_protocol_version');
      assert.equal(calls, 0);
    }
  }
});

test('HTTP: supported protocol header is case-insensitive and preserves verified identity', async () => {
  for (const name of ['mcp-protocol-version', 'MCP-Protocol-Version', 'McP-pRoToCoL-vErSiOn']) {
    let seen;
    const args = { since: '2026-01-01', identity: { sub: 'victim' } };
    const res = await handleHttpEvent(httpEvent(goodClaims, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_my_bookings', arguments: args },
    }, { headers: { [name]: '2025-06-18' } }), {
      ...cfg, invokeTool: async input => { seen = input; return { bookings: [] }; },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).result.isError, false);
    assert.deepEqual(seen, {
      tool: 'get_my_bookings', arguments: args, identity: { sub: 'user-a', clientId: CLIENT_ID },
    });
  }
});

test('HTTP: initialization without a protocol header negotiates only the implemented version', async () => {
  for (const requested of ['2025-06-18', '2025-03-26', '1900-01-01']) {
    const res = await handleHttpEvent(httpEvent(goodClaims, initializeRequest(requested), { headers: {} }), cfg);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).result.protocolVersion, '2025-06-18');
  }
});

test('HTTP: absent protocol headers use the unsupported 2025-03-26 fallback after initialization', async () => {
  const res = await handleHttpEvent(httpEvent(goodClaims, initializeRequest('2025-06-18'), {
    headers: undefined,
  }), cfg);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).result.protocolVersion, '2025-06-18');

  let calls = 0;
  for (const headers of [undefined, {}]) {
    for (const body of [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'get_my_bookings', arguments: { since: '2026-01-01' } },
      },
    ]) {
      const rejected = await handleHttpEvent(httpEvent(goodClaims, body, { headers }), {
        ...cfg, invokeTool: async () => { calls++; return {}; },
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(JSON.parse(rejected.body).error, 'unsupported_protocol_version');
      assert.equal(calls, 0);
    }
  }
});

test('HTTP: invalid or absent protocol headers on GET yield 400', async () => {
  for (const headers of [undefined, { 'mcp-protocol-version': '1900-01-01' }]) {
    const res = await handleHttpEvent({
      headers,
      requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: goodClaims } } },
    }, cfg);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'unsupported_protocol_version');
  }
});

test('HTTP: malformed JSON yields parse error 400', async () => {
  const res = await handleHttpEvent(httpEvent(goodClaims, '{not json'), cfg);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, -32700);
});

test('HTTP: JSON-RPC batches are rejected for the implemented and unsupported versions', async () => {
  let calls = 0;
  for (const protocolVersion of ['2025-06-18', '2025-03-26']) {
    const res = await handleHttpEvent(httpEvent(goodClaims, [{
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_my_bookings', arguments: { since: '2026-01-01' } },
    }], { headers: { 'mcp-protocol-version': protocolVersion } }), {
      ...cfg, invokeTool: async () => { calls++; return {}; },
    });
    assert.equal(res.statusCode, 400);
    if (protocolVersion === '2025-06-18') {
      assert.equal(JSON.parse(res.body).error.code, -32600);
    } else {
      assert.equal(JSON.parse(res.body).error, 'unsupported_protocol_version');
    }
    assert.equal(calls, 0);
  }
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
