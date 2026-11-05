import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const exampleDirectory = fileURLToPath(new URL('../', import.meta.url));

export function loadConfiguration() {
  let outputs;
  try {
    outputs = JSON.parse(execFileSync('terraform', ['output', '-json'], {
      cwd: exampleDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch {
    throw new Error('Cannot read Terraform outputs. Deploy examples/mcp-http-api with terraform apply first.');
  }

  return configurationFromOutputs(outputs);
}

export function configurationFromOutputs(outputs) {
  const read = (name) => {
    const value = outputs[name]?.value;
    if (typeof value !== 'string' || !value) {
      throw new Error(`Missing Terraform output ${name}. Run terraform apply in examples/mcp-http-api.`);
    }
    return value;
  };
  const issuer = read('authorization_server_issuer');
  return {
    mcpUrl: read('mcp_url'),
    clientId: read('mcp_app_client_id'),
    scope: read('required_scope'),
    issuer,
    // New public outputs may point back to this helper. Always forward to
    // Cognito; retain compatibility with states from before proxy discovery.
    authorizationEndpoint: read(outputs.cognito_authorization_endpoint ? 'cognito_authorization_endpoint' : 'authorization_endpoint'),
    tokenEndpoint: read(outputs.cognito_token_endpoint ? 'cognito_token_endpoint' : 'token_endpoint'),
    userPoolId: read('user_pool_id'),
    region: outputs.region?.value ?? new URL(issuer).hostname.split('.')[1],
    accountId: outputs.account_id?.value,
    // Older states lack this output. Use the updated example's loopback
    // allowlist; Cognito still checks its actual registered callbacks.
    callbackUrls: outputs.callback_urls?.value ?? [
      'http://localhost:8080/callback',
      'http://localhost:6274/oauth/callback',
      'http://localhost:6274/oauth/callback/debug',
      'http://127.0.0.1:6274/oauth/callback',
      'http://127.0.0.1:6274/oauth/callback/debug',
    ],
  };
}
