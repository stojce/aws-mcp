import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleHttpEvent, handleMessage, initializeTools, LATEST_PROTOCOL_VERSION } from './runtime.mjs';

// Wire contracts from schema/2026-07-28/schema.ts and the versioned HTTP spec:
// https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
const VERSION = '2026-07-28';
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_KEY = 'io.modelcontextprotocol/clientInfo';
const SERVER_KEY = 'io.modelcontextprotocol/serverInfo';
const resourceUrl = 'https://mcp.example.com/mcp';
const claims = {
  sub: 'verified-user', client_id: 'mcp-client', token_use: 'access',
  aud: resourceUrl, scope: 'mcp/read',
};
const cfg = {
  clientId: claims.client_id,
  requiredScope: 'mcp/read',
  resourceUrl,
  resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource/mcp',
  authorizationServer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example',
  serverInfo: { name: 'test-server', version: '1.0.0' },
  tools: [{
    name: 'get_my_bookings', description: 'Bookings for the signed-in user',
    inputSchema: { type: 'object', properties: { since: { type: 'string' } }, required: ['since'] },
  }],
  invokeTool: async () => ({ bookings: [] }),
};
const metadata = () => ({ [VERSION_KEY]: VERSION, [CAPABILITIES_KEY]: {} });
const rpc = (method, params = {}, id = 1) => ({
  jsonrpc: '2.0', id, method, params: { _meta: metadata(), ...params },
});
const event = (msg, extra = {}) => ({
  requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims } } },
  headers: {
    'MCP-Protocol-Version': VERSION,
    'Mcp-Method': msg.method,
    ...(msg.method === 'tools/call' || msg.method === 'prompts/get' ? { 'Mcp-Name': msg.params?.name } : {}),
    ...(msg.method === 'resources/read' ? { 'Mcp-Name': msg.params?.uri } : {}),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  },
  body: typeof msg === 'string' ? msg : JSON.stringify(msg),
  ...extra,
});
const toolCall = args => rpc('tools/call', { name: 'get_my_bookings', arguments: args });
const encoded = value => '=?base64?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
const bodyOf = response => JSON.parse(response.body);
const assertComplete = result => {
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result._meta, { [SERVER_KEY]: cfg.serverInfo });
};
const expectError = async (msg, code, context = cfg, extra = {}, status = 400) => {
  const response = await handleHttpEvent(event(msg, extra), context);
  assert.equal(response.statusCode, status);
  const body = bodyOf(response);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.error.code, code);
  return body;
};

test('2026-07-28: discovery works without initialization and declares both protocol eras', async () => {
  assert.equal(LATEST_PROTOCOL_VERSION, VERSION);
  const response = await handleHttpEvent(event(rpc('server/discover')), cfg);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/json');
  assert.deepEqual(bodyOf(response), {
    jsonrpc: '2.0', id: 1,
    result: {
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-06-18'],
      capabilities: { tools: { listChanged: false } },
      ttlMs: 0, cacheScope: 'private',
      _meta: { [SERVER_KEY]: cfg.serverInfo },
    },
  });
});

test('2026-07-28: tools/list has required cache hints and per-response server metadata', async () => {
  const response = await handleHttpEvent(event(rpc('tools/list')), cfg);
  assert.equal(response.statusCode, 200);
  const result = bodyOf(response).result;
  assertComplete(result);
  assert.deepEqual(result.tools, cfg.tools);
  assert.equal(result.ttlMs, 0);
  assert.equal(result.cacheScope, 'private');
  assert.equal(Object.hasOwn(result, 'nextCursor'), false);
  for (const cursor of ['', 'unissued-cursor', 123, null]) {
    await expectError(rpc('tools/list', { cursor }), -32602);
  }
});

test('2026-07-28: tools/call returns any JSON structured content and preserves verified identity', async () => {
  for (const payload of [{ bookings: [] }, ['one', 2], 'done', 42, 0, false, '', null]) {
    let seen;
    const args = { since: '2026-01-01', identity: { sub: 'spoofed' } };
    const msg = toolCall(args);
    msg.params._meta[CLIENT_KEY] = { name: 'client', version: '0', sub: 'spoofed' };
    const response = await handleHttpEvent(event(msg), {
      ...cfg, invokeTool: async input => { seen = input; return payload; },
    });
    assert.equal(response.statusCode, 200);
    const result = bodyOf(response).result;
    assertComplete(result);
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, payload);
    assert.deepEqual(JSON.parse(result.content[0].text), payload);
    assert.deepEqual(seen, {
      tool: 'get_my_bookings', arguments: args, identity: { sub: claims.sub, clientId: claims.client_id },
    });
  }
});

