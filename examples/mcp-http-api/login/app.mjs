import { beginLogin, consumeCallback, checkNonce } from './oauth.mjs';

const callback = location.pathname === '/callback' ? new URLSearchParams(location.search) : null;
// Remove authorization codes from the address bar before any further requests.
if (callback) history.replaceState({}, '', '/');

const status = document.querySelector('#status');
const signIn = document.querySelector('#sign-in');
const tokenActions = document.querySelector('#token-actions');
let config;
let tokens;

function message(text, isError = false) {
  status.textContent = text;
  status.toggleAttribute('data-error', isError);
}

async function exchange(params, nonce) {
  const response = await fetch('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? 'Cognito did not return an access token.');
  }
  if (nonce) checkNonce(data.id_token, nonce);
  tokens = { ...data, refresh_token: data.refresh_token ?? tokens?.refresh_token };
  document.querySelector('#access-token').value = tokens.access_token;
  document.querySelector('#refresh-token').hidden = !tokens.refresh_token;
  signIn.hidden = true;
  tokenActions.hidden = false;
  message('Signed in with Cognito.');
}

signIn.addEventListener('click', async (event) => {
  if (location.pathname === '/authorize' && config) return;
  event.preventDefault();
  if (!config) return;
  try {
    signIn.setAttribute('aria-disabled', 'true');
    message('Opening Cognito…');
    location.assign(await beginLogin(config));
  } catch (error) {
    signIn.removeAttribute('aria-disabled');
    message(error.message, true);
  }
});

document.querySelector('#copy-token').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(tokens.access_token);
    message('Access token copied.');
  } catch {
    document.querySelector('#token-actions details').open = true;
    document.querySelector('#access-token').select();
    message('Copy the selected access token.');
  }
});

document.querySelector('#refresh-token').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    message('Refreshing the Cognito session…');
    await exchange(new URLSearchParams({
      grant_type: 'refresh_token', client_id: config.clientId,
      refresh_token: tokens.refresh_token, resource: config.mcpUrl,
    }));
  } catch (error) {
    message(error.message, true);
  } finally {
    document.querySelector('#refresh-token').disabled = false;
  }
});

document.querySelector('#clear-token').addEventListener('click', () => {
  tokens = undefined;
  document.querySelector('#access-token').value = '';
  tokenActions.hidden = true;
  signIn.hidden = false;
  message('Token cleared from this page. Your Cognito browser session may still be active.');
});

try {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the deployed Cognito configuration.');
  config = await response.json();
  for (const [id, value] of Object.entries({
    'mcp-url': config.mcpUrl, 'client-id': config.clientId,
    scope: `openid email ${config.scope}`,
    'authorization-url': `${config.baseUrl}/authorize`, 'token-url': `${config.baseUrl}/token`,
  })) document.getElementById(id).value = value;
  signIn.removeAttribute('aria-disabled');
  message('');

  if (location.pathname === '/authorize') {
    signIn.href = `/cognito/authorize${location.search}`;
    document.querySelector('#login-heading').textContent = 'Continue your MCP sign-in';
    document.querySelector('#login-description').textContent = 'Sign in with Cognito to return to your MCP client.';
  }
  if (callback) {
    message('Completing Cognito sign-in…');
    const result = consumeCallback(callback);
    await exchange(new URLSearchParams({
      grant_type: 'authorization_code', client_id: config.clientId,
      redirect_uri: result.redirectUri, code: result.code,
      code_verifier: result.verifier, resource: config.mcpUrl,
    }), result.nonce);
  }
} catch (error) {
  message(error.message, true);
}
