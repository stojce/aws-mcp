import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurationFromOutputs } from './config.mjs';
import { createLoginServer } from './server.mjs';

const cognitoAuthorization = 'https://example.auth.eu-west-1.amazoncognito.com/oauth2/authorize';
const cognitoToken = 'https://example.auth.eu-west-1.amazoncognito.com/oauth2/token';
const outputs = values => Object.fromEntries(Object.entries({
  mcp_url: 'https://example.cloudfront.net/mcp',
  mcp_app_client_id: 'mcp-client',
  required_scope: 'https://example.cloudfront.net/mcp/read',
  authorization_server_issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/example-pool',
  user_pool_id: 'example-pool',
  ...values,
}).map(([name, value]) => [name, { value }]));

test('local public endpoints never become the login helper upstreams', () => {
  const config = configurationFromOutputs(outputs({
    authorization_endpoint: 'http://localhost:8080/authorize',
    token_endpoint: 'http://localhost:8080/token',
    cognito_authorization_endpoint: cognitoAuthorization,
    cognito_token_endpoint: cognitoToken,
  }));
  assert.equal(config.authorizationEndpoint, cognitoAuthorization);
  assert.equal(config.tokenEndpoint, cognitoToken);
  assert.equal(config.issuer, 'https://cognito-idp.eu-west-1.amazonaws.com/example-pool');
  assert.doesNotThrow(() => createLoginServer(config));
});

test('login helper accepts Terraform state from before proxy discovery', () => {
  const config = configurationFromOutputs(outputs({
    authorization_endpoint: cognitoAuthorization,
    token_endpoint: cognitoToken,
  }));
  assert.equal(config.authorizationEndpoint, cognitoAuthorization);
  assert.equal(config.tokenEndpoint, cognitoToken);
});

test('incomplete upstream outputs fail instead of forwarding to the proxy itself', () => {
  assert.throws(() => configurationFromOutputs(outputs({
    authorization_endpoint: 'http://localhost:8080/authorize',
    token_endpoint: 'http://localhost:8080/token',
    cognito_authorization_endpoint: '',
    cognito_token_endpoint: cognitoToken,
  })), /Missing Terraform output cognito_authorization_endpoint/);
});