test('2026-07-28: every request needs fresh protocol and capability metadata', async () => {
  await handleHttpEvent(event(rpc('server/discover', {
    _meta: { ...metadata(), [CAPABILITIES_KEY]: { elicitation: { form: {} } } },
  })), cfg);
  const invalidMeta = [
    undefined, null, [], true, 'metadata', {},
    { [VERSION_KEY]: VERSION },
    { [CAPABILITIES_KEY]: {} },
    { ...metadata(), [VERSION_KEY]: 20260728 },
    { ...metadata(), [CAPABILITIES_KEY]: null },
    { ...metadata(), [CAPABILITIES_KEY]: [] },
    { ...metadata(), [CAPABILITIES_KEY]: true },
    { ...metadata(), [CAPABILITIES_KEY]: { sampling: true } },
    { ...metadata(), [CAPABILITIES_KEY]: { sampling: { tools: true } } },
    { ...metadata(), [CAPABILITIES_KEY]: { elicitation: { form: [] } } },
    { ...metadata(), [CAPABILITIES_KEY]: { experimental: { feature: true } } },
    { ...metadata(), [CAPABILITIES_KEY]: { extensions: { 'com.example/feature': null } } },
    { ...metadata(), [CLIENT_KEY]: {} },
    { ...metadata(), [CLIENT_KEY]: { name: 'client', version: 1 } },
    { ...metadata(), [CLIENT_KEY]: { name: 'client', version: '0', icons: [{ src: 1 }] } },
    { ...metadata(), 'io.modelcontextprotocol/logLevel': 'verbose' },
    { ...metadata(), progressToken: {} },
  ];
  let calls = 0;
  for (const _meta of invalidMeta) {
    const body = await expectError(rpc('tools/call', {
      name: 'get_my_bookings', arguments: { since: 'today' }, _meta,
    }), -32602, { ...cfg, invokeTool: async () => { calls++; return {}; } });
    assert.equal(body.id, 1);
  }
  assert.equal(calls, 0);
});

test('2026-07-28: optional client information and unknown capabilities remain interoperable', async () => {
  const response = await handleHttpEvent(event(rpc('tools/list', {
    _meta: {
      ...metadata(),
      [CAPABILITIES_KEY]: {
        roots: {}, sampling: { tools: {}, context: {} }, elicitation: { form: {}, url: {} },
        extensions: { 'com.example/feature': {} }, futureCapability: true,
      },
      [CLIENT_KEY]: {
        name: 'client', version: '0', title: 'Client', description: 'A client', websiteUrl: 'https://example.com',
        icons: [{ src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'dark' }],
      },
      'com.example/extra': { arbitrary: true },
    },
  })), cfg);
  assert.equal(response.statusCode, 200);
  assertComplete(bodyOf(response).result);
});

test('2026-07-28: unsupported versions produce retryable negotiation errors', async () => {
  for (const requested of ['2025-11-25', '2099-01-01']) {
    const msg = rpc('server/discover', { _meta: { ...metadata(), [VERSION_KEY]: requested } }, 'version-request');
    const headers = { ...event(msg).headers, 'MCP-Protocol-Version': requested };
    const body = await expectError(msg, -32022, cfg, { headers });
    assert.equal(body.id, 'version-request');
    assert.deepEqual(body.error.data, { requested, supported: ['2026-07-28', '2025-06-18'] });
  }
});

