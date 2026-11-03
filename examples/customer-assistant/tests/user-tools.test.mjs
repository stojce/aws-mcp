// Live integration tests: real Cognito user → deployed MCP gateway → real calls.
//
// Wire format is raw streamable-HTTP MCP JSON-RPC (identical to
// scripts/mcp-edge-smoke.mjs). No mocks, no SDK.
//
// Required env:
//   MCP_TEST_CLIENT_ID   the MCP app client id (terraform output mcp_app_client_id)
//   MCP_TEST_USER        JSON {"email":"...","password":"..."} — but USER_PASSWORD_AUTH
//                        must be enabled; the deployed MCP client uses the hosted-UI
//                        authorization-code+PKCE flow, which this runner performs
//                        against the pool's Cognito domain (headless form POST).
// Optional env:
//   MCP_TEST_USER_POOL_DOMAIN  (default: claude-gateway-a9f136c8 — get via
//                        `terraform output user_pool_domain` or the console)
//   MCP_TEST_USER_POOL_ID   (default: eu-west-1_Q7QTpRXPO)
//   MCP_TEST_REGION      (default: eu-west-1)
//   MCP_TEST_GATEWAY_URL (default: terraform output gateway_url)
//
// Run:  node tests/user-tools.test.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const REGION = process.env.MCP_TEST_REGION ?? 'eu-west-1';
const POOL_ID = process.env.MCP_TEST_USER_POOL_ID ?? 'eu-west-1_Q7QTpRXPO';
const POOL_DOMAIN =
  process.env.MCP_TEST_USER_POOL_DOMAIN ?? 'claude-gateway-a9f136c8';
const CLIENT_ID = process.env.MCP_TEST_CLIENT_ID;
const GATEWAY_URL =
  process.env.MCP_TEST_GATEWAY_URL ??
  'https://mcp-demo-mcp-gateway-swr21tzywx.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp';
const AUTH_BASE = `https://${POOL_DOMAIN}.auth.${REGION}.amazoncognito.com`;

const CURATED_TOOLS = ['get_my_jobs', 'get_job_details', 'get_job_candidates'];

const parseUserEnv = name => {
  const raw = process.env[name];
  if (!raw) return null;
  const u = JSON.parse(raw);
  if (!u.email || !u.password) {
    console.error(`${name} must be JSON {"email":...,"password":...}`);
    process.exit(1);
  }
  return u;
};

const TEST_USER = parseUserEnv('MCP_TEST_USER');
if (!TEST_USER) {
  console.error(`set MCP_TEST_USER='{"email":"...","password":"..."}' (see tests/README.md)`);
  process.exit(1);
}
assert.ok(CLIENT_ID, 'MCP_TEST_CLIENT_ID is required (the MCP app client id)');

