// Live JWT-attack suite for the deployed MCP gateway (CUSTOM_JWT authorizer).
// Every token is FORGED locally but structurally shaped for the pool/client;
// every assert is that the REAL gateway rejects it.
//
// Wire: raw streamable-HTTP MCP JSON-RPC (same as user-tools.test.mjs).
//
// Env: MCP_TEST_CLIENT_ID required; MCP_TEST_USER_POOL_ID / MCP_TEST_REGION
// / MCP_TEST_GATEWAY_URL optional overrides (see user-tools.test.mjs).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const REGION = process.env.MCP_TEST_REGION ?? 'eu-west-1';
const POOL_ID = process.env.MCP_TEST_USER_POOL_ID ?? 'eu-west-1_Q7QTpRXPO';
const GATEWAY_URL =
  process.env.MCP_TEST_GATEWAY_URL ??
  'https://mcp-demo-mcp-gateway-swr21tzywx.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp';
const CLIENT_ID = process.env.MCP_TEST_CLIENT_ID;
assert.ok(CLIENT_ID, 'MCP_TEST_CLIENT_ID is required (the MCP app client id)');

const ISS = `https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}`;
const now = Math.floor(Date.now() / 1000);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let jsonRpcId = 0;
async function mcp(token, method = 'tools/list', params = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++jsonRpcId, method, params }),
  });
  const text = await resp.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON gateway response (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  return { status: resp.status, body };
}

const b64u = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Deterministic forged token: Cognito-shaped claims, locally chosen keying. */
function forge({
  alg = 'RS256',
  scope = 'mcp/read',
  client_id = CLIENT_ID,
  issuer = ISS,
  claimsExtra = {},
  kid = 'forged-kid-not-in-cognito-jwks',
} = {}) {
  const header = { alg, typ: 'JWT', kid };
  const body = {
    sub: '00000000-0000-0000-0000-000000000000',
    client_id,
    token_use: 'access',
    scope,
    iss: issuer,
    exp: now + 600,
    iat: now,
    ...claimsExtra,
  };
  const unsigned = `${b64u(header)}.${b64u(body)}`;
  // RS256 with random bytes: not a valid signature for any pool JWKS key.
  const sig = crypto.randomBytes(256).toString('base64url');
  return `${unsigned}.${sig}`;
}

const expectReject = ({ label, status, body }) => {
  assert.ok(
    status === 401 || status === 403 || body.error,
    `${label}: got HTTP ${status} body ${JSON.stringify(body).slice(0, 200)}`,
  );
};

// ---------------------------------------------------------------- tests

test('alg=none unsigned token is rejected', async () => {
  const unsigned = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({
    sub: 'x', client_id: CLIENT_ID, token_use: 'access', scope: 'mcp/read', iss: ISS, exp: now + 600, iat: now,
  })}.`;
  const r = await mcp(unsigned);
  expectReject({ label: 'alg=none accepted', status: r.status, body: r.body });
});

test('HS256-forged token with Cognito-shaped claims is rejected', async () => {
  const header = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u({
    sub: 'x', client_id: CLIENT_ID, token_use: 'access', scope: 'mcp/read', iss: ISS, exp: now + 600, iat: now,
  });
  const sig = crypto.createHmac('sha256', 'attacker-key').update(`${header}.${body}`).digest('base64url');
  const r = await mcp(`${header}.${body}.${sig}`);
  expectReject({ label: 'HS256-forged accepted', status: r.status, body: r.body });
});

test('RS256-forged token with an absolutely random key is rejected', async () => {
  const r = await mcp(forge());
  expectReject({ label: 'random-RS256 accepted', status: r.status, body: r.body });
});

test('valid-shaped token missing the mcp/read scope is rejected', async () => {
  const r = await mcp(forge({ scope: 'openid' }));
  expectReject({ label: 'no-mcp/read-scope accepted', status: r.status, body: r.body });
});

test('valid-shaped token from a foreign issuer is rejected', async () => {
  const r = await mcp(forge({ issuer: 'https://evil.example.com' }));
  expectReject({ label: 'foreign-issuer accepted', status: r.status, body: r.body });
});

test('valid-shaped token from the web app client (not the MCP client) is rejected', async () => {
  const WEB_APP_CLIENT_ID = process.env.MCP_TEST_WEB_APP_CLIENT_ID;
  if (!WEB_APP_CLIENT_ID) {
    console.log('   ↳ skipped (set MCP_TEST_WEB_APP_CLIENT_ID to the web app client id)');
    return;
  }
  const r = await mcp(forge({ client_id: WEB_APP_CLIENT_ID }));
  expectReject({ label: 'web-app-client forged token accepted', status: r.status, body: r.body });
});

test('expired token is rejected', async () => {
  const r = await mcp(forge({ claimsExtra: { exp: now - 3600 } }));
  expectReject({ label: 'expired token accepted', status: r.status, body: r.body });
});

test('unresolvable-sub token: tools/call must never return data', async () => {
  const r = await mcp(forge({ scope: 'mcp/read' }), 'tools/call', {
    name: 'get-my-jobs___get_my_jobs',
    arguments: {},
  });
  expectReject({ label: 'unresolvable-sub tools/call returned data', status: r.status, body: r.body });
});

// ---------------------------------------------------------------- run

let passedCount = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passedCount++;
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(String(e?.stack ?? e));
    process.exit(1);
  }
}
console.log(`\nALL ${passedCount}/${tests.length} FORGED-TOKEN ASSERTS PASSED`);