test('2026-07-28: protocol, method, and name header failures never dispatch a tool', async () => {
  let calls = 0;
  const msg = toolCall({ since: 'today' });
  const valid = event(msg).headers;
  const invalid = [
    { ...valid, 'MCP-Protocol-Version': undefined },
    { ...valid, 'MCP-Protocol-Version': '' },
    { ...valid, 'MCP-Protocol-Version': null },
    { ...valid, 'MCP-Protocol-Version': [VERSION] },
    { ...valid, 'MCP-Protocol-Version': VERSION + ', ' + VERSION },
    { ...valid, 'MCP-Protocol-Version': ' ' + VERSION },
    { ...valid, 'MCP-Protocol-Version': '2025-06-18' },
    { ...valid, 'mcp-protocol-version': VERSION },
    { ...valid, 'Mcp-Method': undefined },
    { ...valid, 'Mcp-Method': 'tools/list' },
    { ...valid, 'Mcp-Method': 'TOOLS/CALL' },
    { ...valid, 'Mcp-Method': 'tools/call\n' },
    { ...valid, 'mcp-method': 'tools/call' },
    { ...valid, 'Mcp-Name': undefined },
    { ...valid, 'Mcp-Name': 'other_tool' },
    { ...valid, 'Mcp-Name': 'GET_MY_BOOKINGS' },
    { ...valid, 'Mcp-Name': 'get_my_bookings, get_my_bookings' },
    { ...valid, 'Mcp-Name': ['get_my_bookings'] },
    { ...valid, 'mcp-name': 'get_my_bookings' },
  ];
  for (const headers of invalid) {
    const body = await expectError(msg, -32020, {
      ...cfg, invokeTool: async () => { calls++; return {}; },
    }, { headers });
    assert.equal(body.id, 1);
  }
  assert.equal(calls, 0);
  const mismatchedBody = toolCall({ since: 'today' });
  mismatchedBody.params._meta[VERSION_KEY] = '2025-06-18';
  await expectError(mismatchedBody, -32020);
});

test('2026-07-28: standard header names are case-insensitive', async () => {
  for (const headerNames of [
    ['mcp-protocol-version', 'mcp-method', 'mcp-name'],
    ['McP-pRoToCoL-vErSiOn', 'mCp-MeThOd', 'mCp-NaMe'],
  ]) {
    const msg = toolCall({ since: 'today' });
    const response = await handleHttpEvent(event(msg, { headers: {
      [headerNames[0]]: VERSION, [headerNames[1]]: 'tools/call', [headerNames[2]]: 'get_my_bookings',
    } }), cfg);
    assert.equal(response.statusCode, 200);
    assertComplete(bodyOf(response).result);
  }
});

test('2026-07-28: Mcp-Name decodes UTF-8, whitespace, control characters, and literal sentinels', async () => {
  for (const name of ['get_天气', ' padded ', 'line1\nline2', '\uFEFFname', '=?base64?SGVsbG8=?=', 'get_my_bookings']) {
    const context = { ...cfg, tools: [{ name, inputSchema: { type: 'object' } }] };
    const msg = rpc('tools/call', { name, arguments: {} });
    const response = await handleHttpEvent(event(msg, {
      headers: { ...event(msg).headers, 'Mcp-Name': encoded(name) },
    }), context);
    assert.equal(response.statusCode, 200);
    assert.equal(bodyOf(response).result.isError, false);
    if (name !== 'get_my_bookings') await expectError(msg, -32020, context);
  }
});

test('2026-07-28: invalid Base64, padding, and UTF-8 name headers are rejected', async () => {
  const msg = toolCall({ since: 'today' });
  for (const value of [
    '=?base64?!!!!?=', '=?base64?aGVsbG8?=', '=?base64?/w==?=', '=?base64?Zx==?=',
    '=?BASE64?Z2V0X215X2Jvb2tpbmdz?=', 'get_my_bookings\r\nInjected: yes', 'get_my_bookings\u0000',
  ]) {
    await expectError(msg, -32020, cfg, { headers: { ...event(msg).headers, 'Mcp-Name': value } });
  }
});

test('2026-07-28: removed and unadvertised RPC methods produce HTTP 404 method-not-found', async () => {
  for (const method of ['initialize', 'ping', 'logging/setLevel', 'resources/list', 'prompts/list', 'subscriptions/listen']) {
    const body = await expectError(rpc(method), -32601, cfg, {}, 404);
    assert.equal(body.id, 1);
  }
  for (const [method, params] of [
    ['resources/read', { uri: 'https://example.com/resource' }],
    ['prompts/get', { name: 'example-prompt' }],
  ]) {
    await expectError(rpc(method, params), -32601, cfg, {}, 404);
    await expectError(rpc(method, params), -32020, cfg, {
      headers: { ...event(rpc(method, params)).headers, 'Mcp-Name': 'mismatch' },
    });
  }
});

