# mcp-http-api

Option B from the design review: a public MCP endpoint built on the **native
API Gateway HTTP API JWT authorizer** and a small MCP server Lambda. No
AgentCore Gateway, no interceptor, no shared HMAC secret.

## What it creates

| Resource | Purpose |
|---|---|
| `aws_cognito_resource_server` | `mcp` resource server with scope `read` (token form `mcp/read`) |
| `aws_cognito_user_pool_client` | Dedicated public PKCE client; the only `client_id` the MCP Lambda accepts |
| `aws_apigatewayv2_api` + authorizer + `ANY /mcp` route | Edge JWT check with `authorization_scopes = ["mcp/read"]` |
| `aws_lambda_function` (MCP server) | JSON-RPC over Streamable HTTP; invokes the tool backend |
| IAM role | `lambda:InvokeFunction` on `tool_backend_arn` only |

It does **not** create the user pool or the tool backend. Both are inputs.

## Request path

1. Client sends `Authorization: Bearer <access token>` from the MCP app client.
2. API Gateway validates signature, issuer, audience (= MCP client id), expiry,
   and that the token carries `mcp/read`. Failures return 401/403 here.
3. The MCP Lambda re-checks `token_use=access`, `client_id`, `mcp/read`, and
   `sub` (defence in depth; the Lambda never trusts the route alone).
4. `tools/call` invokes the tool backend with `{ tool, arguments, identity: { sub, clientId } }`.
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

## Lambda packages

Each instance writes its generated ZIP under
`${path.root}/.terraform/mcp-http-api/<name>-<source-hash>.zip`. The hash covers
`tools.json`, `index.mjs`, and `runtime.mjs`, so different instances and changed
manifests or code keep separate artifacts. The module source directory is only
read during packaging.

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
an intervening manifest change, saved-plan apply, and changes to both JavaScript
files. It requires no AWS credentials and deploys no AWS resources.

## Limits

- Stateless: no server-initiated messages, no SSE stream (`GET /mcp` returns 405).
- One JSON response per POST; JSON-RPC batches are rejected (removed in protocol 2025-06-18).
- Only tools are exposed. No resources or prompts.
- API Gateway's 29 s integration limit caps tool latency.
- `enable_password_auth_for_tests` must stay `false` outside sandboxes.
