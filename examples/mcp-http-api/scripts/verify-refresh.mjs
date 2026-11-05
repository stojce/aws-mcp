import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Configure absolute MCP and token endpoint URLs.'); }
  requireValue(!url.username && !url.password && !url.search && !url.hash
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))),
  'Endpoints must use HTTPS, or HTTP on loopback for local tests, without credentials or query parameters.');
  return url.href;
}

function claims(token) {
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Do not include the token in parsing errors. */ }
  throw new Error('The access token must be a JWT.');
}

// Replace the complete token response atomically so an interrupted verification
// does not leave the caller with only a refresh token that was rotated out.
export async function saveTokens(filename, tokens) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(tokens), { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function verifyRefresh({
  resourceUrl, tokenEndpoint, clientId, requiredScope, tokens, persist,
  fetchFn = fetch, wait = delay,
}) {
  resourceUrl = endpoint(resourceUrl);
  tokenEndpoint = endpoint(tokenEndpoint);
  requireValue(typeof clientId === 'string' && clientId && typeof requiredScope === 'string' && requiredScope,
    'Configure the MCP client ID and required scope.');
  requireValue(typeof tokens?.access_token === 'string' && tokens.access_token
    && typeof tokens.refresh_token === 'string' && tokens.refresh_token, 'Supply a complete authorization-code token response.');
  requireValue(typeof persist === 'function', 'Configure private token persistence before testing rotation.');

  const original = claims(tokens.access_token);
  const bound = token => {
    const value = claims(token);
    requireValue(typeof value.sub === 'string' && value.sub && typeof value.iss === 'string' && value.iss
      && value.sub === original.sub && value.iss === original.iss && value.client_id === clientId
      && value.token_use === 'access' && (Array.isArray(value.aud) ? value.aud : [value.aud]).includes(resourceUrl)
      && typeof value.scope === 'string' && value.scope.split(/\s+/).includes(requiredScope),
    'Access-token identity, client, issuer, resource, or scope changed.');
  };
  bound(tokens.access_token);

  async function request(url, options) {
    let response;
    try {
      response = await fetchFn(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(35000) });
    } catch { throw new Error('The OAuth or MCP request failed; no credentials were logged.'); }
    let body;
    try { body = await response.json(); } catch { throw new Error('The OAuth or MCP response was not JSON.'); }
    return { status: response.status, body };
  }

  let id = 0;
  async function mcp(method, token) {
    const requestId = ++id;
    const { status, body } = await request(resourceUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': 'get_my_bookings' } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: requestId, method,
        params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
          ...(method === 'tools/call' ? { name: 'get_my_bookings', arguments: {} } : {}),
        },
      }),
    });
    requireValue(status === 200 && body?.jsonrpc === '2.0' && body.id === requestId
      && !body.error && body.result?.resultType === 'complete', 'MCP rejected the access token or returned an invalid response.');
    if (method === 'tools/call') {
      requireValue(body.result.isError === false && body.result.structuredContent?.owner === original.sub,
        'The refreshed token did not retrieve its own user\'s bookings.');
    } else {
      requireValue(body.result.tools?.some(tool => tool.name === 'get_my_bookings'), 'The bookings tool was not discoverable.');
    }
  }

  const refresh = token => request(tokenEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token, resource: resourceUrl }).toString(),
  });

  // JWT decoding above is only a comparison aid. MCP's authorizer must accept
  // the original and refreshed tokens before this verifier reports success.
  await mcp('tools/list', tokens.access_token);
  const retired = tokens.refresh_token;
  for (let round = 0; round < 2; round++) {
    const { status, body } = await refresh(tokens.refresh_token);
    requireValue(status === 200, `Refresh failed with HTTP ${status}.`);
    requireValue(typeof body?.access_token === 'string' && body.access_token
      && typeof body.refresh_token === 'string' && body.refresh_token && body.refresh_token !== tokens.refresh_token,
    'The token endpoint did not return a replacement access token and rotated refresh token.');
    tokens = { ...tokens, ...body };
    await persist(tokens);
    bound(tokens.access_token);
    await mcp('tools/list', tokens.access_token);
    await mcp('tools/call', tokens.access_token);
  }
  await wait(6000); // The example's Cognito retry grace period is five seconds.
  const replay = await refresh(retired);
  requireValue(replay.status === 400 && replay.body?.error === 'invalid_grant',
    'The retired refresh token was not rejected after the grace period.');
  return { refreshes: 2, identityPreserved: true, toolCallsPassed: true, retiredTokenRejected: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const filename = process.env.SMOKE_TOKENS_FILE;
    requireValue(filename, 'Set SMOKE_TOKENS_FILE to a private token-response JSON file outside the checkout.');
    const result = await verifyRefresh({
      resourceUrl: process.env.SMOKE_MCP_URL, tokenEndpoint: process.env.SMOKE_TOKEN_ENDPOINT,
      clientId: process.env.SMOKE_CLIENT_ID, requiredScope: process.env.SMOKE_REQUIRED_SCOPE,
      tokens: JSON.parse(await readFile(filename, 'utf8')),
      persist: tokens => saveTokens(filename, tokens),
    });
    console.log(`PASS  ${result.refreshes} refreshes preserve identity and tool access; retired token rejected`);
  } catch (error) {
    // Parsing and filesystem errors may contain private file content or paths.
    console.error(error instanceof SyntaxError || error.code ? 'FAIL  Could not read or save the private token response.' : `FAIL  ${error.message}`);
    process.exitCode = 1;
  }
}