test('2026-07-28: malformed calls are protocol errors and schema failures are complete tool errors', async () => {
  let calls = 0;
  const context = { ...cfg, invokeTool: async () => { calls++; return {}; } };
  for (const args of [null, [], 'arguments', 123]) {
    await expectError(toolCall(args), -32602, context);
  }
  for (const params of [{ inputResponses: [] }, { requestState: 123 }]) {
    await expectError(rpc('tools/call', { name: 'get_my_bookings', arguments: { since: 'today' }, ...params }),
      -32602, context);
  }
  await expectError(rpc('tools/call', { name: 'unknown_tool', arguments: {} }), -32602, context);
  for (const args of [{}, { since: 123 }]) {
    const response = await handleHttpEvent(event(toolCall(args)), context);
    assert.equal(response.statusCode, 200);
    const result = bodyOf(response).result;
    assertComplete(result);
    assert.equal(result.isError, true);
    assert.equal(Object.hasOwn(result, 'structuredContent'), false);
  }
  assert.equal(calls, 0);
});

test('2026-07-28: errors preserve readable IDs and omit unreadable IDs', async () => {
  for (const id of ['', 'request-1', 0, -1, Number.MAX_SAFE_INTEGER]) {
    const msg = rpc('tools/list', {}, id);
    msg.jsonrpc = 'invalid';
    const body = await expectError(msg, -32600);
    assert.equal(body.id, id);
  }
  for (const id of [null, {}, [], true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const body = await expectError(rpc('tools/list', {}, id), -32600);
    assert.equal(Object.hasOwn(body, 'id'), false);
  }
  const parse = await expectError('{not json', -32700);
  assert.equal(Object.hasOwn(parse, 'id'), false);
  for (const msg of [
    [rpc('tools/list')], { jsonrpc: '2.0', id: 'reply', result: { resultType: 'complete' } },
    { jsonrpc: '2.0', id: 'reply', error: { code: -32601, message: 'error' } },
  ]) await expectError(msg, -32600);
});

test('2026-07-28: notification mechanics accept extensions without request metadata', async () => {
  const response = await handleHttpEvent(event({ jsonrpc: '2.0', method: 'notifications/example' }, {
    headers: { 'MCP-Protocol-Version': VERSION },
  }), cfg);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body, '');
});

test('2026-07-28: protocol session and event replay headers are ignored', async () => {
  const msg = rpc('server/discover');
  const response = await handleHttpEvent(event(msg, {
    headers: { ...event(msg).headers, 'Mcp-Session-Id': 'old-session', 'Last-Event-ID': 'old-event' },
  }), cfg);
  assert.equal(response.statusCode, 200);
  assert.equal(Object.hasOwn(response.headers, 'mcp-session-id'), false);
  for (const method of ['GET', 'DELETE']) {
    const response = await handleHttpEvent({
      requestContext: { http: { method }, authorizer: { jwt: { claims } } }, headers: {},
    }, cfg);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, 'POST');
  }
});

test('2026-07-28: backend failures and deadlines retain complete tool-error envelopes', async () => {
  const msg = toolCall({ since: 'today' });
  const failure = await handleHttpEvent(event(msg), {
    ...cfg, invokeTool: async () => { throw new Error('private backend information'); },
  });
  assertComplete(bodyOf(failure).result);
  assert.equal(bodyOf(failure).result.isError, true);
  assert.doesNotMatch(failure.body, /private backend/);
  let calls = 0;
  const expired = event(msg);
  expired.requestContext.timeEpoch = Date.now() - 30000;
  const timeout = await handleHttpEvent(expired, {
    ...cfg, invokeTool: async () => { calls++; return {}; },
  });
  assertComplete(bodyOf(timeout).result);
  assert.equal(bodyOf(timeout).result.isError, true);
  assert.equal(calls, 0);
});

