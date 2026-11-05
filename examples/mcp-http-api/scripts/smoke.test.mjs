import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./smoke.sh', import.meta.url));
const origin = 'https://mcptest.io';
const fixtures = {
  'alice-private-sub': [{ id: 'a1', sk: 'BOOKING#a1', status: 'confirmed' }, { id: 'a2', sk: 'BOOKING#a2', status: 'past' }],
  'bob-private-sub': [{ id: 'b1', sk: 'BOOKING#b1', status: 'confirmed' }],
};

// API Gateway's verified-claims boundary is simulated; the actual runtime owns
// CORS, protocol handling, schema validation, and backend identity propagation.
async function fixture(t, { allowOrigin = true, looseSchema = false, sessionHeader = false, wrongOwner = false, oidc = false } = {}) {
  const runtimes = await Promise.all([0, 1].map(index => import(
    `../../../modules/mcp-http-api/lambda/mcp-server/runtime.mjs?smoke=${index}`
  )));
  let cfg;
  let counter = 0;
  const invocations = [];
  const knownTokens = new Map();
  const server = createServer(async (req, res) => {
    try {
      if (oidc && req.url === '/issuer/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(cfg.authorizationServerMetadata));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const claims = knownTokens.get(req.headers.authorization?.replace(/^Bearer /, ''));
      const response = await runtimes[counter++ % runtimes.length].handleHttpEvent({
        routeKey: `${req.method} ${new URL(req.url, cfg.resourceUrl).pathname}`,
        headers: req.headers,
        requestContext: { http: { method: req.method }, authorizer: { jwt: { claims } } },
        body: Buffer.concat(chunks).toString(),
      }, cfg);
      res.writeHead(response.statusCode, {
        ...response.headers,
        ...(sessionHeader ? { 'Mcp-Session-Id': 'fixture-session' } : {}),
      });
      res.end(response.body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/mcp`;
  const scope = `${url}/read`;
  cfg = {
    clientId: 'fixture-client', requiredScope: scope, resourceUrl: url,
    resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp`,
    authorizationServer: oidc ? `${base}/issuer` : base,
    authorizationServerMetadata: {
      issuer: oidc ? `${base}/issuer` : base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
      code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'],
      client_id_metadata_document_supported: false,
    },
    allowedOrigins: allowOrigin ? [origin] : [],
    serverInfo: { name: 'smoke-fixture', version: '1.0.0' },
    tools: [{
      name: 'get_my_bookings', description: 'Fixture bookings',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['confirmed', 'cancelled', 'past'], ...(!looseSchema ? { description: 'Filter by status.' } : {}) } },
        ...(!looseSchema ? { additionalProperties: false } : {}),
      },
    }],
    invokeTool: async ({ identity, arguments: args }) => {
      invocations.push({ identity, args });
      const owner = wrongOwner ? 'alice-private-sub' : identity.sub;
      return { owner, bookings: fixtures[owner].filter(b => !args.status || b.status === args.status) };
    },
  };
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-smoke-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = [];
  for (const sub of Object.keys(fixtures)) {
    const claims = { sub, client_id: cfg.clientId, token_use: 'access', aud: url, scope, exp: Math.floor(Date.now() / 1000) + 600 };
    const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.not-a-real-signature`;
    knownTokens.set(token, claims);
    const filename = path.join(directory, `${files.length}.token`);
    await writeFile(filename, token, { mode: 0o600 });
    files.push(filename);
  }
  const run = async (extra = []) => {
    const args = [script, '--url', url, '--scope', scope, '--client-id', cfg.clientId,
      '--origin', origin, '--token-file', files[0], '--other-token-file', files[1], ...extra];
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('SMOKE_')) delete env[key];
    try {
      return { code: 0, ...await execute('bash', args, { env, timeout: 45000, maxBuffer: 1024 * 1024 }) };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return { run, invocations };
}

test('smoke exercises CORS, schema denial, independent runtimes, both protocol versions, and two users', async t => {
  const { run, invocations } = await fixture(t);
  const result = await run(['--samples', '3']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /two users receive separate bookings/);
  assert.match(result.stdout, /samples=3 p50=.*p95=/);
  assert.match(result.stdout, /Result: \d+ passed, 0 failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-sub|not-a-real-signature|BOOKING#[ab]/);
  assert.ok(invocations.every(({ args }) => !Object.hasOwn(args, 'owner') && !Object.hasOwn(args, 'identity')));
  assert.deepEqual(new Set(invocations.map(x => x.identity.sub)), new Set(Object.keys(fixtures)));
});

test('smoke catches the reported browser-origin regression', async t => {
  const { run } = await fixture(t, { allowOrigin: false });
  const result = await run(['--negative-only']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL  browser preflight is public and allows the exact origin/);
});

test('smoke supports OIDC discovery fallback and public metadata CORS for external issuers', async t => {
  const { run } = await fixture(t, { oidc: true });
  const result = await run(['--authorization-mode', 'external']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS  OAuth metadata identifies the issuer/);
});

test('smoke catches an open, undocumented tool schema', async t => {
  const { run } = await fixture(t, { looseSchema: true });
  const result = await run();
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL  bookings schema rejects undeclared properties/);
  assert.match(result.stdout, /FAIL  bookings status has a property description/);
  assert.match(result.stdout, /FAIL  invalid tool arguments/);
});

test('smoke catches session identifiers and cross-user results without exposing private data', async t => {
  const { run } = await fixture(t, { sessionHeader: true, wrongOwner: true });
  const result = await run();
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL  initial tools\/list does not issue a session identifier/);
  assert.match(result.stdout, /FAIL  two users receive separate bookings/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-sub|fixture-session|BOOKING#[ab]/);
});
