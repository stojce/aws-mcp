import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleHttpEvent } from '../../../modules/mcp-http-api/lambda/mcp-server/runtime.mjs';
import { saveTokens, verifyRefresh } from './verify-refresh.mjs';

const resourceUrl = 'https://example.cloudfront.net/mcp';
const tokenEndpoint = 'https://example.auth.eu-west-1.amazoncognito.com/oauth2/token';
const clientId = 'example-client';
const requiredScope = `${resourceUrl}/read`;
const originalClaims = {
  sub: 'private-fixture-user', client_id: clientId, iss: 'https://cognito-idp.eu-west-1.amazonaws.com/fixture',
  token_use: 'access', aud: resourceUrl, scope: requiredScope,
};

function fixture({ changedClaims = {}, replayAccepted = false, repeatRefresh = false, wrongOwner = false, oauthFailure = false } = {}) {
  let generation = 0;
  let graceEnded = false;
  const knownTokens = new Map();
  const saved = [];
  const grants = [];
  const calls = [];
  const mint = changes => {
    const claims = { ...originalClaims, ...changes, jti: generation };
    const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.not-signed`;
    knownTokens.set(token, claims);
    return { access_token: token, refresh_token: `private-refresh-${generation}`, token_type: 'Bearer' };
  };
  const initial = mint({});
  let current = initial;
  const cfg = {
    resourceUrl, clientId, requiredScope, authorizationServer: originalClaims.iss,
    resourceMetadataUrl: 'https://example.cloudfront.net/.well-known/oauth-protected-resource/mcp',
    serverInfo: { name: 'refresh-fixture', version: '1.0.0' },
    tools: [{ name: 'get_my_bookings', description: 'Fixture bookings', inputSchema: { type: 'object', additionalProperties: false } }],
    invokeTool: async ({ identity }) => {
      calls.push(identity);
      return { owner: wrongOwner ? 'another-user' : identity.sub, bookings: [] };
    },
  };
  const fetchFn = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url === tokenEndpoint) {
      const form = new URLSearchParams(options.body);
      grants.push(form);
      assert.equal(options.method, 'POST');
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('client_id'), clientId);
      assert.equal(form.get('resource'), resourceUrl);
      assert.equal(form.has('client_secret'), false);
      assert.equal(options.headers.Authorization, undefined);
      if (oauthFailure || (graceEnded && form.get('refresh_token') !== current.refresh_token && !replayAccepted)) {
        return Response.json({ error: 'invalid_grant', error_description: 'private-refresh-secret' }, { status: 400 });
      }
      const previousRefresh = current.refresh_token;
      generation++;
      current = mint(changedClaims);
      if (repeatRefresh) current.refresh_token = previousRefresh;
      return Response.json(current);
    }
    assert.equal(url, resourceUrl);
    // Simulate the native authorizer supplying verified claims for fixture
    // tokens, then exercise the real MCP adapter and backend identity channel.
    const claims = knownTokens.get(options.headers.Authorization.replace(/^Bearer /, ''));
    const response = await handleHttpEvent({
      requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims } } },
      headers: options.headers, body: options.body,
    }, cfg);
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  const run = () => verifyRefresh({
    resourceUrl, tokenEndpoint, clientId, requiredScope, tokens: initial, fetchFn,
    persist: async tokens => { saved.push(tokens); },
    wait: async milliseconds => { assert.equal(milliseconds, 6000); graceEnded = true; },
  });
  return { run, saved, grants, calls };
}

test('refresh verifier rotates twice, preserves verified tool identity, and rejects a retired token', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { refreshes: 2, identityPreserved: true, toolCallsPassed: true, retiredTokenRejected: true });
  assert.deepEqual(f.saved.map(tokens => tokens.refresh_token), ['private-refresh-1', 'private-refresh-2']);
  assert.deepEqual(f.grants.map(form => form.get('refresh_token')), ['private-refresh-0', 'private-refresh-1', 'private-refresh-0']);
  assert.deepEqual(f.calls, Array(2).fill({ sub: originalClaims.sub, clientId }));
});

test('refresh verifier detects changed identity and authorization claims before invoking tools', async () => {
  for (const changedClaims of [
    { sub: 'another-user' }, { client_id: 'another-client' }, { iss: 'https://another-issuer.example' },
    { aud: 'https://another-resource.example' }, { scope: 'openid' }, { token_use: 'id' },
  ]) {
    const f = fixture({ changedClaims });
    await assert.rejects(f.run(), /identity, client, issuer, resource, or scope changed/);
    assert.equal(f.saved.length, 1, 'Preserve the new refresh token even if subsequent validation fails.');
    assert.equal(f.calls.length, 0);
  }
});

test('refresh verifier catches missing rotation, accepted replays, and cross-user tool results', async () => {
  await assert.rejects(fixture({ repeatRefresh: true }).run(), /rotated refresh token/);
  await assert.rejects(fixture({ replayAccepted: true }).run(), /not rejected after the grace period/);
  await assert.rejects(fixture({ wrongOwner: true }).run(), /own user's bookings/);
});

test('refresh failure diagnostics do not expose provider response bodies or credentials', async () => {
  await assert.rejects(fixture({ oauthFailure: true }).run(), error => {
    assert.equal(error.message, 'Refresh failed with HTTP 400.');
    assert.doesNotMatch(error.stack, /private-refresh|not-signed|private-fixture-user/);
    return true;
  });
});

test('rotated token responses replace the private file atomically with owner-only permissions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-refresh-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'tokens.json');
  await writeFile(filename, '{}', { mode: 0o644 });
  const tokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh' };
  await saveTokens(filename, tokens);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), tokens);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['tokens.json']);
});
