# mcp-http-api

Option B from the design review: a public MCP endpoint built on the **native
API Gateway HTTP API JWT authorizer** and a small MCP server Lambda. No
AgentCore Gateway, no interceptor, no shared HMAC secret.

## What it creates

| Resource | Purpose |
|---|---|
| `aws_cognito_resource_server` | Resource server with configurable identifier and scope (defaults: `mcp`, `read`; token form `mcp/read`) |
| `aws_cognito_user_pool_client` | Dedicated public PKCE client; the only `client_id` the MCP Lambda accepts |
| `aws_apigatewayv2_api` + authorizer + `ANY /mcp` route | Edge JWT check enforcing the fully qualified `required_scope` |
| `aws_lambda_function` (MCP server) | JSON-RPC over Streamable HTTP; invokes the tool backend |
| IAM role | `lambda:InvokeFunction` on `tool_backend_arn` only |

It does **not** create the user pool or the tool backend. Both are inputs.

Requires Terraform 1.9+ and `hashicorp/aws >= 6.0.0, < 7.0.0`, matching the
supporting example. AWS provider v5 is unsupported: the Cognito issuer uses
the `aws_region.region` attribute introduced in v6.

## Request path

1. Client sends `Authorization: Bearer <access token>` from the MCP app client.
2. API Gateway validates signature, issuer, audience (= MCP client id), expiry,
   and that the token carries `required_scope` (`mcp/read` by default). Failures return 401/403 here.
3. The MCP Lambda re-checks `token_use=access`, `client_id`, `required_scope`, and
   `sub` (defence in depth; the Lambda never trusts the route alone).
4. `tools/call` validates arguments against the advertised input schema, then
   invokes the tool backend with `{ tool, arguments, identity: { sub, clientId } }`.
   `identity` comes only from the verified token. Client arguments cannot set it.

## Verified facts (live, eu-west-1)

- The JWT authorizer **requires a non-empty `audience`**; omitting it fails with
  `Audience list must have at least 1 item`.
- With `audience = [client_id]`, a Cognito **access token (no `aud` claim) is
  accepted** by the authorizer. The rejection observed was on scope, not audience.
- A token without `mcp/read` gets `403 insufficient_scope` at the edge; no token gets `401`.

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

## Protocol version

The endpoint supports MCP `2025-06-18` only. Initialization echoes that version
when requested and returns it as the supported alternative for other versions,
including `2025-03-26`. Initialization may omit `MCP-Protocol-Version`; an
explicit invalid or unsupported header still receives HTTP 400.

After initialization, send `MCP-Protocol-Version: 2025-06-18` on every MCP request,
including notifications and GET requests. Header names are case-insensitive.
The stateless server does not retain the negotiated version between requests.
When a later request omits the header, the transport specification's fallback is
`2025-03-26`, which this endpoint does not support, so it returns HTTP 400.
Empty, malformed, ambiguous, and unsupported version headers also return HTTP 400
before tool dispatch. Public OAuth metadata routes do not require this header.

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

Invalid arguments return a tool result with `isError: true` and never invoke the
backend. Validation does not coerce types, insert defaults, or strip extra fields.
Omitted arguments are validated as `{}`; explicit `null` and other non-object
arguments are rejected. Valid arguments reach the backend unchanged, alongside
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

`resource_server_identifier` defaults to `mcp` to preserve existing deployments.
Cognito requires identifiers to be unique within a user pool. Each instance of
this module creates and owns its own resource server, so only one Terraform
resource may own a given pool/identifier pair. Changing `name` or `scope_name`
does not give that resource server a new identifier.

When deploying multiple instances in the same pool, assign distinct identifiers,
such as `mcp-bookings` and `mcp-catalog`. If the sibling `mcp-gateway` module or
another owner already manages `mcp`, use a different identifier for every HTTP
API instance. For example, add this input to the usage configuration above:

```hcl
resource_server_identifier = "mcp-bookings"
```

With the default `scope_name = "read"`, this produces `mcp-bookings/read`. The
app client's allowed scopes, API route, Lambda checks, and OAuth discovery
challenge all use that value. Clients should request the module's `required_scope`
output; `mcp_resource_server_identifier` exposes the identifier itself. The
identifier accepts 1–256 printable ASCII characters except spaces, double quotes,
and backslashes; URL identifiers such as `https://bookings.example.com` are valid.

This module does not reuse an existing resource server. Choose an unused
identifier before the first deployment. Changing it on a deployed instance
replaces the resource server and changes the required scope; clients must request
the new scope and obtain new access tokens.

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

## Limits

- Stateless: no server-initiated messages, no SSE stream (`GET /mcp` returns 405).
- One JSON response per POST; JSON-RPC batches are rejected (removed in protocol 2025-06-18).
- Only tools are exposed. No resources or prompts.
- API Gateway's 29 s integration limit caps tool latency.
- `enable_password_auth_for_tests` must stay `false` outside sandboxes.
