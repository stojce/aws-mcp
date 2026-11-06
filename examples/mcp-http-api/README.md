# Example: mcp-http-api

Composes `modules/cognito` and `modules/mcp-http-api` in a sandbox account with a
Cognito pool and domain, two test users, a DynamoDB bookings table, a tool backend
Lambda, and the MCP
endpoint. The default authentication policy requires resource-bound access tokens.

Requires Terraform 1.9+ and AWS provider 6.13.0+ for the managed-login branding
resource. The pool uses the Essentials feature plan and managed login version 2,
with a default branding style assigned to the MCP app client. Classic hosted UI
version 1 does not issue the resource audience required by the strict MCP policy.
The Cognito resource-server identifier is the canonical MCP URL, so the default
required scope is `<MCP_URL>/read`. Use the `required_scope` Terraform output.

The root calls both modules separately. Cognito receives the MCP URL to bind its
scope, and MCP receives Cognito's issuer, public client ID, and scope. Existing
resource addresses migrate through `moved.tf`; rerun `terraform init` and inspect
the plan before applying the extraction.

## Deploy

The deployed server uses Cognito managed login and its public token endpoint.
No local login page or token proxy needs to run. The default callback and CORS
lists contain hosted clients only. Claude hosted connectors use
`https://claude.ai/api/mcp/auth_callback`. mcptest.io uses
`https://mcptest.io/oauth/callback`, and its browser origin
`https://mcptest.io` is allowed by default. An override of `allowed_origins`
replaces the defaults; include every browser origin you intend to support.
For another client, configure its exact callback and browser origin:

```hcl
callback_urls   = ["https://agent.example.com/callback"]
allowed_origins = ["https://agent.example.com"]
```

Native clients omit Origin and need no allowlist entry. Register the exact
ChatGPT callback shown for your connection; adding a different shared callback
does not change ChatGPT's selected redirect URI. Password API authentication is
disabled by default; the test-only flag can enable it in a sandbox.

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

## Hosted OAuth and MCP clients

By default, the MCP endpoint publishes authorization-server metadata at
`/.well-known/oauth-authorization-server`, advertising `code_challenge_methods_supported:
["S256"]` and the public Cognito authorization and token endpoints. Protected-resource
metadata points to this document's issuer at the MCP origin. Cognito supports
S256 but omits it from its own discovery document, which strict clients reject.
The native JWT authorizer still verifies tokens against the Cognito issuer.

Leave `oauth_proxy_endpoints = null`, the default. Terraform builds both public
URLs from the deployed Cognito domain and writes the discovery document to the
Lambda environment variable `MCP_AUTHORIZATION_SERVER_METADATA`. The Lambda
reads this configuration at startup. Its archive contains the MCP runtime and
tool manifest; local login tooling and test HTTP servers are not included.
Endpoint overrides must use public HTTPS URLs. Terraform rejects HTTP and
loopback endpoint overrides, including HTTPS localhost addresses.

The legacy `local-oauth.tfvars.example` now sets `oauth_proxy_endpoints = null`.
Update any existing copy of `local-oauth.tfvars` to the same value before using
it again. Remove old localhost endpoint overrides in the MCP client and refresh
its cached discovery after deploying. The `authorization_endpoint` and
`token_endpoint` Terraform outputs show the URLs advertised to clients.

