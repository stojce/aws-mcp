# mcp-http-api

Option B from the design review: a public MCP endpoint built on the **native
API Gateway HTTP API JWT authorizer** and a small MCP server Lambda. Supports
MCP `2026-07-28` and legacy `2025-06-18`, with Cognito or an existing
external OAuth/OIDC authorization server.

## What it creates

| Resource | Purpose |
|---|---|
| `aws_cognito_resource_server` | Cognito mode only: resource server identified by `mcp_url`; the default scope is `<mcp_url>/read` |
| `aws_cognito_user_pool_client` | Cognito mode only: dedicated public PKCE client |
| `aws_apigatewayv2_api` + authorizer + `ANY /mcp` route | Edge JWT check enforcing the fully qualified `required_scope` |
| `aws_lambda_function` (MCP server) | JSON-RPC over Streamable HTTP; invokes the tool backend |
| IAM role | `lambda:InvokeFunction` on `tool_backend_arn` only |

The tool backend is an input. Cognito mode also requires an existing user pool;
external mode uses an existing authorization server and registered MCP client.

Requires Terraform 1.9+ and `hashicorp/aws >= 6.0.0, < 7.0.0`. The supporting
example requires AWS provider 6.13.0+ for managed-login branding. AWS provider v5
is unsupported: the Cognito issuer uses the `aws_region.region` attribute
introduced in v6.

## Request path

1. Client sends `Authorization: Bearer <access token>` from the dedicated MCP client.
2. API Gateway validates signature, issuer, audience (= canonical `mcp_url`), expiry,
   and that the token carries `required_scope` (`<mcp_url>/read` by default). Failures return 401/403 here.
3. The MCP Lambda validates supplied Origin headers and re-checks the configured
   client claim, resource audience, `required_scope`, and `sub`. Cognito also
   requires `token_use=access`; external providers can require their own marker.
4. `tools/call` validates arguments against the advertised input schema, then
   invokes the tool backend with `{ tool, arguments, identity: { sub, clientId } }`.
   `identity` comes only from the verified token. Client arguments cannot set it.

## Usage

```hcl
module "mcp" {
  source           = "../../modules/mcp-http-api"
  name             = "bookings"
  user_pool_id     = var.user_pool_id
  tool_backend_arn = aws_lambda_function.backend.arn
  server_name      = "bookings-mcp"
  callback_urls    = ["https://agent.example.com/callback"]

  tools = [{
    name         = "get_my_bookings"
    description  = "List the signed-in user's bookings."
    input_schema = jsonencode({ type = "object", properties = {}, required = [] })
  }]
}
```

The tool backend must scope every read by `event.identity.sub`.

## External authorization servers

Configure `external_authorization_server` and omit `user_pool_id`. The module
creates no Cognito resources in this mode; register the client and its exact
callbacks with your provider separately.

```hcl
module "mcp" {
  source           = "../../modules/mcp-http-api"
  name             = "bookings"
  tool_backend_arn = var.tool_backend_arn
  server_name      = "bookings-mcp"
  tools            = var.tools

  external_authorization_server = {
    issuer          = "https://identity.example.com/realms/app"
    client_id       = "bookings-mcp-client"
    required_scope  = "bookings:read"
    client_id_claim = "azp"
    # Optional: require a provider-defined payload claim on access tokens.
    # access_token_claim = { name = "kind", value = "access" }
  }
}
```

