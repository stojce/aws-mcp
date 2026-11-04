import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadConfiguration } from './config.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/callback', ['index.html', 'text/html; charset=utf-8']],
  ['/authorize', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/oauth.mjs', ['oauth.mjs', 'text/javascript; charset=utf-8']],
  ['/geist.ttf', ['geist.ttf', 'font/ttf']],
]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function singleParameters(params) {
  for (const key of params.keys()) {
    requireValue(params.getAll(key).length === 1, `Duplicate OAuth parameter: ${key}`);
  }
}

export function authorizationParameters(params, config) {
  singleParameters(params);
  requireValue(params.get('client_id') === config.clientId, 'Use this example\'s Cognito client ID.');
  requireValue(params.get('response_type') === 'code', 'Only the authorization code flow is supported.');
  requireValue(config.callbackUrls.includes(params.get('redirect_uri')), 'Callback is not registered. Add it to callback_urls and run terraform apply.');
  requireValue(params.get('code_challenge_method') === 'S256'
    && /^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? ''), 'An S256 PKCE challenge is required.');
  requireValue(params.get('state')?.length > 0 && params.get('state').length <= 1024, 'OAuth state is required.');
  requireValue(!params.has('resource') || params.get('resource') === config.mcpUrl, 'Resource must be the deployed MCP URL.');
  const scopes = (params.get('scope') ?? '').split(/\s+/).filter(Boolean);
  requireValue(scopes.includes(config.scope)
    && scopes.every((scope) => ['openid', 'email', config.scope].includes(scope)), 'Request the MCP scope, with optional openid and email scopes.');
  const result = new URLSearchParams(params);
  result.set('resource', config.mcpUrl);
  return result;
}

export function inspectorConfiguration(config, baseUrl) {
  return {
    mcpServers: {
      'bookings-mcp': {
        type: 'streamable-http',
        url: config.mcpUrl,
        oauth: {
          clientId: config.clientId,
          scopes: `openid email ${config.scope}`,
          authorizationUrl: `${baseUrl}/authorize`,
          tokenUrl: `${baseUrl}/token`,
          // Cognito issues refresh tokens for code grants without offline_access.
          requestRefreshToken: false,
        },
      },
    },
  };
}

export function createLoginServer(config, { baseUrl = 'http://localhost:8080', fetchFn = fetch } = {}) {
  const base = new URL(baseUrl);
  requireValue(base.protocol === 'http:' && base.hostname === 'localhost', 'The testing server must use http://localhost.');
  requireValue(new URL(config.authorizationEndpoint).protocol === 'https:'
    && new URL(config.tokenEndpoint).protocol === 'https:', 'Cognito endpoints must use HTTPS.');
  const origins = new Set([base.origin, ...config.callbackUrls.map((url) => new URL(url).origin)]);

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    try {
      requireValue(req.headers.host === base.host, `Open the page at ${base.origin}.`);
      requireValue(!req.headers.origin || origins.has(req.headers.origin), 'Browser origin is not allowed.');
      if (req.headers.origin) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
      }
      requireValue(req.url.length <= 8192, 'Request URL is too long.');
      const url = new URL(req.url, base);

      if (req.method === 'OPTIONS' && url.pathname === '/token') {
        requireValue(req.headers['access-control-request-method'] === 'POST', 'Only POST is supported.');
        const headers = (req.headers['access-control-request-headers'] ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
        requireValue(headers.every((name) => ['content-type', 'accept'].includes(name)), 'Preflight header is not allowed.');
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Accept' });
        return res.end();
      }

      if (req.method === 'GET') {
        if (url.pathname === '/config.json') {
          return json(200, { ...config, baseUrl: base.origin });
        }
        if (url.pathname === '/inspector-config.json') {
          res.setHeader('Content-Disposition', 'attachment; filename="bookings-mcp-inspector.json"');
          return json(200, inspectorConfiguration(config, base.origin));
        }
        if (url.pathname === '/authorize' || url.pathname === '/cognito/authorize') {
          const params = authorizationParameters(url.searchParams, config);
          if (url.pathname === '/cognito/authorize') {
            const destination = new URL(config.authorizationEndpoint);
            destination.search = params.toString();
            res.writeHead(302, { Location: destination.href });
            return res.end();
          }
        }
        const asset = assets.get(url.pathname);
        if (asset) {
          let body = await readFile(new URL(asset[0], import.meta.url));
          if (url.pathname === '/authorize') {
            const href = `/cognito/authorize?${url.searchParams}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            body = body.toString('utf8').replace('href="#" aria-disabled="true"', `href="${href}"`);
          }
          res.writeHead(200, { 'Content-Type': asset[1] });
          return res.end(body);
        }
      }

      if (req.method === 'POST' && url.pathname === '/token') {
        requireValue(req.headers['content-type']?.split(';')[0] === 'application/x-www-form-urlencoded', 'Use a URL-encoded token request.');
        requireValue(!req.headers.authorization, 'This public client does not use a client secret.');
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          requireValue(size <= 16384, 'Token request is too large.');
          chunks.push(chunk);
        }
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        singleParameters(params);
        requireValue(params.get('client_id') === config.clientId, 'Use this example\'s Cognito client ID.');
        requireValue(!params.has('client_secret'), 'This public client does not use a client secret.');
        requireValue(!params.has('resource') || params.get('resource') === config.mcpUrl, 'Resource must be the deployed MCP URL.');
        const grant = params.get('grant_type');
        if (grant === 'authorization_code') {
          requireValue(config.callbackUrls.includes(params.get('redirect_uri')), 'Callback is not registered.');
          requireValue(params.get('code')?.length > 0, 'Authorization code is required.');
          requireValue(/^[A-Za-z0-9._~-]{43,128}$/.test(params.get('code_verifier') ?? ''), 'PKCE verifier is required.');
        } else {
          requireValue(grant === 'refresh_token' && params.get('refresh_token')?.length > 0, 'Only code and refresh-token grants are supported.');
        }
        params.set('resource', config.mcpUrl);
        const response = await fetchFn(config.tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: params.toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        return json(response.status, await response.json());
      }
      return json(404, { error: 'not_found', error_description: 'Route not found.' });
    } catch (error) {
      // No request, code, password, or token logging on this testing server.
      const networkError = error.name === 'TimeoutError' || error instanceof TypeError;
      return json(networkError ? 502 : 400, {
        error: networkError ? 'upstream_error' : 'invalid_request',
        error_description: networkError ? 'Cognito could not be reached. Try again.' : error.message,
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = Number(process.env.MCP_LOGIN_PORT ?? 8080);
    requireValue(Number.isInteger(port) && port >= 1 && port <= 65535, 'MCP_LOGIN_PORT must be a port from 1 to 65535.');
    const baseUrl = `http://localhost:${port}`;
    const server = createLoginServer(loadConfiguration(), { baseUrl });
    server.on('error', (error) => {
      console.error(`Cannot start login page: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Login page: ${baseUrl}`);
      console.log(`Inspector authorization URL: ${baseUrl}/authorize`);
      console.log(`Inspector token URL: ${baseUrl}/token`);
      console.log(`Inspector configuration: ${baseUrl}/inspector-config.json`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