This supports hosted clients such as **Claude Settings → Connectors**. In Claude, choose **Use
your own OAuth client**, supply `mcp_app_client_id`, and leave the secret empty.
Cognito's registered callback includes `https://claude.ai/api/mcp/auth_callback`,
as required by [Claude's connector documentation](https://claude.com/docs/connectors/building/authentication#callback-urls).
After applying this callback change, start a new connection attempt; the old
`redirect_mismatch` error URL cannot resume the failed login.

For [mcptest.io](https://mcptest.io/learn/mcp-oauth-2-1-reference#pkce-s256-rfc-7636),
use `mcp_app_client_id` when prompted for a pre-registered public client. Its exact
callback, `https://mcptest.io/oauth/callback`, and browser origin,
`https://mcptest.io`, are configured by default. After applying changes, start a
fresh OAuth attempt so cached discovery and preflight results are not reused.
Metadata explicitly declares `client_id_metadata_document_supported: false`;
use the pre-registered client ID and an empty secret. A proxy-based transport
diagnostic marked **Not checked** does not establish a missing-header defect.
This server is stateless and does not issue `Mcp-Session-Id`.

The registration mode applies to all clients. Register callbacks exactly as
shown by each client, and configure browser origins separately. The following
table records configuration and verification limits for the report fixes; it
does not infer host compatibility from mcptest's successful connection.

| Client | Callback configuration | Verification for these changes |
| --- | --- | --- |
| mcptest 1.0.0 | `https://mcptest.io/oauth/callback`; origin `https://mcptest.io` | Local CORS/protocol regressions pass; a fresh direct-browser login and refresh await deployment |
| MCP Inspector | Explicitly register its exact callbacks and browser origin for local testing | Use the public Cognito endpoints; actual Inspector login needs a fresh live check |
| Claude hosted connector | `https://claude.ai/api/mcp/auth_callback` is in the defaults | Connector login and refresh have not been verified for these changes |
| ChatGPT | Register the exact callback displayed for this connector | Connector configuration and live verification are still needed |
| Cursor | Register the installed version's exact callback; use a fixed port when available | Client configuration and live verification are still needed |
| VS Code Copilot | Register the configured client's exact callback | Client configuration and live verification are still needed |
| Generic SDK | Choose and record SDK/version/runtime and its exact callback; allow its browser origin if applicable | Client configuration and live verification are still needed |

Resources, resource templates, prompts, tasks, subscriptions, sampling, and
elicitation are not used by this tool-only server. Discovery advertises tools
with `listChanged: false`; unimplemented methods return method-not-found.
Their absence is optional functionality, not a failed authorization flow.

### MCP Inspector

Register Inspector's exact callback URLs in `callback_urls` and its browser
origin in `allowed_origins` when testing from your machine. These client-side
callbacks are separate from the deployed authorization and token endpoints.

In **Server Settings → OAuth Settings**, use `mcp_app_client_id`, an empty client
secret, and `openid email <required_scope>`. Clear any localhost authorization
or token URL override. Use discovery or copy the public `authorization_endpoint`
and `token_endpoint` Terraform outputs. Disable **Request refresh token**:
Cognito returns a refresh token for the code grant without the `offline_access`
scope. The client must send S256 PKCE and `resource=mcp_url` during authorization
and token exchange. A client that omits the resource parameter will not obtain
the resource-bound token this deployment requires.

### Inspector reports unsupported dynamic client registration

`Incompatible auth server: does not support dynamic client registration` means
Inspector is attempting to create an OAuth client. Cognito has no dynamic client
registration endpoint; use the existing `mcp_app_client_id` Terraform output in
Inspector's **Client ID** field, with an empty client secret.

If Inspector logs `Stripping Inspector-extension keys` with
`smuggledKeys: [ 'oauth' ]`, its `/api/servers` request discarded the OAuth
configuration, including that client ID. A `mcpServers` document is a complete
configuration file for `--config`; pasting its server entry into a per-server
transport configuration editor can discard the `oauth` block. Set the
OAuth fields through **Server Settings → OAuth Settings**, save, and reconnect.

For integrations using Inspector's server API, send transport fields in `config`
and OAuth fields in the separate top-level `settings` object:
`oauthClientId`, `oauthScopes`, `oauthAuthorizationUrl`, `oauthTokenUrl`, and
`oauthRequestRefreshToken: false`. Preserve the other settings required by that
API, including headers, metadata, and timeouts. Nested `config.oauth` is stripped.

### Unsloth callback ports

[Unsloth's MCP client](https://github.com/unslothai/unsloth/blob/main/studio/backend/core/inference/mcp_client.py)
uses FastMCP OAuth with a pre-registered client ID but leaves `callback_port`
unset. FastMCP chooses a random `http://localhost:<port>/callback` on each new
OAuth client instance. Cognito requires an exact registered callback and does
not accept a wildcard port. Unsloth needs a fixed callback port registered
in `callback_urls`, or an OAuth broker that supports dynamic loopback callbacks.
For manual token inspection, the [optional local test page](login/README.md)
can obtain an access token for a client that supports bearer-token headers.
It has no role in serving production discovery or authenticating hosted clients.

### Create a test user

Terraform creates `alice@example.com` and `bob@example.com`; their passwords are
set separately with `scripts/set-test-passwords.sh`. Cognito cannot return an
existing user's password. To create a separate confirmed test user without
changing Alice or Bob's password, use an AWS profile for the deployed account:

```bash
AWS_PROFILE=your-sandbox-profile node scripts/create-test-user.mjs
```

The script creates `inspector@example.com`, sets a random permanent password,
and prints the username and password once it confirms the user. It suppresses
email delivery and uses a private temporary file for the password, removed on
exit. Passwords do not enter source or Terraform state. To choose another user
or supply a password, set `TEST_USER_EMAIL` and optionally `TEST_USER_PASSWORD`.
The script refuses to reset a confirmed existing user. This extra test user is
created outside Terraform and has no seeded bookings; `get_my_bookings` returns
an empty list. Use Alice or Bob to test the seeded booking ownership checks.

## Positive login and smoke test

Use the [complete authorization-code/PKCE flow](../../modules/mcp-http-api/README.md#authorization-code-and-pkce).
Supply the dedicated client ID to your MCP client and use a pre-registered callback;
this example has no dynamic client registration.

For a direct Cognito smoke login, read the upstream endpoints and resource from Terraform:

```bash
MCP_URL="$(terraform output -raw mcp_url)"
MCP_CLIENT_ID="$(terraform output -raw mcp_app_client_id)"
MCP_SCOPE="$(terraform output -raw required_scope)"
MCP_AUTHORIZATION_ENDPOINT="$(terraform output -raw cognito_authorization_endpoint)"
MCP_TOKEN_ENDPOINT="$(terraform output -raw cognito_token_endpoint)"
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
./scripts/smoke.sh --url "$MCP_URL" --client-id "$MCP_CLIENT_ID" \
  --scope "$MCP_SCOPE" --token-file /tmp/mcp-access.token --origin https://mcptest.io
```

The smoke client checks resource audience locally, sends
`MCP-Protocol-Version: 2026-07-28`, matching method/name headers, and required
per-request metadata. It checks public preflight, readable OAuth discovery,
schema constraints and property descriptions, user-scoped calls, stateless
modern and legacy requests, and the unimplemented optional methods. API Gateway
performs JWT signature verification. Logs contain assertion names instead of
token claims or response bodies.

Use `--other-token-file /tmp/mcp-other-access.token` with a different sandbox
user to check separate booking results. Add `--samples 30` for direct tools/list
p50/p95 measurements; these include network time and do not classify cold starts.
The script uses curl, so browser CORS enforcement and mcptest negotiation timing
still need a direct-browser evaluation after deployment. Omit `--origin` to test
a native client; use `--negative-only --origin https://mcptest.io` for public
CORS/discovery and denial checks without a valid token.

The module-managed metadata advertises Cognito's S256 support and points to
public Cognito endpoints by default. Cognito's own discovery omits that field.
The optional local helper has separate endpoints for clients on your machine.
The module also supports an
[external authorization server](../../modules/mcp-http-api/README.md#external-authorization-servers)
with its own registration and discovery contract.
The smoke client accepts `--authorization-mode external --client-id-claim azp`
for a provider using `azp`, along with the external endpoint, client ID, scope,
and token-file flags.

For the optional scope-denial check, complete a second PKCE login with
`scope=openid email` and the same resource. Pass that resource-bound token with
`--noscope-token-file`; the native JWT authorizer should return HTTP 403.
A password-authentication token lacks resource binding and cannot serve as that
scope-only fixture under the strict default.

Refresh through `MCP_TOKEN_ENDPOINT` with `grant_type=refresh_token`, the client
ID, the current refresh token, and the same resource. Replace the returned refresh
token after every successful refresh. Rotation is enabled with a five-second retry
grace period and a fixed 30-day lifetime from the original sign-in.

To verify rotation and continued MCP access, save the complete authorization-code
token response (`access_token` and `refresh_token`) in a private JSON file outside
the checkout. With a fresh sandbox session, run from this example directory:

```bash
SMOKE_MCP_URL="$MCP_URL" \
SMOKE_CLIENT_ID="$MCP_CLIENT_ID" \
SMOKE_REQUIRED_SCOPE="$MCP_SCOPE" \
SMOKE_TOKEN_ENDPOINT="$(terraform output -raw token_endpoint)" \
SMOKE_TOKENS_FILE=/tmp/mcp-tokens.json \
node scripts/verify-refresh.mjs
```

This performs two refreshes, verifies the issuer/subject/client/resource/scope
and successful tool calls, waits beyond the five-second grace period, and checks
that the retired refresh token is rejected. Each successful token response
atomically replaces the same JSON file with owner-only permissions, including
when a later check fails. Use its latest tokens for subsequent requests. The
checker prints no credentials or provider response bodies; its success proves
the tested token flow, not another host's login or callback behavior.

## Local verification

Run from the repository root with Node.js 22 and Terraform 1.9+:

```bash
node --test modules/mcp-gateway/lambda/interceptor/index.test.js modules/mcp-http-api/lambda/mcp-server/*.test.mjs
node --test examples/mcp-http-api/login/*.test.mjs examples/mcp-http-api/scripts/*.test.mjs
terraform -chdir=modules/mcp-http-api test
terraform -chdir=examples/mcp-http-api test
node --test modules/mcp-http-api/tests/package-isolation.test.mjs
terraform -chdir=modules/mcp-http-api validate
terraform -chdir=examples/mcp-http-api validate
terraform fmt -check -recursive
bash -n examples/mcp-http-api/scripts/smoke.sh
```

Terraform tests mock AWS and deploy no resources. The archive regression uses
local data-source plans and saved-plan apply. Smoke tests run the real MCP
runtime behind a loopback-only fixture with a simulated native JWT boundary;
refresh tests simulate the OAuth provider and exercise real MCP tool dispatch.
They cover denial paths and deliberately broken CORS, schema, session, and
identity behavior. See the
[review report](../../docs/review-mcp-http-api-2026-11-03.md) for recorded results.

## Live verification history

Earlier sandbox checks observed HTTP 401 without a bearer token and HTTP 403 for
missing scope under the earlier audience configuration. Direct backend invocations
checked Alice/Bob data scoping, and runtime probes rejected other-client tokens.
These checks do not prove the current resource-bound OAuth flow.

On 2026-11-04, the local login page authenticated a confirmed
`inspector@example.com` test user against the existing Cognito pool using S256
PKCE, single-use state, and an OIDC nonce. The access token's `aud` matched
`mcp_url`; `tools/list` and `get_my_bookings` succeeded through the public MCP
endpoint. The booking response contained the test user's own subject and an
empty bookings list. Refresh returned a new refresh token, and the refreshed
access token was accepted by MCP.

A second browser login used the local `/authorize` page and Inspector's
registered `http://localhost:6274/oauth/callback`. An isolated browser captured
the callback, verified the original state, exchanged the code with the original
PKCE verifier through `/token`, and successfully listed MCP tools. This check
captured the callback without running Inspector's UI workflow. Browser CORS
through API Gateway/CloudFront remains unverified; the successful MCP requests
used a Node.js HTTP client. Local verification passed 9 login tests, 90 existing
runtime tests, Terraform example validation, and the responsive layout checks.
At that time, the repository-wide formatting check reported the then-existing
`examples/customer-assistant/variables.tf` and `modules/mcp-gateway/variables.tf`;
the changed example files passed formatting.

On 2026-11-05, the report fixes and additional verification scripts passed local
regression tests, mocked Terraform tests, validation, and recursive formatting.
The [implementation record](../../docs/plan-mcptest-remediation-2026-11-05.md)
lists the results and remaining live checks. Deployment was deferred at the
user's request; this does not establish a new mcptest score or fresh hosted-client
compatibility results.

## Notes

- `enable_password_auth_for_tests` defaults to `false`; enable it only for explicit sandbox tests.
  It does not mint resource-bound MCP tokens; the standard password flow is useful
  for negative authentication tests. Keep it `false` outside sandboxes.
- The module's `allow_unbound_access_tokens` legacy option defaults to `false`.
- Passwords, access tokens, refresh tokens, state, and saved plans must stay out of commits.
- Review `terraform destroy` when the sandbox is no longer needed; it removes the
  example's pool, domain, and demo data.
