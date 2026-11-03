# Example: mcp-http-api

Deploys `modules/mcp-http-api` in a sandbox account with a Cognito pool and domain,
two test users, a DynamoDB bookings table, a tool backend Lambda, and the MCP
endpoint. The default authentication policy requires resource-bound access tokens.

## Deploy

Set `callback_urls` to the callbacks your MCP client actually uses. The default
is `http://localhost:8080/callback`; a client using that URL must listen there
before login. For a browser application, also configure its exact origin:

```hcl
callback_urls   = ["http://localhost:8080/callback"]
allowed_origins = ["http://localhost:8080"]
```

Native clients omit Origin and need no allowlist entry. Browser origins default
to an empty set and must be configured explicitly.

```bash
cd examples/mcp-http-api
terraform init
terraform plan
terraform apply
export TEST_PASSWORD_ALICE='...' TEST_PASSWORD_BOB='...'
./scripts/set-test-passwords.sh
```

Passwords are supplied through environment variables and never enter Terraform
state. Outputs include `mcp_url`, `mcp_app_client_id`, `required_scope`,
`authorization_endpoint`, `token_endpoint`, `resource_metadata_url`, and `user_subs`.

## Positive login and smoke test

Use the [complete authorization-code/PKCE flow](../../modules/mcp-http-api/README.md#authorization-code-and-pkce).
Supply the dedicated client ID to your MCP client and use a pre-registered callback;
this example has no dynamic client registration.

Read the endpoints and resource from Terraform:

```bash
MCP_URL="$(terraform output -raw mcp_url)"
MCP_CLIENT_ID="$(terraform output -raw mcp_app_client_id)"
MCP_SCOPE="$(terraform output -raw required_scope)"
MCP_AUTHORIZATION_ENDPOINT="$(terraform output -raw authorization_endpoint)"
MCP_TOKEN_ENDPOINT="$(terraform output -raw token_endpoint)"
```

Start the callback listener, generate and retain a PKCE verifier and random state,
then sign in as Alice or Bob at `MCP_AUTHORIZATION_ENDPOINT`. Request
`response_type=code`, `client_id=MCP_CLIENT_ID`, your exact `redirect_uri`,
`scope=openid email MCP_SCOPE`, `code_challenge_method=S256`, the verifier's
SHA-256 challenge, `state`, and **`resource=MCP_URL`**. URL-encode every value.

Validate the returned state before exchanging the code. POST a URL-encoded form
to `MCP_TOKEN_ENDPOINT` with `grant_type=authorization_code`, the same client ID
and redirect URI, the code, the original `code_verifier`, and **`resource=MCP_URL`**.
Use the returned `access_token`; the default requires `aud=MCP_URL` and the MCP
scope. Save tokens outside the checkout with permissions restricted to your user.

```bash
./scripts/smoke.sh --url "$MCP_URL" --client-id "$MCP_CLIENT_ID" --token-file /tmp/mcp-access.token
```

The smoke client checks resource audience locally, sends the negotiated
`MCP-Protocol-Version: 2025-06-18`, and verifies initialization, tool discovery,
and user-scoped calls. API Gateway still performs JWT signature verification.

For the optional scope-denial check, complete a second PKCE login with
`scope=openid email` and the same resource. Pass that resource-bound token with
`--noscope-token-file`; the native JWT authorizer should return HTTP 403.
A password-authentication token lacks resource binding and cannot serve as that
scope-only fixture under the strict default.

Refresh through `MCP_TOKEN_ENDPOINT` with `grant_type=refresh_token`, the client
ID, the current refresh token, and the same resource. Replace the returned refresh
token after every successful refresh. Rotation is enabled with a five-second retry
grace period and a fixed 30-day lifetime from the original sign-in.

## Local verification

Run from the repository root with Node.js 22 and Terraform 1.9+:

```bash
node --test modules/mcp-gateway/lambda/interceptor/index.test.js modules/mcp-http-api/lambda/mcp-server/runtime.test.mjs
terraform -chdir=modules/mcp-http-api test
node --test modules/mcp-http-api/tests/package-isolation.test.mjs
terraform -chdir=examples/mcp-http-api validate
bash -n examples/mcp-http-api/scripts/smoke.sh
```

Terraform tests mock AWS and deploy no resources. The archive regression uses
local data-source plans and saved-plan apply. See the
[review report](../../docs/review-mcp-http-api-2026-11-03.md) for recorded results.

## Live verification history

Earlier sandbox checks observed HTTP 401 without a bearer token and HTTP 403 for
missing scope under the earlier audience configuration. Direct backend invocations
checked Alice/Bob data scoping, and runtime probes rejected other-client tokens.
These checks do not prove the current resource-bound OAuth flow.

A positive call through the public URL using PKCE and `resource=MCP_URL`, browser
CORS through API Gateway/CloudFront, and refresh-token rotation have not been
verified against a newly deployed stack. The instructions above describe the
current configuration; local tests do not establish live interoperability.

## Notes

- `enable_password_auth_for_tests` defaults to `true` only in this sandbox example.
  It does not mint resource-bound MCP tokens; the standard password flow is useful
  for negative authentication tests. Keep it `false` outside sandboxes.
- The module's `allow_unbound_access_tokens` legacy option defaults to `false`.
- Passwords, access tokens, refresh tokens, state, and saved plans must stay out of commits.
- Review `terraform destroy` when the sandbox is no longer needed; it removes the
  example's pool, domain, and demo data.
