const transactionKey = 'bookings-mcp-oauth';
const lifetimeMs = 10 * 60 * 1000;

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function beginLogin(config, storage = sessionStorage) {
  const redirectUri = `${config.baseUrl}/callback`;
  if (!config.callbackUrls.includes(redirectUri)) {
    throw new Error('Register this page\'s /callback URL in callback_urls, then run terraform apply.');
  }
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  storage.setItem(transactionKey, JSON.stringify({ state, nonce, verifier, redirectUri, issuer: config.issuer, createdAt: Date.now() }));
  const url = new URL('/cognito/authorize', config.baseUrl);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri,
    scope: `openid email ${config.scope}`, resource: config.mcpUrl,
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  return url.href;
}

export function consumeCallback(params, storage = sessionStorage, now = Date.now()) {
  const saved = storage.getItem(transactionKey);
  storage.removeItem(transactionKey);
  const transaction = saved ? JSON.parse(saved) : null;
  if (!transaction || params.getAll('state').length !== 1 || params.get('state') !== transaction.state
    || !Number.isFinite(transaction.createdAt) || now - transaction.createdAt > lifetimeMs || now < transaction.createdAt) {
    throw new Error('This sign-in request expired or its state did not match. Start a new sign-in.');
  }
  if (params.getAll('iss').length > 1 || (params.has('iss') && params.get('iss') !== transaction.issuer)) {
    throw new Error('Cognito returned an unexpected authorization server. Start a new sign-in.');
  }
  if (params.has('error')) {
    throw new Error(`Cognito sign-in failed: ${params.get('error_description') ?? params.get('error')}`);
  }
  if (params.getAll('code').length !== 1 || !params.get('code')) {
    throw new Error('Cognito did not return an authorization code. Start a new sign-in.');
  }
  return { code: params.get('code'), nonce: transaction.nonce, verifier: transaction.verifier, redirectUri: transaction.redirectUri };
}

// The response comes from the configured HTTPS Cognito token endpoint. This
// checks the OIDC transaction nonce; the MCP server verifies bearer signatures.
export function checkNonce(idToken, nonce) {
  try {
    const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    if (JSON.parse(atob(payload)).nonce === nonce) return;
  } catch {
    // Missing or malformed ID tokens cannot complete an OIDC login.
  }
  throw new Error('Cognito returned an ID token with a missing or mismatched nonce. Start a new sign-in.');
}