test('2026-07-28: direct runtime callers receive the same metadata and version validation', async () => {
  const result = await handleMessage(rpc('tools/list'), cfg);
  assertComplete(result.result);
  const missing = await handleMessage(rpc('tools/list', { _meta: {} }), { ...cfg, protocolVersion: VERSION });
  assert.equal(missing.error.code, -32602);
  const unsupported = await handleMessage(rpc('tools/list', {
    _meta: { ...metadata(), [VERSION_KEY]: '2099-01-01' },
  }), cfg);
  assert.equal(unsupported.error.code, -32022);
  const mismatch = await handleMessage(rpc('tools/list'), { ...cfg, protocolVersion: '2025-06-18' });
  assert.equal(mismatch.error.code, -32020);
});

const headerTool = {
  name: 'header_tool',
  inputSchema: {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
      },
      count: { type: 'integer', 'x-mcp-header': 'Count' },
      enabled: { type: 'boolean', 'x-mcp-header': 'Enabled' },
    },
  },
};
const headerCall = args => rpc('tools/call', { name: 'header_tool', arguments: args });
const headerCfg = { ...cfg, tools: [headerTool] };

test('2026-07-28: custom parameter headers use exact nested paths and numeric/boolean conversion', async () => {
  for (const region of ['eu-west-1', 'Hello, 世界', ' padded ', 'line1\nline2', '=?base64?literal?=', '']) {
    let seen;
    const args = { options: { region }, count: 42, enabled: false };
    const msg = headerCall(args);
    const response = await handleHttpEvent(event(msg, { headers: {
      ...event(msg).headers, 'mCp-PaRaM-ReGiOn': encoded(region),
      'Mcp-Param-Count': '42.0', 'Mcp-Param-Enabled': 'false',
      'Mcp-Param-Unrecognized': 'ignored',
    } }), { ...headerCfg, invokeTool: async input => { seen = input; return {}; } });
    assert.equal(response.statusCode, 200);
    assert.equal(bodyOf(response).result.isError, false);
    assert.deepEqual(seen.arguments, args);
    assert.deepEqual(seen.identity, { sub: claims.sub, clientId: claims.client_id });
  }
});

test('2026-07-28: missing, malformed, mismatched, and extra recognized parameter headers are rejected', async () => {
  let calls = 0;
  const msg = headerCall({ options: { region: 'eu-west-1' }, count: 1, enabled: true });
  const valid = {
    ...event(msg).headers, 'Mcp-Param-Region': 'eu-west-1', 'Mcp-Param-Count': '1', 'Mcp-Param-Enabled': 'true',
  };
  for (const headers of [
    { ...valid, 'Mcp-Param-Region': undefined },
    { ...valid, 'Mcp-Param-Region': 'other-region' },
    { ...valid, 'Mcp-Param-Region': 'eu-west-1\n' },
    { ...valid, 'Mcp-Param-Region': '=?base64?!!!!?=' },
    { ...valid, 'mcp-param-region': 'eu-west-1' },
    { ...valid, 'Mcp-Param-Count': '2' },
    { ...valid, 'Mcp-Param-Enabled': 'TRUE' },
  ]) await expectError(msg, -32020, { ...headerCfg, invokeTool: async () => { calls++; return {}; } }, { headers });
  const absent = headerCall({});
  await expectError(absent, -32020, headerCfg, {
    headers: { ...event(absent).headers, 'Mcp-Param-Region': 'eu-west-1' },
  });
  const unsafe = headerCall({ count: Number.MAX_SAFE_INTEGER + 1 });
  await expectError(unsafe, -32020, headerCfg, {
    headers: { ...event(unsafe).headers, 'Mcp-Param-Count': String(Number.MAX_SAFE_INTEGER + 1) },
  });
  assert.equal(calls, 0);
});

test('2026-07-28: absent and null parameter values do not require headers', async () => {
  const omitted = await handleHttpEvent(event(headerCall({})), headerCfg);
  assert.equal(omitted.statusCode, 200);
  assert.equal(bodyOf(omitted).result.isError, false);
  const nullValue = await handleHttpEvent(event(headerCall({ options: { region: null } })), headerCfg);
  assert.equal(nullValue.statusCode, 200);
  assert.equal(bodyOf(nullValue).result.isError, true);
});