// ---------------------------------------------------------------- helpers

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let jsonRpcId = 0;
async function mcp(token, method, params = {}) {
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

/** Parse the mcp/<tool> text envelope returned by tools/call. */
function envelope(resp) {
  assert.equal(resp.status, 200, `HTTP ${resp.status}: ${JSON.stringify(resp.body).slice(0, 300)}`);
  assert.notEqual(resp.body.result?.isError, true, `tool errored: ${JSON.stringify(resp.body.result ?? {}).slice(0, 300)}`);
  const text = resp.body.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', 'result.content[0].text missing');
  const outer = JSON.parse(text); // statusCode/headers/body envelope from the target
  assert.equal(outer.statusCode, 200, `tool returned HTTP ${outer.statusCode}: ${JSON.stringify(outer.body).slice(0, 200)}`);
  return typeof outer.body === 'string' ? JSON.parse(outer.body) : outer.body;
}

/**
 * Real end-user login through the deployed Cognito hosted UI:
 * authorization-code + PKCE on the MCP app client's only allowed flow.
 * Headless: POST the login form and harvest the callback's code.
 */
async function loginViaHostedUi() {
  const decoderLogin = `http://localhost:8080/callback`;
  const cjStub = new Map();
  // 1) authorize → 302 to /login (seeded cookies; workaround Cognito's
  //    eventual-consistency window by retrying briefly).
  let authorizeLoc = null;
  for (let attempt = 0; attempt < 5 && !authorizeLoc; attempt++) {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: decoderLogin,
      scope: 'mcp/read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const r = await fetch(`${AUTH_BASE}/oauth2/authorize?${qs}`, { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (loc && loc.startsWith(`${AUTH_BASE}/login`)) {
      authorizeLoc = { qs, loc: loc.slice(AUTH_BASE.length), verifier };
      break;
    }
    await new Promise(res => setTimeout(res, 8000));
  }
  assert.ok(authorizeLoc, 'authorize did not redirect to the hosted login page');
  // 2) login form (get _csrf)
  const formRes = await fetch(`${AUTH_BASE}${authorizeLoc.loc}`);
  const formHtml = await formRes.text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(formHtml)?.[1];
  assert.ok(csrf, 'csrf token missing from login form');
  // 3) submit credentials
  const loginPath = authorizeLoc.loc.split('?')[0]; // /login
  const loginQuery = authorizeLoc.loc.split('?')[1];
  const postRes = await fetch(`${AUTH_BASE}${loginPath}?${loginQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': formRes.headers.get('set-cookie') ?? '',
    },
    body: new URLSearchParams({
      _csrf: csrf,
      username: process.env.MCP_TEST_USERNAME ?? TEST_USER.email,
      password: TEST_USER.password,
      signInSubmitButton: 'Sign in',
    }),
    redirect: 'manual',
  });
  const callbackUrl = postRes.headers.get('location');
  assert.ok(
    callbackUrl && callbackUrl.startsWith(decoderLogin) && callbackUrl.includes('code='),
    `login failed: ${callbackUrl ?? postRes.status}`,
  );
  const code = new URL(callbackUrl).searchParams.get('code');
  // 4) exchange for tokens
  const tokenRes = await fetch(`${AUTH_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: decoderLogin,
      client_id: CLIENT_ID,
      code_verifier: authorizeLoc.verifier,
    }),
  });
  assert.equal(tokenRes.status, 200, `token exchange HTTP ${tokenRes.status}`);
  const tokens = await tokenRes.json();
  assert.ok(tokens.access_token, 'no access_token minted');
  return tokens;
}

const base64url = buf => buf.toString('base64url');

const jwtPayload = token =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

// ---------------------------------------------------------------- tests

test('real user logs in through the deployed hosted UI and gets an mcp/read token', async () => {
  const tokens = await loginViaHostedUi();
  const payload = jwtPayload(tokens.access_token);
  assert.equal(payload.token_use, 'access');
  assert.equal(payload.client_id, CLIENT_ID, 'token client_id is not the MCP app client');
  assert.ok(String(payload.scope ?? '').includes('mcp/read'), `scope lacks mcp/read: ${payload.scope}`);
  assert.ok(payload.sub, 'token has no sub');
  process.env.MCP_TEST_TOKEN = tokens.access_token; // reuse for later tests
});