The provider must support the [MCP authorization requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
authorization code with S256 PKCE advertised in discovery, resource indicators,
and resource-bound access tokens. API Gateway requires publicly discoverable
issuer metadata/JWKS and currently supports RSA signing algorithms. Configure
access tokens with a single string `aud` equal to the exact `mcp_url` output,
including `/mcp`. Register that resource and the required scope with the provider.
Always request `resource=mcp_url` during authorization and token exchange.

`client_id_claim` defaults to `client_id`; use `azp` or your provider's
verified client claim when appropriate. The Lambda requires that claim to equal
`client_id` and requires the issuer and user `sub` on each request. It uses
API Gateway's verified `jwt.scopes` array; direct runtime callers can supply
`scope` or `scp`. External mode always requires resource binding, including
when legacy MCP `2025-06-18` is selected.

If `access_token_claim` is configured, its named payload claim must equal the
configured value. Otherwise the provider must reserve this resource audience and
scope for access tokens. API Gateway does not distinguish ID tokens automatically,
and the JWT header `typ` is unavailable in its claim map. A supplied
`token_use: "id"` is rejected. The runtime does not fetch or reinterpret the
provider's tokens. See [AWS's JWT authorizer contract](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

The backend still receives `identity: { sub, clientId }`. External subjects belong
to that issuer; map them to your application's users if existing data uses Cognito
subjects. One issuer is configured per endpoint.

Terraform moves preserve the existing Cognito resource addresses on upgrade.
Switching an existing module instance to external mode plans deletion of its
module-owned Cognito client and resource server and changes the JWT issuer.
Inspect that plan and migrate subjects and clients before applying it; a separate
endpoint allows a gradual transition.

The example Cognito pool's public discovery document was checked on 2026-11-04
and omitted `code_challenge_methods_supported`. Strict MCP OAuth clients must
refuse that discovery response even though Cognito supports S256 authorization.
Use a compliant external server for those clients. The
[protocol research](../../.scratch/mcp-on-aws/mcp-http-api-2026-07-28-protocol-research.md)
records the source requirements and provider observation.

## Authorization code and PKCE

In Cognito mode, use the public app client returned as `mcp_app_client_id`. Pre-register
the MCP client's exact redirect URI in `callback_urls` and supply that client ID
to the MCP software. This module does not provide dynamic client registration.
The existing pool must use Cognito managed login (domain version 2), an Essentials
or Plus feature plan, and a branding style assigned to this app client. Resource
binding requires managed login; the classic hosted UI (version 1) issues access
tokens without `aud` even when `resource` reaches the login request. API-created
domains do not automatically assign a branding style. The supporting example
configures the domain and app-client branding.

Cognito also requires requested custom scopes to belong to the resource being
requested. The resource-server identifier therefore defaults to the exact
`mcp_url`, and `required_scope` defaults to `<mcp_url>/read`. Always use the
`required_scope` output; a scope such as `mcp/read` belongs to a different resource
and cannot be requested with `resource=mcp_url` in managed login.

The initial 401 response advertises `resource_metadata_url` in `WWW-Authenticate`.
That public metadata identifies `mcp_url` as the protected resource and
`authorization_server_issuer` as its authorization server. Read the issuer's
`/.well-known/openid-configuration` to find the authorization and token endpoints.
The example also exposes these endpoints as Terraform outputs.

The default requires an access token with `aud` equal to the exact `mcp_url`,
including `/mcp`. Use that URL as the OAuth `resource` in authorization **and**
token requests. The API Gateway execution URL and the Cognito client ID are
different identifiers and do not satisfy the default resource-audience check.

1. Start the client's registered callback listener. Generate a random PKCE
   `code_verifier` (43–128 unreserved characters) and a random `state`, and retain
   both privately until the callback. Compute the challenge as the unpadded
   base64url encoding of the verifier's SHA-256 digest.
2. Open the authorization endpoint with these query parameters and sign in.
   The blocks below show decoded values; build queries and forms with a URL
   encoder, such as `URLSearchParams`, encoding each value once.

   ```text
   response_type=code
   client_id=<mcp_app_client_id>
   redirect_uri=<registered callback URL>
   scope=openid email <required_scope>
   code_challenge_method=S256
   code_challenge=<base64url SHA-256 challenge>
   state=<random state>
   resource=<mcp_url>
   ```

3. On the callback, require the returned `state` to match the stored value before
   using the authorization `code`. Reject an error response or a mismatched state.
   If `iss` is present, it must equal `authorization_server_issuer`. Require it
   when discovery advertises `authorization_response_iss_parameter_supported: true`.
4. POST an `application/x-www-form-urlencoded` body to the token endpoint:

   ```text
   grant_type=authorization_code
   client_id=<mcp_app_client_id>
   redirect_uri=<same registered callback URL>
   code=<authorization code from the validated callback>
   code_verifier=<original verifier>
   resource=<same mcp_url>
   ```

   This is a public client, so the exchange has no client secret. Cognito binds
   the resulting access token using the resource requested during authorization.
5. Use the response's `access_token` as the bearer token. Its `client_id` must
   identify this app client, `token_use` must be `access`, `aud` must contain
   `mcp_url`, and `scope` must contain `required_scope`. API Gateway verifies the
   signature, issuer, and expiry; the Lambda preserves the verified user's `sub`.
6. For MCP `2026-07-28`, call `server/discover` optionally, then `tools/list`
   or `tools/call` directly. Every request carries protocol and capability
   metadata and matching HTTP headers as described below. Legacy clients use
   `initialize` and `notifications/initialized` with `2025-06-18`.

## Refresh tokens

The client enables refresh-token rotation and token revocation. Refresh before
the access token expires by POSTing this form to the same OAuth token endpoint:

```text
grant_type=refresh_token
client_id=<mcp_app_client_id>
refresh_token=<current refresh token>
resource=<same mcp_url>
```

Store the returned access token and replace the old refresh token with the new
`refresh_token` together. Serialize refreshes so concurrent responses cannot
overwrite the newest token. The rotated-out token has a five-second retry grace
period. Rotation retains the original 30-day validity window; sign in again
when that window expires. Cognito preserves the original resource binding in
refreshed access tokens.

`ALLOW_REFRESH_TOKEN_AUTH` is disabled because it is incompatible with rotation.
For API integrations, Cognito's replacement is `GetTokensFromRefreshToken`.
The explicit SRP sign-in flow keeps Cognito from restoring its default legacy
refresh flow. Standard API sign-in does not grant the OAuth custom MCP scope or
resource binding. `ALLOW_USER_PASSWORD_AUTH` remains a sandbox-only opt-in.
Keep tokens and the PKCE verifier outside commits and logs.

## Legacy token compatibility

`allow_unbound_access_tokens = false` is the default. With an explicit `true`,
the JWT authorizer also permits the MCP app client's `client_id` fallback when
`aud` is absent, and the Lambda accepts that unbound access token if the client,
scope, and user identity are valid. Use this option only for migrating a legacy
client. Tokens with a supplied audience for another resource, including the
client ID, remain rejected by the Lambda in both modes.

## Protocol version

The endpoint supports MCP `2026-07-28` and legacy `2025-06-18`. The
[versioned schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)
and [HTTP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
define the modern wire contract.

Modern clients can call tools immediately; there is no initialization handshake
or protocol session. Optional `server/discover` returns `supportedVersions`
and the actual server capabilities (`tools`, with `listChanged: false`).
Every request requires `params._meta` containing
`io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities`. An empty capability object is
valid. Optional `io.modelcontextprotocol/clientInfo` identifies client software;
it never establishes user identity.

Send `MCP-Protocol-Version: 2026-07-28` and `Mcp-Method` matching the JSON-RPC
method on every modern request. `tools/call` also requires `Mcp-Name` matching
`params.name`. For example:

```http
POST /mcp HTTP/1.1
Authorization: Bearer <access token>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_my_bookings

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_my_bookings",
    "arguments": {},
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Header names are case-insensitive; values must match exactly. For `Mcp-Name`
and configured `Mcp-Param-*` headers, encode unsafe values as
`=?base64?<Base64 of UTF-8 value>?=`. This includes non-ASCII, control characters,
leading/trailing whitespace, and literal values matching that sentinel pattern.
The server decodes the value before comparison.

Every modern result includes `resultType: "complete"` and server information in
`result._meta["io.modelcontextprotocol/serverInfo"]`. Discovery and tool-list
results also include `ttlMs: 0` and `cacheScope: "private"`. Successful tool
calls include the backend's JSON value in `structuredContent` and serialize the
same value into text content. Tool execution and schema-validation errors remain
complete results with `isError: true`.

| Modern request failure | HTTP status | JSON-RPC code |
| --- | --- | --- |
| Missing or invalid required metadata; malformed call fields | 400 | `-32602` |
| Missing, malformed, ambiguous, or mismatched mirrored headers | 400 | `-32020` |
| Unsupported version | 400 | `-32022`, with `data.supported` and `data.requested` |
| Unimplemented method, including modern `initialize` and `ping` | 404 | `-32601` |
| Invalid JSON or JSON-RPC envelope, response, or batch | 400 | `-32700` or `-32600` |

Legacy `initialize` selects `2025-06-18`, including when the client requests
another version; modern semantics cannot be negotiated through that handshake.
Initialization may omit `MCP-Protocol-Version`. Subsequent legacy requests and
notifications must send `MCP-Protocol-Version: 2025-06-18`. Their original
initialization, ping, tool-result, and notification behavior remains available.
Missing version headers after initialization receive HTTP 400; the older
`2025-03-26` fallback is not supported. Public OAuth metadata requires no
protocol headers.

Request IDs must be strings or integers in JavaScript's safe range; use a string
for larger numeric identifiers. Null, fractional, and object IDs are rejected.
Known request methods require an ID; notifications have none and receive HTTP 202
with an empty body. Modern errors preserve readable IDs and omit unreadable IDs.
Client JSON-RPC responses are rejected because the server issues no independent
requests to clients. Session and event replay headers are ignored; GET and DELETE
return HTTP 405 after authentication.

## Browser origins and CORS

Configure the exact origins of trusted browser applications:

```hcl
allowed_origins = ["https://agent.example.com", "http://localhost:8080"]
```

Use canonical origins containing only scheme, host, and an optional non-default
port. Paths, credentials, wildcards, and opaque origins such as `null` are
rejected. Register the complete callback URL separately in `callback_urls`.
The default empty allowlist rejects every supplied Origin header. Native MCP
clients may omit Origin and continue using bearer authentication.

The same allowlist drives Lambda Origin validation, API Gateway CORS, and the
CloudFront response policy. GET, POST, and OPTIONS and the `Authorization`,
`Content-Type`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and `Accept`
headers are allowed. Configured `Mcp-Param-*` headers are added automatically.
`WWW-Authenticate` is exposed so trusted browsers can discover the OAuth server,
including when the native JWT authorizer rejects a request before Lambda runs.
Preflight OPTIONS routes and OAuth metadata are public; ordinary MCP requests
still require JWT and the MCP scope. CORS does not enable cookie credentials.

## Tool input validation

Each `input_schema` must be a JSON Schema object with `type: "object"`.
Schemas without `$schema` use JSON Schema 2020-12. Explicit dialects supported
are `https://json-schema.org/draft/2020-12/schema` and
`http://json-schema.org/draft-07/schema#`. Ajv validates the full schema, including
nested objects and arrays, references, composition, enums, bounds, and additional
properties. Standard formats supplied by `ajv-formats` are enforced.

All tool schemas compile at Lambda startup, before initialization or tool listing.
Malformed definitions, unknown keywords or formats, unsupported dialects,
unresolved references, and asynchronous schemas fail startup. References must
resolve within the tool's schema; the server does not fetch remote schemas.
Each tool has its own schema namespace, so tools can reuse the same `$id`.

MCP `2026-07-28` permits `x-mcp-header` annotations, for example
`{ type: "string", "x-mcp-header": "Region" }` on a property. Names must be
nonempty HTTP tokens and unique ignoring case. Only string, integer, and boolean
properties reached solely through `properties` are supported, including nested
objects. Annotations inside references, arrays, composition, or conditionals fail
startup. Annotated integers must stay in JavaScript's safe range. Modern calls
must mirror each supplied non-null value in `Mcp-Param-<name>`; missing/null
values omit the header. Missing or mismatched recognized headers receive
`-32020` before backend invocation. Legacy calls do not require these headers.

Invalid arguments return a tool result with `isError: true` and never invoke the
backend. Validation does not coerce types, insert defaults, or strip extra fields.
Omitted arguments are validated as `{}`; explicit `null` and other non-object
arguments are rejected (modern `-32602`; legacy tool error). Valid arguments reach the backend unchanged, alongside
identity derived from the verified token.

The validator bundle and license notices are checked in and included in the
Terraform archive. Deployments and runtime tests need no npm installation.
To update the bundle, edit `validation/schema-validator.mjs` or the pinned
dependencies in `validation/package.json`, refresh the lockfile if needed, then:

```bash
cd modules/mcp-http-api/validation
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

Commit the generated `lambda/mcp-server/schema-validator.mjs` and license notices
with their source and lockfile. Run the repository Node suites and package
isolation test after rebuilding.

## Shared Cognito pools

When `resource_server_identifier` is unset (`null`), each module instance uses
its generated `mcp_url` as its identifier. Separate endpoints therefore own
distinct resource servers even in the same pool, including a pool where the
sibling `mcp-gateway` module already owns `mcp`. Only one Terraform resource may
own each pool/identifier pair; the module creates its own resource server and
does not adopt another owner's resource.

The default `scope_name = "read"` produces `<mcp_url>/read`. The app client's
allowed scopes, API route, Lambda checks, and protected-resource metadata use
that value. Clients must request the `required_scope` output;
`mcp_resource_server_identifier` exposes the identifier itself. The static
CloudFront authentication challenge links to metadata where clients discover
the scopes; putting the URL-derived scope in that policy would create a
Terraform dependency cycle.

Strict resource binding rejects an override that differs from `mcp_url`.
To preserve an existing short identifier during a legacy migration, configure
both inputs explicitly:

```hcl
resource_server_identifier = "mcp-bookings"
allow_unbound_access_tokens = true
```

This produces the legacy `mcp-bookings/read` scope and permits unbound access
tokens from the dedicated MCP client. Identifiers accept 1–256 printable ASCII
characters except spaces, double quotes, and backslashes.

Upgrading a deployment that previously used the default `mcp` identifier
replaces that resource server with the canonical URL identifier. Terraform
creates the new resource server and migrates the app client's scopes before
deleting the old one. Clients must request the new `required_scope` and obtain
new access tokens; existing `mcp/read` tokens cannot satisfy the new scope.

The shared-pool regression tests use mocked providers and deploy no AWS resources:

```bash
terraform -chdir=modules/mcp-http-api init -backend=false
terraform -chdir=modules/mcp-http-api test -filter=tests/resource-server.tftest.hcl
```

## Lambda packages

Each instance writes its generated ZIP under
`${path.root}/.terraform/mcp-http-api/<name>-<source-hash>.zip`. The hash covers
`tools.json`, `index.mjs`, `runtime.mjs`, the validator bundle, and its license
notices, so different instances and changed manifests or code keep separate
artifacts. The module source directory is only read during packaging.

Keep the generated ZIPs until their saved plans have been applied. When planning
and applying in separate workspaces, transfer the referenced ZIPs with the plan
and preserve their relative paths.

The packaging regression test requires Terraform 1.9+, Node.js 22+, and `unzip`.
It reuses providers installed in this module (or `MCP_TERRAFORM_PLUGIN_DIR`),
otherwise installs them normally. Run it from the repository root:

```bash
node --test modules/mcp-http-api/tests/package-isolation.test.mjs
```

The test targets only the real archive data sources in two module instances
sharing one copied source directory. It checks ZIP contents and hashes,
an intervening manifest change, saved-plan apply, and changes to every packaged
source file. It requires no AWS credentials and deploys no AWS resources.
It also executes the extracted runtime without development dependencies, checking
argument validation and identity propagation from the packaged code.
The entrypoint check uses a local AWS SDK stub to verify both protocol versions,
Cognito and external identity propagation, Origin enforcement, public preflight,
request IDs, response status, deadline handling, and SDK abort signals without
credentials or AWS requests.

Run the runtime suites and Terraform mock tests from the repository root:

```bash
node --test modules/mcp-gateway/lambda/interceptor/index.test.js modules/mcp-http-api/lambda/mcp-server/*.test.mjs
terraform -chdir=modules/mcp-http-api test
```

## Limits

- Stateless: no server-initiated messages, no SSE stream (`GET /mcp` returns 405).
- One JSON response per POST; JSON-RPC batches are rejected (removed in protocol 2025-06-18).
- Only tools are exposed. No resources or prompts.
- HTTP API has a 30-second maximum integration timeout; see the deadline budget below.
- `enable_password_auth_for_tests` must stay `false` outside sandboxes.

## Tool deadlines

`lambda_timeout_s` accepts integers from 3 to 31 and defaults to 29. The HTTP
integration deadline is one second shorter (28 seconds by default), and tool
waiting ends another second earlier (27 seconds by default). At the maximum,
the integration uses the HTTP API's 30-second quota and tool waiting lasts at
most 29 seconds.

The tool deadline starts at API Gateway's request timestamp, so authorization,
cold starts, schema initialization, and validation consume the same budget.
Choose a backend duration that fits the remaining time. An expired deadline
prevents backend invocation; an in-progress call gets an abort signal and the
runtime returns an `isError: true` tool result using the response margin.
Aborting the wait does not stop a backend Lambda that is already running.

## Verification limits

Earlier sandbox probes accepted unbound Cognito access tokens with a client-ID
audience configuration. That observation applies to legacy compatibility and
does not describe the strict default. Direct backend checks demonstrated user
scoping but did not exercise the OAuth boundary.

The [earlier review](../../docs/review-mcp-http-api-2026-11-03.md) records checks
before the protocol upgrade. Current protocol and external-auth checks cover
local runtime behavior, mock infrastructure, and packaged Lambda execution.
A complete resource-bound PKCE login with a compliant provider, browser preflight
through AWS, and rotated-token refresh still need live verification after deployment.