test('2026-07-28: invalid header annotations fail startup before tool advertisement', () => {
  const annotated = (type, name = 'Region') => ({ type, 'x-mcp-header': name });
  const root = properties => ({ type: 'object', properties });
  const invalid = [
    ...['', 'bad name', 'bad:name', 'bad\r\nname'].map(name => root({ region: annotated('string', name) })),
    ...['number', 'object', 'array'].map(type => root({ region: annotated(type) })),
    root({ region: annotated('string', 123) }),
    root({ a: annotated('string', 'Region'), b: annotated('string', 'region') }),
    { type: 'object', 'x-mcp-header': 'Root' },
    { type: 'object', allOf: [root({ region: annotated('string') })] },
    { type: 'object', if: root({ region: annotated('string') }) },
    { type: 'object', patternProperties: { '.*': annotated('string') } },
    root({ regions: { type: 'array', items: annotated('string') } }),
    { type: 'object', $defs: { region: annotated('string') }, properties: { region: { $ref: '#/$defs/region' } } },
  ];
  for (const inputSchema of invalid) {
    assert.throws(() => initializeTools([{ name: 'invalid_header_tool', inputSchema }]), /Invalid input schema/);
  }
  initializeTools([{ name: 'literal_data', inputSchema: {
    type: 'object', properties: { data: { const: { 'x-mcp-header': 'literal data' } } },
  } }]);
});

test('2026-07-28: browser preflight permits standard and configured parameter headers', async () => {
  const origin = 'https://app.example.com';
  const response = await handleHttpEvent({
    requestContext: { http: { method: 'OPTIONS' } },
    headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-Region',
    },
  }, { ...headerCfg, allowedOrigins: [origin] });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  for (const name of ['mcp-method', 'mcp-name', 'mcp-param-region', 'mcp-param-count', 'mcp-param-enabled']) {
    assert.ok(response.headers['access-control-allow-headers'].split(', ').includes(name));
  }
  const msg = headerCall({});
  const denied = await handleHttpEvent(event(msg, {
    headers: { ...event(msg).headers, Origin: 'https://untrusted.example.com' },
  }), { ...headerCfg, allowedOrigins: [origin] });
  assert.equal(denied.statusCode, 403);
});

test('2026-07-28: punctuation in valid parameter header names survives CORS and dispatch', async () => {
  const context = {
    ...cfg, allowedOrigins: ['https://app.example.com'],
    tools: [{ name: 'header_tool', inputSchema: {
      type: 'object', properties: { flag: { type: 'boolean', 'x-mcp-header': 'X&Y' } },
    } }],
  };
  const preflight = await handleHttpEvent({
    requestContext: { http: { method: 'OPTIONS' } },
    headers: {
      Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Mcp-Method, Mcp-Name, Mcp-Param-X&Y',
    },
  }, context);
  assert.equal(preflight.statusCode, 204);
  assert.match(preflight.headers['access-control-allow-headers'], /mcp-param-x&y/);
  const msg = headerCall({ flag: false });
  const response = await handleHttpEvent(event(msg, {
    headers: { ...event(msg).headers, 'Mcp-Param-X&Y': 'false' },
  }), context);
  assert.equal(response.statusCode, 200);
  assert.equal(bodyOf(response).result.isError, false);
});

test('2026-07-28: verified JWT boundaries still precede tool dispatch', async () => {
  let calls = 0;
  for (const [invalidClaims, status] of [
    [undefined, 401], [{ ...claims, token_use: 'id' }, 401],
    [{ ...claims, client_id: 'other-client' }, 401], [{ ...claims, aud: 'https://other.example.com' }, 401],
    [{ ...claims, scope: 'openid' }, 403],
  ]) {
    const response = await handleHttpEvent(event(toolCall({ since: 'today' }), {
      requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims: invalidClaims } } },
    }), { ...cfg, invokeTool: async () => { calls++; return {}; } });
    assert.equal(response.statusCode, status);
    assert.match(response.headers['www-authenticate'], /resource_metadata=/);
  }
  assert.equal(calls, 0);
});

test('legacy calls keep their lifecycle and do not require modern mirrored headers', async () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'header_tool', arguments: { options: { region: 'eu-west-1' } },
  } };
  const response = await handleHttpEvent(event(msg, {
    headers: { 'MCP-Protocol-Version': '2025-06-18' },
  }), headerCfg);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(bodyOf(response).result, {
    content: [{ type: 'text', text: '{"bookings":[]}' }], isError: false,
  });
});