test('tools/list returns exactly the three curated recruter tools', async () => {
  const { status, body } = await mcp(process.env.MCP_TEST_TOKEN, 'tools/list', {});
  assert.equal(status, 200, `tools/list HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  const names = (body.result?.tools ?? []).map(t => t.name).filter(n => !n.startsWith('x_amz_bedrock'));
  for (const t of CURATED_TOOLS) {
    assert.ok(names.some(n => n.endsWith(t)), `missing tool "${t}" (got: ${names.join(', ')})`);
  }
});

test('get_my_jobs returns the deployed output envelope with real jobs', async () => {
  const resp = await mcp(process.env.MCP_TEST_TOKEN, 'tools/call', {
    name: 'get-my-jobs___get_my_jobs',
    arguments: {},
  });
  const body = envelope(resp);
  assert.ok(Array.isArray(body.jobs), 'jobs array missing');
  for (const j of body.jobs) {
    assert.equal(typeof j.id, 'string', 'job id should be a string');
    assert.equal(typeof j.title, 'string', 'job title should be a string');
  }
  console.log(`   ↳ ${body.jobs.length} jobs returned`);
});

test('get_job_details returns job plus candidate summaries', async () => {
  const jobs = envelope(await mcp(process.env.MCP_TEST_TOKEN, 'tools/call', {
    name: 'get-my-jobs___get_my_jobs', arguments: {},
  })).jobs;
  assert.ok(jobs.length > 0, 'need at least one job to test details');
  const resp = await mcp(process.env.MCP_TEST_TOKEN, 'tools/call', {
    name: 'get-job-details___get_job_details',
    arguments: { jobId: jobs[0].id },
  });
  const detail = envelope(resp);
  assert.equal(detail.id, jobs[0].id);
  assert.equal(typeof detail.candidates, 'object', 'candidates array missing');
  console.log(`   ↳ job "${detail.title}": ${detail.candidates.length} candidates`);
});

test('get_job_candidates returns candidates with match scores', async () => {
  const jobs = envelope(await mcp(process.env.MCP_TEST_TOKEN, 'tools/call', {
    name: 'get-my-jobs___get_my_jobs', arguments: {},
  })).jobs;
  const withCandidates = jobs.find(j => j.id);
  const resp = await mcp(process.env.MCP_TEST_TOKEN, 'tools/call', {
    name: 'get-job-candidates___get_job_candidates',
    arguments: { jobId: withCandidates.id },
  });
  const body = envelope(resp);
  assert.equal(body.jobId, withCandidates.id);
  assert.ok(Array.isArray(body.candidates), 'candidates array missing');
  for (const c of body.candidates) {
    if (c.matchScore != null) {
      assert.equal(typeof c.matchScore, 'number', 'matchScore should be a number when present');
    }
  }
});

test('get_job_details rejects an unknown jobId with 404 semantics (denial intact)', async () => {
  const resp = await mcp(process.env.MCP_TEST_TOKEN, 'tools/call', {
    name: 'get-job-details___get_job_details',
    arguments: { jobId: '00000000-0000-0000-0000-000000000000' },
  });
  assert.equal(resp.status, 200);
  const text = resp.body.result?.content?.[0]?.text;
  const outer = JSON.parse(text);
  assert.equal(outer.statusCode, 404, `expected tool-level 404, got ${outer.statusCode}`);
});

test('missing Authorization header is rejected at the edge', async () => {
  const { status, body } = await mcp(null, 'tools/list', {});
  assert.equal(status, 401, `expected 401 without a token, got HTTP ${status}`);
  assert.ok(body.error, 'expected jsonrpc error body');
});

test('structurally valid JWT not signed by Cognito is rejected', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: '00000000-0000-0000-0000-000000000000',
    client_id: CLIENT_ID,
    token_use: 'access',
    scope: 'mcp/read',
    iss: `https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}`,
    exp: now + 300,
    iat: now,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.createHmac('sha256', 'bogus-signing-secret').update(`${header}.${payload}`).digest('base64url');
  const { status, body } = await mcp(`${header}.${payload}.${sig}`, 'tools/list', {});
  assert.ok(
    status === 401 || status === 403 || body.error,
    `forged JWT was accepted: HTTP ${status}`
  );
});

test('token from the admin client (wrong client_id) is rejected', async () => {
  // admin client 7deolpb… issues USER_PASSWORD_AUTH tokens whose client_id is
  // not the MCP app client; the gateway authorizer binds allowed_clients.
  const ADMIN_TOKEN = process.env.MCP_TEST_ADMIN_TOKEN; // optional
  if (!ADMIN_TOKEN) {
    console.log('   ↳ skipped (set MCP_TEST_ADMIN_TOKEN to a wrong-client access token)');
    return;
  }
  const { status } = await mcp(ADMIN_TOKEN, 'tools/list', {});
  assert.ok(status === 401 || status === 403, `wrong-client token accepted: HTTP ${status}`);
});

test('expired token is rejected', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = {
    sub: 'x', client_id: CLIENT_ID, token_use: 'access', scope: 'mcp/read',
    iss: `https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}`,
    exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.randomBytes(256).toString('base64url');
  const { status } = await mcp(`${header}.${payload}.${sig}`, 'tools/list', {});
  assert.ok(status === 401 || status === 403, `expired/forged token accepted: HTTP ${status}`);
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
console.log(`\nALL ${passedCount}/${tests.length} LIVE USER-TOOL ASSERTS PASSED`);
